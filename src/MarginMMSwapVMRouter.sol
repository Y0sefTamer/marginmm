// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SwapVM} from "@1inch/swap-vm/src/SwapVM.sol";
import {ISwapVM} from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import {Context} from "@1inch/swap-vm/src/libs/VM.sol";
import {MakerTraits} from "@1inch/swap-vm/src/libs/MakerTraits.sol";
import {TakerTraits, TakerTraitsLib} from "@1inch/swap-vm/src/libs/TakerTraits.sol";
import {MarginMMScenarioEngine} from "./MarginMMScenarioEngine.sol";
import {MarginMMPolicy} from "./MarginMMPolicy.sol";
import {MarginMMTradeMath} from "./libraries/MarginMMTradeMath.sol";

/// @notice Aqua/SwapVM execution with a mandatory live scenario-capacity instruction.
/// @dev Output-request mode. Exact pricing/settlement is delegated to official SwapVM.
contract MarginMMSwapVMRouter is SwapVM {
    using TakerTraitsLib for TakerTraits;
    MarginMMScenarioEngine public immutable riskEngine;
    MarginMMPolicy public immutable policy;
    uint256 public constant MAX_SPREAD_BPS = 100;
    uint256 private constant AQUA_TRAITS = 1 << 254;

    struct FillCapacity {
        uint256 qMax;
        uint256 amountIn;
        uint256 amountOut;
        uint256 stressBefore;
        uint256 stressAfter;
        uint256 riskFloor;
        uint256 inputRounding;
    }

    error InvalidConfiguration();
    error UnsupportedStrategy();
    error UnsupportedPair();
    error PolicyDisabled();
    error RiskBoundMismatch();

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

    function buildOrder(address maker, uint256 spreadBps, bytes32 salt) public pure returns (ISwapVM.Order memory) {
        if (maker == address(0) || spreadBps > MAX_SPREAD_BPS) revert UnsupportedStrategy();
        return ISwapVM.Order(
            maker,
            MakerTraits.wrap(AQUA_TRAITS),
            abi.encodePacked(bytes1(0), bytes1(uint8(64)), abi.encode(spreadBps, salt))
        );
    }

    function buildTakerData(uint256 maxInput, uint256 minOutput, uint40 deadline) public pure returns (bytes memory) {
        TakerTraitsLib.Args memory args;
        args.isFirstTransferFromTaker = true;
        args.useTransferFromAndAquaPush = true;
        args.threshold = abi.encode(maxInput);
        args.deadline = deadline;
        args.instructionsArgs = abi.encode(minOutput);
        return TakerTraitsLib.build(args);
    }

    function capacity(ISwapVM.Order calldata order, address tokenIn, address tokenOut, uint256 requestedOut)
        public
        view
        returns (FillCapacity memory c)
    {
        (bool wethIn, uint256 spread) = _strategy(order, tokenIn, tokenOut);
        bytes32 strategy = hash(order);
        c.riskFloor = policy.riskFloor(order.maker, strategy);
        if (c.riskFloor == 0) revert PolicyDisabled();
        MarginMMScenarioEngine.State memory s = riskEngine.snapshot(order.maker);
        c.inputRounding = Math.ceilDiv(wethIn ? s.wethIndex : s.usdcIndex, 1e27) + 1;
        c.stressBefore = riskEngine.stressHF(s);
        c.stressAfter = c.stressBefore;
        if (c.stressBefore < c.riskFloor) return c;
        (, uint256 available) = AQUA.safeBalances(order.maker, address(this), strategy, tokenIn, tokenOut);
        c.qMax = Math.min(available, MarginMMTradeMath.capacity(s, wethIn, spread, c.riskFloor));
        c.amountOut = Math.min(requestedOut, c.qMax);
        if (c.amountOut == 0) return c;
        c.amountIn = MarginMMTradeMath.inputFor(s, wethIn, c.amountOut, spread);
        c.stressAfter = riskEngine.preview(s, wethIn, c.amountIn, c.amountOut);
        if (c.stressAfter < c.riskFloor) revert RiskBoundMismatch();
    }

    function _strategy(ISwapVM.Order calldata order, address tokenIn, address tokenOut)
        private
        view
        returns (bool wethIn, uint256 spread)
    {
        if (
            order.maker == address(0) || MakerTraits.unwrap(order.traits) != AQUA_TRAITS || order.data.length != 66
            || order.data[0] != bytes1(0) || order.data[1] != bytes1(uint8(64))
        ) {
            revert UnsupportedStrategy();
        }
        (spread,) = abi.decode(order.data[2:], (uint256, bytes32));
        if (spread > MAX_SPREAD_BPS) revert UnsupportedStrategy();
        wethIn = tokenIn == riskEngine.aWETH() && tokenOut == riskEngine.aUSDC();
        if (!wethIn && !(tokenIn == riskEngine.aUSDC() && tokenOut == riskEngine.aWETH())) revert UnsupportedPair();
    }

    function _executeCapacityClamp(Context memory ctx, bytes calldata args) internal view {
        (uint256 spread,) = abi.decode(args, (uint256, bytes32));
        MarginMMScenarioEngine.State memory s = riskEngine.snapshot(ctx.query.maker);
        bool wethIn = ctx.query.tokenIn == riskEngine.aWETH();
        uint256 floor = policy.riskFloor(ctx.query.maker, ctx.query.orderHash);
        if (floor == 0) revert PolicyDisabled();
        uint256 cap = MarginMMTradeMath.capacity(s, wethIn, spread, floor);
        if (ctx.swap.amountOut > cap || ctx.swap.amountOut > ctx.swap.balanceOut) revert RiskBoundMismatch();
        ctx.swap.amountIn = MarginMMTradeMath.inputFor(s, wethIn, ctx.swap.amountOut, spread);
        if (riskEngine.preview(s, wethIn, ctx.swap.amountIn, ctx.swap.amountOut) < floor) revert RiskBoundMismatch();
    }

    function _instructions()
        internal
        pure
        override
        returns (function(Context memory, bytes calldata) internal[] memory instructions)
    {
        instructions = new function(Context memory, bytes calldata) internal[](1);
        instructions[0] = _executeCapacityClamp;
    }
}