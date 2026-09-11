// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SwapVM} from "@1inch/swap-vm/src/SwapVM.sol";
import {ISwapVM} from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import {Context, ContextLib} from "@1inch/swap-vm/src/libs/VM.sol";
import {MakerTraits} from "@1inch/swap-vm/src/libs/MakerTraits.sol";
import {TakerTraits, TakerTraitsLib} from "@1inch/swap-vm/src/libs/TakerTraits.sol";
import {Controls} from "@1inch/swap-vm/src/instructions/Controls.sol";
import {XYCSwap} from "@1inch/swap-vm/src/instructions/XYCSwap.sol";
import {XYCConcentrate} from "@1inch/swap-vm/src/instructions/XYCConcentrate.sol";
import {XYCConcentrateArgsBuilder} from "@1inch/swap-vm/src/instructions/XYCConcentrate.sol";
import {MarginMMScenarioEngine} from "./MarginMMScenarioEngine.sol";
import {MarginMMPolicy} from "./MarginMMPolicy.sol";
import {MarginMMTradeMath} from "./libraries/MarginMMTradeMath.sol";

/// @notice Exact-in Aqua/SwapVM execution with a mandatory live MarginMM risk instruction.
/// @dev The pinned XYC helpers are the sole pricing and inverse-rounding implementation.
contract MarginMMSwapVMRouter is SwapVM, Controls, XYCSwap, XYCConcentrate, ReentrancyGuard {
    using ContextLib for Context;
    using TakerTraitsLib for TakerTraits;

    bytes32 public constant PAIR_ID = keccak256("aWETH/aUSDC:USDC-debt:v1");

    // Pinned 1inch/swap-vm commit 32c687c2b73101fc26549e48fa1ff8a4d73afbac.
    uint8 private constant XYC_SWAP_OPCODE = 22;
    uint8 private constant XYC_CONCENTRATE_OPCODE = 23;
    uint8 private constant SALT_OPCODE = 34;
    uint8 private constant MARGIN_RISK_OPCODE = 46;
    uint256 private constant AQUA_TRAITS = 1 << 254;
    uint256 private constant ORDER_DATA_LENGTH = 104;

    MarginMMScenarioEngine public immutable riskEngine;
    MarginMMPolicy public immutable policy;

    struct FillCapacity {
        uint256 requestedAmountIn;
        uint256 actualAmountIn;
        uint256 baseAmountOut;
        uint256 finalAmountOut;
        uint256 qMax;
        uint256 stressBefore;
        uint256 stressAfter;
        uint256 riskFloor;
        uint32 shockBps;
        uint32 policyVersion;
        uint256 policyRevision;
        uint64 validUntil;
        bool partialFill;
        uint8 riskClass;
    }

    error InvalidConfiguration();
    error UnsupportedStrategy();
    error UnsupportedPair();
    error UnsupportedTakerData();
    error PolicyDisabled();
    error StalePolicy(uint32 expectedVersion, uint32 actualVersion, uint256 expectedRevision, uint256 actualRevision);
    error NoCapacity();
    error MinimumOutputNotMet();
    error DeadlineExpired();
    error RiskBoundMismatch();

    event MarginRiskEvaluated(
        bytes32 indexed orderHash,
        address indexed maker,
        uint256 requestedAmountIn,
        uint256 actualAmountIn,
        uint256 baseAmountOut,
        uint256 finalAmountOut,
        uint256 stressHFBefore,
        uint256 stressHFAfter,
        uint256 maxSafeAmountOut,
        uint32 shockBps,
        uint32 policyVersion,
        uint8 riskClass
    );

    constructor(
        address aqua,
        address weth,
        address riskEngine_,
        address policy_,
        address owner,
        string memory name,
        string memory version
    ) SwapVM(aqua, weth, owner, name, version) {
        if (aqua.code.length == 0 || riskEngine_.code.length == 0 || policy_.code.length == 0) {
            revert InvalidConfiguration();
        }
        riskEngine = MarginMMScenarioEngine(riskEngine_);
        policy = MarginMMPolicy(policy_);
        if (weth != riskEngine.WETH()) revert InvalidConfiguration();
    }

    function buildOrder(address maker, uint256 sqrtPriceMin, uint256 sqrtPriceMax, bytes32 salt)
        public
        pure
        returns (ISwapVM.Order memory)
    {
        if (maker == address(0) || sqrtPriceMin == 0 || sqrtPriceMin >= sqrtPriceMax) {
            revert UnsupportedStrategy();
        }
        bytes memory program = abi.encodePacked(
            bytes1(SALT_OPCODE),
            bytes1(uint8(32)),
            salt,
            bytes1(XYC_CONCENTRATE_OPCODE),
            bytes1(uint8(64)),
            sqrtPriceMin,
            sqrtPriceMax,
            bytes1(XYC_SWAP_OPCODE),
            bytes1(uint8(0)),
            bytes1(MARGIN_RISK_OPCODE),
            bytes1(uint8(0))
        );
        return ISwapVM.Order(maker, MakerTraits.wrap(AQUA_TRAITS), program);
    }

    function buildTakerData(uint256 minAmountOut, uint40 deadline, uint32 policyVersion, uint256 policyRevision)
        public
        pure
        returns (bytes memory)
    {
        TakerTraitsLib.Args memory args;
        args.isExactIn = true;
        args.isFirstTransferFromTaker = true;
        args.useTransferFromAndAquaPush = true;
        args.threshold = abi.encode(minAmountOut);
        args.deadline = deadline;
        args.instructionsArgs = abi.encode(policyVersion, policyRevision);
        return TakerTraitsLib.build(args);
    }

    function capacity(ISwapVM.Order calldata order, address tokenIn, address tokenOut, uint256 maxAmountIn)
        public
        view
        returns (FillCapacity memory c)
    {
        (bool wethIn, uint256 sqrtPriceMin, uint256 sqrtPriceMax) = _strategy(order, tokenIn, tokenOut);
        bytes32 strategy = hash(order);
        (MarginMMPolicy.MarketPolicy memory marketPolicy, MarginMMPolicy.MakerSettings memory settings) =
            policy.activePolicy(order.maker, strategy);
        if (settings.pairId != PAIR_ID) revert UnsupportedPair();

        MarginMMScenarioEngine.State memory state = riskEngine.snapshot(order.maker);
        (uint256 availableIn, uint256 availableOut) =
            AQUA.safeBalances(order.maker, address(this), strategy, tokenIn, tokenOut);
        (uint256 virtualBalanceIn, uint256 virtualBalanceOut) = XYCConcentrateArgsBuilder.virtualBalances(
            availableIn, availableOut, tokenIn < tokenOut, sqrtPriceMin, sqrtPriceMax
        );
        MarginMMTradeMath.Result memory result = MarginMMTradeMath.solve(
            riskEngine,
            state,
            wethIn,
            maxAmountIn,
            virtualBalanceIn,
            virtualBalanceOut,
            availableOut,
            settings.hardFloorStressHF,
            marketPolicy.shockBps
        );

        c.requestedAmountIn = maxAmountIn;
        c.actualAmountIn = result.actualAmountIn;
        c.baseAmountOut = result.baseAmountOut;
        c.finalAmountOut = result.qMax;
        c.qMax = result.qMax;
        c.stressBefore = result.stressHFBefore;
        c.stressAfter = result.stressHFAfter;
        c.riskFloor = settings.hardFloorStressHF;
        c.shockBps = marketPolicy.shockBps;
        c.policyVersion = settings.policyVersion;
        c.policyRevision = settings.revision;
        c.validUntil = marketPolicy.validUntil;
        c.partialFill = result.qMax < result.baseAmountOut;
        c.riskClass = result.riskCapped ? 1 : result.liquidityCapped ? 2 : 0;
    }

    function quote(
        ISwapVM.Order calldata order,
        address tokenIn,
        address tokenOut,
        uint256 maxAmountIn,
        bytes calldata takerTraitsAndData
    ) public override returns (uint256 amountIn, uint256 amountOut, bytes32 orderHash) {
        FillCapacity memory c = capacity(order, tokenIn, tokenOut, maxAmountIn);
        _checkTakerData(takerTraitsAndData, c);
        (amountIn, amountOut, orderHash) = super.quote(order, tokenIn, tokenOut, maxAmountIn, takerTraitsAndData);
        if (amountIn != c.actualAmountIn || amountOut != c.finalAmountOut) revert RiskBoundMismatch();
    }

    function swap(
        ISwapVM.Order calldata order,
        address tokenIn,
        address tokenOut,
        uint256 maxAmountIn,
        bytes calldata takerTraitsAndData
    ) public override nonReentrant returns (uint256 amountIn, uint256 amountOut, bytes32 orderHash) {
        if (msg.sender == order.maker) revert UnsupportedTakerData();
        FillCapacity memory c = capacity(order, tokenIn, tokenOut, maxAmountIn);
        _checkTakerData(takerTraitsAndData, c);
        (amountIn, amountOut, orderHash) = super.swap(order, tokenIn, tokenOut, maxAmountIn, takerTraitsAndData);
        if (amountIn != c.actualAmountIn || amountOut != c.finalAmountOut) revert RiskBoundMismatch();

        (MarginMMPolicy.MarketPolicy memory marketPolicy, MarginMMPolicy.MakerSettings memory settings) =
            policy.activePolicy(order.maker, orderHash);
        if (settings.policyVersion != c.policyVersion || settings.revision != c.policyRevision) {
            revert StalePolicy(c.policyVersion, settings.policyVersion, c.policyRevision, settings.revision);
        }
        MarginMMScenarioEngine.State memory afterState = riskEngine.snapshot(order.maker);
        uint256 afterStress = riskEngine.stressHF(afterState, marketPolicy.shockBps);
        if (afterState.aaveHF <= 1e18 || afterStress < settings.hardFloorStressHF) revert RiskBoundMismatch();

        emit MarginRiskEvaluated(
            orderHash,
            order.maker,
            maxAmountIn,
            amountIn,
            c.baseAmountOut,
            amountOut,
            c.stressBefore,
            afterStress,
            c.qMax,
            marketPolicy.shockBps,
            settings.policyVersion,
            c.riskClass
        );
    }

    function _checkTakerData(bytes calldata packed, FillCapacity memory c) private view {
        if (c.finalAmountOut == 0 || c.actualAmountIn == 0) revert NoCapacity();
        (TakerTraits traits, bytes calldata data) = TakerTraitsLib.parse(packed);
        (bool hasThreshold, uint256 minAmountOut) = traits.threshold(data);
        bytes calldata instructionArgs = traits.instructionsArgs(data);
        if (!traits.isExactIn() || !hasThreshold || minAmountOut == 0 || instructionArgs.length != 64) {
            revert UnsupportedTakerData();
        }
        (uint32 expectedVersion, uint256 expectedRevision) = abi.decode(instructionArgs, (uint32, uint256));
        uint40 deadline = traits.deadline(data);
        if (
            deadline == 0
                || keccak256(packed)
                    != keccak256(buildTakerData(minAmountOut, deadline, expectedVersion, expectedRevision))
        ) revert UnsupportedTakerData();
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (expectedVersion != c.policyVersion || expectedRevision != c.policyRevision) {
            revert StalePolicy(expectedVersion, c.policyVersion, expectedRevision, c.policyRevision);
        }
        if (c.actualAmountIn > c.requestedAmountIn) revert RiskBoundMismatch();
        if (c.finalAmountOut < minAmountOut) revert MinimumOutputNotMet();
    }

    function _strategy(ISwapVM.Order calldata order, address tokenIn, address tokenOut)
        private
        view
        returns (bool wethIn, uint256 sqrtPriceMin, uint256 sqrtPriceMax)
    {
        if (
            order.maker == address(0) || MakerTraits.unwrap(order.traits) != AQUA_TRAITS
                || order.data.length != ORDER_DATA_LENGTH || order.data[0] != bytes1(SALT_OPCODE)
                || order.data[1] != bytes1(uint8(32)) || order.data[34] != bytes1(XYC_CONCENTRATE_OPCODE)
                || order.data[35] != bytes1(uint8(64)) || order.data[100] != bytes1(XYC_SWAP_OPCODE)
                || order.data[101] != bytes1(uint8(0)) || order.data[102] != bytes1(MARGIN_RISK_OPCODE)
                || order.data[103] != bytes1(uint8(0))
        ) revert UnsupportedStrategy();
        sqrtPriceMin = uint256(bytes32(order.data[36:68]));
        sqrtPriceMax = uint256(bytes32(order.data[68:100]));
        if (sqrtPriceMin == 0 || sqrtPriceMin >= sqrtPriceMax) revert UnsupportedStrategy();

        wethIn = tokenIn == riskEngine.aWETH() && tokenOut == riskEngine.aUSDC();
        if (!wethIn && !(tokenIn == riskEngine.aUSDC() && tokenOut == riskEngine.aWETH())) {
            revert UnsupportedPair();
        }
    }

    function _executeMarginRisk(Context memory ctx, bytes calldata args) internal view {
        if (args.length != 0) revert UnsupportedStrategy();
        bytes calldata takerArgs = ctx.takerArgs();
        if (takerArgs.length != 64) revert UnsupportedTakerData();
        (uint32 expectedVersion, uint256 expectedRevision) = abi.decode(takerArgs, (uint32, uint256));
        (MarginMMPolicy.MarketPolicy memory marketPolicy, MarginMMPolicy.MakerSettings memory settings) =
            policy.activePolicy(ctx.query.maker, ctx.query.orderHash);
        if (settings.pairId != PAIR_ID) revert UnsupportedPair();
        if (expectedVersion != settings.policyVersion || expectedRevision != settings.revision) {
            revert StalePolicy(expectedVersion, settings.policyVersion, expectedRevision, settings.revision);
        }

        MarginMMScenarioEngine.State memory state = riskEngine.snapshot(ctx.query.maker);
        (, uint256 availableOut) = AQUA.safeBalances(
            ctx.query.maker, address(this), ctx.query.orderHash, ctx.query.tokenIn, ctx.query.tokenOut
        );
        uint256 baseAmountOut = ctx.swap.amountOut;
        MarginMMTradeMath.Result memory result = MarginMMTradeMath.solve(
            riskEngine,
            state,
            ctx.query.tokenIn == riskEngine.aWETH(),
            ctx.swap.amountIn,
            ctx.swap.balanceIn,
            ctx.swap.balanceOut,
            availableOut,
            settings.hardFloorStressHF,
            marketPolicy.shockBps
        );
        if (result.baseAmountOut != baseAmountOut) revert RiskBoundMismatch();
        ctx.swap.amountIn = result.actualAmountIn;
        ctx.swap.amountOut = result.qMax;
    }

    function _validateTakerTraits(
        TakerTraits takerTraits,
        bytes calldata takerData,
        uint256 maxAmountIn,
        uint256 amountIn,
        uint256 amountOut
    ) internal view override {
        if (!takerTraits.isExactIn() || amountIn == 0 || amountIn > maxAmountIn || amountOut == 0) {
            revert UnsupportedTakerData();
        }
        uint40 deadline = takerTraits.deadline(takerData);
        if (deadline == 0) revert UnsupportedTakerData();
        if (block.timestamp > deadline) revert DeadlineExpired();
        (bool hasThreshold, uint256 minAmountOut) = takerTraits.threshold(takerData);
        if (!hasThreshold || minAmountOut == 0) revert UnsupportedTakerData();
        if (amountOut < minAmountOut) revert MinimumOutputNotMet();
        bytes calldata instructionArgs = takerTraits.instructionsArgs(takerData);
        if (instructionArgs.length != 64) revert UnsupportedTakerData();
        (uint32 expectedVersion, uint256 expectedRevision) = abi.decode(instructionArgs, (uint32, uint256));
        if (
            keccak256(abi.encodePacked(uint176(TakerTraits.unwrap(takerTraits)), takerData))
                != keccak256(buildTakerData(minAmountOut, deadline, expectedVersion, expectedRevision))
        ) revert UnsupportedTakerData();
    }

    function _instructions()
        internal
        pure
        override
        returns (function(Context memory, bytes calldata) internal[] memory instructions)
    {
        // Preserve the pinned SwapVM opcode numbers while linking only the four
        // instructions accepted by MarginMM's canonical strategy.
        instructions = new function(Context memory, bytes calldata) internal[](MARGIN_RISK_OPCODE + 1);
        for (uint256 i; i < instructions.length; ++i) {
            instructions[i] = _unsupportedInstruction;
        }
        instructions[SALT_OPCODE] = Controls._salt;
        instructions[XYC_CONCENTRATE_OPCODE] = XYCConcentrate._xycConcentrateGrowLiquidity2D;
        instructions[XYC_SWAP_OPCODE] = XYCSwap._xycSwapXD;
        instructions[MARGIN_RISK_OPCODE] = _executeMarginRisk;
    }

    function _unsupportedInstruction(Context memory, bytes calldata) internal pure {
        revert UnsupportedStrategy();
    }
}
