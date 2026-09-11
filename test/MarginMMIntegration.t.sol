// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Aqua} from "@1inch/aqua/src/Aqua.sol";
import {ISwapVM} from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import {TakerTraitsLib} from "@1inch/swap-vm/src/libs/TakerTraits.sol";
import {MakerTraits} from "@1inch/swap-vm/src/libs/MakerTraits.sol";
import {XYCSwapMath} from "@1inch/swap-vm/src/libs/XYCSwapMath.sol";
import {XYCConcentrateArgsBuilder} from "@1inch/swap-vm/src/instructions/XYCConcentrate.sol";
import {MarginMMPolicy} from "../src/MarginMMPolicy.sol";
import {MarginMMScenarioEngine} from "../src/MarginMMScenarioEngine.sol";
import {MarginMMSwapVMRouter} from "../src/MarginMMSwapVMRouter.sol";
import {MarginMMTradeMath} from "../src/libraries/MarginMMTradeMath.sol";

interface IMarginPool {
    function supply(address, uint256, address, uint16) external;
    function borrow(address, uint256, uint256, uint16, address) external;
    function setUserUseReserveAsCollateral(address, bool) external;
}

interface IMarginWETH is IERC20 {
    function deposit() external payable;
}

contract MarginMMIntegrationTest is Test {
    address private constant POOL = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2;
    address private constant DATA = 0x0a16f2FCC0D44FaE41cc54e079281D84A363bECD;
    address private constant ORACLE = 0x54586bE62E3c3580375aE3723C145253060Ca0C2;
    address private constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address private constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    uint256 private constant FORK_BLOCK = 25_913_344;
    uint256 private constant CALIBRATOR_KEY = 0xCA11B;
    bytes32 private constant PAIR_ID = keccak256("aWETH/aUSDC:USDC-debt:v1");
    bytes32 private constant RISK_EVENT_SIGNATURE = keccak256(
        "MarginRiskEvaluated(bytes32,address,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint32,uint32,uint8)"
    );

    address private maker = makeAddr("maker");
    address private taker = makeAddr("taker");
    address private receiver = makeAddr("receiver");
    Aqua private aqua;
    MarginMMScenarioEngine private engine;
    MarginMMPolicy private policy;
    MarginMMSwapVMRouter private router;
    ISwapVM.Order private order;
    bytes32 private strategy;
    address private aWETH;
    address private aUSDC;
    uint256 private sqrtPriceMin;
    uint256 private sqrtPriceMax;

    function setUp() public {
        vm.createSelectFork(vm.envString("ETH_RPC_URL"), FORK_BLOCK);
        aqua = new Aqua();
        engine = new MarginMMScenarioEngine(POOL, DATA, ORACLE);
        policy = new MarginMMPolicy(address(this), vm.addr(CALIBRATOR_KEY));
        router = new MarginMMSwapVMRouter(
            address(aqua), WETH, address(engine), address(policy), address(this), "MarginMM", "1"
        );
        assertEq(router.PAIR_ID(), PAIR_ID);
        aWETH = engine.aWETH();
        aUSDC = engine.aUSDC();
        _supply(maker, 10 ether, 50_000e6);
        vm.prank(maker);
        IMarginPool(POOL).borrow(USDC, 46_000e6, 2, 0, maker);
        _supply(taker, 100 ether, 200_000e6);

        // Test fixture only. Production/demo bounds remain explicit maker strategy inputs.
        sqrtPriceMin = Math.sqrt(1_500e6 * 1e18);
        sqrtPriceMax = Math.sqrt(6_000e6 * 1e18);
        order = router.buildOrder(maker, sqrtPriceMin, sqrtPriceMax, keccak256("integration-strategy"));
        strategy = router.hash(order);
        assertEq(strategy, keccak256(abi.encode(order)));

        address[] memory tokens = new address[](2);
        tokens[0] = aWETH;
        tokens[1] = aUSDC;
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = IERC20(aWETH).balanceOf(maker);
        amounts[1] = IERC20(aUSDC).balanceOf(maker);
        vm.startPrank(maker);
        IERC20(aWETH).approve(address(aqua), type(uint256).max);
        IERC20(aUSDC).approve(address(aqua), type(uint256).max);
        assertEq(aqua.ship(address(router), abi.encode(order), tokens, amounts), strategy);
        vm.stopPrank();
        _approvePolicy(1.1e18, 1, 1_240);

        vm.startPrank(taker);
        IERC20(aWETH).approve(address(router), type(uint256).max);
        IERC20(aUSDC).approve(address(router), type(uint256).max);
        vm.stopPrank();
    }

    function testFork_ExactInFullFillUsesRequestedInputAndXYCOutput() public {
        uint256 maxAmountIn = 0.01 ether;
        MarginMMSwapVMRouter.FillCapacity memory c = router.capacity(order, aWETH, aUSDC, maxAmountIn);
        assertEq(c.actualAmountIn, maxAmountIn);
        assertEq(c.finalAmountOut, c.baseAmountOut);
        assertFalse(c.partialFill);
        assertEq(c.riskClass, 0);

        bytes memory data = _data(c, c.finalAmountOut);
        vm.prank(taker);
        (uint256 quoteIn, uint256 quoteOut,) = router.quote(order, aWETH, aUSDC, maxAmountIn, data);
        assertEq(quoteIn, c.actualAmountIn);
        assertEq(quoteOut, c.finalAmountOut);

        vm.prank(taker);
        (uint256 filledIn, uint256 filledOut,) = router.swap(order, aWETH, aUSDC, maxAmountIn, data);
        assertEq(filledIn, maxAmountIn);
        assertEq(filledOut, quoteOut);
        _assertPositionSafe(c.shockBps, c.riskFloor);
    }

    function testFork_RiskCappedPartialFillUsesExactOutInverse() public {
        vm.prank(maker);
        policy.setMakerSettings(strategy, PAIR_ID, 1.23e18, 1);
        uint256 maxAmountIn = 20 ether;
        MarginMMSwapVMRouter.FillCapacity memory c = router.capacity(order, aWETH, aUSDC, maxAmountIn);
        assertTrue(c.partialFill);
        assertEq(c.riskClass, 1);
        assertLt(c.actualAmountIn, maxAmountIn);
        assertLt(c.finalAmountOut, c.baseAmountOut);
        assertGe(c.stressAfter, c.riskFloor);

        (uint256 virtualIn, uint256 virtualOut) = _virtualBalances(aWETH, aUSDC);
        assertEq(c.actualAmountIn, XYCSwapMath.exactOut(virtualIn, virtualOut, c.finalAmountOut));

        bytes memory data = _data(c, c.finalAmountOut);
        vm.prank(taker);
        (uint256 amountIn, uint256 amountOut,) = router.swap(order, aWETH, aUSDC, maxAmountIn, data);
        assertEq(amountIn, c.actualAmountIn);
        assertEq(amountOut, c.finalAmountOut);
        _assertPositionSafe(c.shockBps, c.riskFloor);
    }

    function testFork_QMaxPlusOneAtomicUnitIsUnsafeAtSameState() public {
        vm.prank(maker);
        policy.setMakerSettings(strategy, PAIR_ID, 1.23e18, 1);
        uint256 maxAmountIn = 20 ether;
        MarginMMSwapVMRouter.FillCapacity memory c = router.capacity(order, aWETH, aUSDC, maxAmountIn);
        assertEq(c.riskClass, 1);
        (uint256 virtualIn, uint256 virtualOut) = _virtualBalances(aWETH, aUSDC);
        uint256 above = c.qMax + 1;
        uint256 aboveInput = XYCSwapMath.exactOut(virtualIn, virtualOut, above);
        MarginMMScenarioEngine.State memory state = engine.snapshot(maker);
        assertLt(engine.preview(state, true, aboveInput, above, c.shockBps), c.riskFloor);
    }

    function testFork_AaveTransferOrderingSameAmountsRequiresInputFirst() public {
        uint256 amountOut = 45_000e6;
        (uint256 virtualIn, uint256 virtualOut) = _virtualBalances(aWETH, aUSDC);
        uint256 amountIn = XYCSwapMath.exactOut(virtualIn, virtualOut, amountOut);
        uint256 initialState = vm.snapshotState();

        // The maker cannot remove this collateral before receiving the matching
        // aWETH: Aave validates the intermediate account state and reverts.
        vm.prank(maker);
        vm.expectRevert();
        IERC20(aUSDC).transfer(taker, amountOut);
        assertTrue(vm.revertToState(initialState));

        // With the exact same amounts, taker-input-first makes the intermediate
        // and final Aave states valid. This is the router's canonical ordering.
        vm.prank(taker);
        assertTrue(IERC20(aWETH).transfer(maker, amountIn));
        vm.prank(maker);
        assertTrue(IERC20(aUSDC).transfer(taker, amountOut));
        MarginMMScenarioEngine.State memory afterState = engine.snapshot(maker);
        assertGt(afterState.aaveHF, 1e18);
        assertGe(engine.stressHF(afterState, 1_240), 1.1e18);
    }

    function testFuzzFork_SplitFillsCannotBypassHardFloor(uint96 totalSeed, uint16 splitSeed) public {
        vm.prank(maker);
        policy.setMakerSettings(strategy, PAIR_ID, 1.23e18, 1);

        uint256 totalRequestedIn = bound(uint256(totalSeed), 0.01 ether, 30 ether);
        uint256 splitBps = bound(uint256(splitSeed), 1, 9_999);
        uint256 firstRequestedIn = Math.mulDiv(totalRequestedIn, splitBps, 10_000);
        uint256 secondRequestedIn = totalRequestedIn - firstRequestedIn;

        _executeIfCapacity(firstRequestedIn, 1.23e18);
        _executeIfCapacity(secondRequestedIn, 1.23e18);
        _assertPositionSafe(1_240, 1.23e18);
    }

    function testFork_PolicyRevisionRaceRejectsBeforeTransfers() public {
        uint256 maxAmountIn = 1 ether;
        MarginMMSwapVMRouter.FillCapacity memory quoted = router.capacity(order, aWETH, aUSDC, maxAmountIn);
        bytes memory data = _data(quoted, 1);
        uint256 beforeIn = IERC20(aWETH).balanceOf(taker);
        uint256 beforeOut = IERC20(aUSDC).balanceOf(taker);

        vm.prank(maker);
        policy.setMakerSettings(strategy, PAIR_ID, 1.12e18, 1);
        vm.prank(taker);
        vm.expectRevert(
            abi.encodeWithSelector(
                MarginMMSwapVMRouter.StalePolicy.selector,
                quoted.policyVersion,
                quoted.policyVersion,
                quoted.policyRevision,
                quoted.policyRevision + 1
            )
        );
        router.swap(order, aWETH, aUSDC, maxAmountIn, data);
        assertEq(IERC20(aWETH).balanceOf(taker), beforeIn);
        assertEq(IERC20(aUSDC).balanceOf(taker), beforeOut);
    }

    function testFork_ExpiredPolicyRejectsAllMarginFills() public {
        MarginMMSwapVMRouter.FillCapacity memory c = router.capacity(order, aWETH, aUSDC, 1 ether);
        bytes memory data = _data(c, 1);
        vm.warp(c.validUntil + 1);
        vm.expectRevert(abi.encodeWithSelector(MarginMMPolicy.PolicyExpired.selector, c.validUntil));
        router.quote(order, aWETH, aUSDC, 1 ether, data);
        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(MarginMMPolicy.PolicyExpired.selector, c.validUntil));
        router.swap(order, aWETH, aUSDC, 1 ether, data);
    }

    function testFork_ChangedAaveStateRejectsStaleFillBeforeTransfers() public {
        uint256 maxAmountIn = 5 ether;
        MarginMMSwapVMRouter.FillCapacity memory quoted = router.capacity(order, aWETH, aUSDC, maxAmountIn);
        bytes memory data = _data(quoted, quoted.finalAmountOut);
        vm.prank(maker);
        assertTrue(IERC20(aUSDC).transfer(receiver, 8_500e6));
        assertGt(engine.snapshot(maker).aaveHF, 1e18);

        uint256 beforeIn = IERC20(aWETH).balanceOf(taker);
        uint256 beforeOut = IERC20(aUSDC).balanceOf(taker);
        vm.prank(taker);
        vm.expectRevert(MarginMMSwapVMRouter.NoCapacity.selector);
        router.swap(order, aWETH, aUSDC, maxAmountIn, data);
        assertEq(IERC20(aWETH).balanceOf(taker), beforeIn);
        assertEq(IERC20(aUSDC).balanceOf(taker), beforeOut);
    }

    function testFork_SettlementAndRiskEventExposeFinalExecutionEvidence() public {
        uint256 maxAmountIn = 0.25 ether;
        MarginMMSwapVMRouter.FillCapacity memory c = router.capacity(order, aWETH, aUSDC, maxAmountIn);
        bytes memory data = _data(c, c.finalAmountOut);
        (uint256 aquaInBefore, uint256 aquaOutBefore) =
            aqua.safeBalances(maker, address(router), strategy, aWETH, aUSDC);
        uint256 takerInBefore = IERC20(aWETH).balanceOf(taker);
        uint256 takerOutBefore = IERC20(aUSDC).balanceOf(taker);

        vm.recordLogs();
        vm.prank(taker);
        (uint256 amountIn, uint256 amountOut, bytes32 orderHash) = router.swap(order, aWETH, aUSDC, maxAmountIn, data);

        // Aave stores scaled balances, so the displayed aToken delta can differ
        // from the nominal transfer by one atomic unit after index conversion.
        assertApproxEqAbs(takerInBefore - IERC20(aWETH).balanceOf(taker), amountIn, 1);
        assertApproxEqAbs(IERC20(aUSDC).balanceOf(taker) - takerOutBefore, amountOut, 1);
        (uint256 aquaInAfter, uint256 aquaOutAfter) = aqua.safeBalances(maker, address(router), strategy, aWETH, aUSDC);
        assertEq(aquaInAfter, aquaInBefore + amountIn);
        assertEq(aquaOutAfter, aquaOutBefore - amountOut);

        Vm.Log[] memory entries = vm.getRecordedLogs();
        uint256 matches;
        for (uint256 i; i < entries.length; ++i) {
            if (entries[i].emitter != address(router) || entries[i].topics[0] != RISK_EVENT_SIGNATURE) continue;
            ++matches;
            assertEq(entries[i].topics[1], orderHash);
            assertEq(entries[i].topics[2], bytes32(uint256(uint160(maker))));
            (
                uint256 requestedAmountIn,
                uint256 actualAmountIn,
                uint256 baseAmountOut,
                uint256 finalAmountOut,
                uint256 stressBefore,
                uint256 stressAfter,
                uint256 maxSafeAmountOut,
                uint32 shockBps,
                uint32 policyVersion,
                uint8 riskClass
            ) = abi.decode(
                entries[i].data, (uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint32, uint32, uint8)
            );
            assertEq(requestedAmountIn, maxAmountIn);
            assertEq(actualAmountIn, amountIn);
            assertEq(baseAmountOut, c.baseAmountOut);
            assertEq(finalAmountOut, amountOut);
            assertEq(stressBefore, c.stressBefore);
            assertEq(maxSafeAmountOut, c.qMax);
            assertEq(shockBps, c.shockBps);
            assertEq(policyVersion, c.policyVersion);
            assertEq(riskClass, c.riskClass);
            assertEq(stressAfter, engine.stressHF(engine.snapshot(maker), c.shockBps));
        }
        assertEq(matches, 1);
    }

    function testFork_MinOutputDeadlineAndCanonicalTakerDataAreEnforced() public {
        MarginMMSwapVMRouter.FillCapacity memory c = router.capacity(order, aWETH, aUSDC, 1 ether);
        bytes memory excessiveMin = _data(c, c.finalAmountOut + 1);
        vm.prank(taker);
        vm.expectRevert(MarginMMSwapVMRouter.MinimumOutputNotMet.selector);
        router.quote(order, aWETH, aUSDC, 1 ether, excessiveMin);

        bytes memory expired = router.buildTakerData(1, uint40(block.timestamp + 1), c.policyVersion, c.policyRevision);
        vm.warp(block.timestamp + 2);
        vm.prank(taker);
        vm.expectRevert(MarginMMSwapVMRouter.DeadlineExpired.selector);
        router.quote(order, aWETH, aUSDC, 1 ether, expired);

        TakerTraitsLib.Args memory args;
        args.isExactIn = true;
        args.isFirstTransferFromTaker = false;
        args.useTransferFromAndAquaPush = true;
        args.threshold = abi.encode(uint256(1));
        args.deadline = uint40(block.timestamp + 1 hours);
        args.instructionsArgs = abi.encode(c.policyVersion, c.policyRevision);
        vm.prank(taker);
        vm.expectRevert(MarginMMSwapVMRouter.UnsupportedTakerData.selector);
        router.quote(order, aWETH, aUSDC, 1 ether, TakerTraitsLib.build(args));
    }

    function testFork_ReverseDirectionExactInUsesSameCurveAndStaysSafe() public {
        uint256 maxAmountIn = 1_000e6;
        MarginMMSwapVMRouter.FillCapacity memory c = router.capacity(order, aUSDC, aWETH, maxAmountIn);
        assertEq(c.actualAmountIn, maxAmountIn);
        assertEq(c.finalAmountOut, c.baseAmountOut);
        bytes memory data = _data(c, c.finalAmountOut);
        vm.prank(taker);
        (uint256 amountIn, uint256 amountOut,) = router.swap(order, aUSDC, aWETH, maxAmountIn, data);
        assertEq(amountIn, maxAmountIn);
        assertEq(amountOut, c.finalAmountOut);
        _assertPositionSafe(c.shockBps, c.riskFloor);
    }

    function testFork_EconomicSensitivityGridUsesPinnedCurveAndCurrentAaveConfig() public {
        MarginMMScenarioEngine.State memory baseState = engine.snapshot(maker);
        (uint256 baseVirtualIn, uint256 baseVirtualOut) = _virtualBalances(aWETH, aUSDC);
        (, uint256 baseAvailableOut) = aqua.safeBalances(maker, address(router), strategy, aWETH, aUSDC);
        uint256 baseCollateralValue = _collateralBase(baseState);
        uint256[3] memory makerUsd = [uint256(100_000), 1_000_000, 10_000_000];
        uint256[4] memory tradeUsd = [uint256(1_000), 10_000, 100_000, 500_000];

        emit log_string("ECON_GRID,maker_collateral_usd,requested_usd,qmax_usdc_atomic,fill_bps,solver_gas_ex_snapshot,solver_gas_bps_x100_at_1gwei,stress_before_wad,stress_after_wad,risk_class");
        for (uint256 i; i < makerUsd.length; ++i) {
            uint256 targetValue = makerUsd[i] * 1e8;
            MarginMMScenarioEngine.State memory scaled = _scaleState(baseState, targetValue, baseCollateralValue);
            uint256 makerCollateralUsd = _collateralUsd(scaled);
            for (uint256 j; j < tradeUsd.length; ++j) {
                uint256 requestedWeth = Math.mulDiv(tradeUsd[j] * scaled.usdcPrice, 1e18, scaled.wethPrice);
                uint256 gasBefore = gasleft();
                MarginMMTradeMath.Result memory result = MarginMMTradeMath.solve(
                    engine,
                    scaled,
                    true,
                    requestedWeth,
                    Math.mulDiv(baseVirtualIn, targetValue, baseCollateralValue),
                    Math.mulDiv(baseVirtualOut, targetValue, baseCollateralValue),
                    Math.mulDiv(baseAvailableOut, targetValue, baseCollateralValue),
                    1.2e18,
                    1_240
                );
                uint256 riskGas = gasBefore - gasleft();
                uint256 fillBps = result.baseAmountOut == 0 ? 0 : Math.mulDiv(result.qMax, 10_000, result.baseAmountOut);
                uint256 gasCostBase = Math.mulDiv(riskGas * 1 gwei, scaled.wethPrice, 1e18);
                uint256 gasBpsX100 = Math.mulDiv(gasCostBase, 1_000_000, tradeUsd[j] * scaled.usdcPrice);
                uint256 riskClass = result.riskCapped ? 1 : result.liquidityCapped ? 2 : 0;

                assertLe(result.actualAmountIn, requestedWeth);
                assertLe(result.qMax, result.baseAmountOut);
                if (result.qMax != 0) assertGe(result.stressHFAfter, 1.2e18);
                emit log_string(string.concat(
                        "ECON_GRID,",
                        vm.toString(makerCollateralUsd),
                        ",",
                        vm.toString(tradeUsd[j]),
                        ",",
                        vm.toString(result.qMax),
                        ",",
                        vm.toString(fillBps),
                        ",",
                        vm.toString(riskGas),
                        ",",
                        vm.toString(gasBpsX100),
                        ",",
                        vm.toString(result.stressHFBefore),
                        ",",
                        vm.toString(result.stressHFAfter),
                        ",",
                        vm.toString(riskClass)
                    ));
            }
        }
    }

    function testFork_DisabledPolicyAndNonCanonicalStrategyFailClosed() public {
        ISwapVM.Order memory bad = order;
        bad.traits = MakerTraits.wrap(MakerTraits.unwrap(order.traits) | (1 << 252));
        vm.expectRevert(MarginMMSwapVMRouter.UnsupportedStrategy.selector);
        router.capacity(bad, aWETH, aUSDC, 1 ether);

        vm.prank(maker);
        policy.disableStrategy(strategy);
        vm.expectRevert(MarginMMSwapVMRouter.PolicyDisabled.selector);
        router.capacity(order, aWETH, aUSDC, 1 ether);
        vm.expectRevert(MarginMMSwapVMRouter.UnsupportedPair.selector);
        router.capacity(order, aWETH, USDC, 1 ether);
    }

    function _data(MarginMMSwapVMRouter.FillCapacity memory c, uint256 minAmountOut)
        private
        view
        returns (bytes memory)
    {
        return router.buildTakerData(minAmountOut, uint40(block.timestamp + 1 hours), c.policyVersion, c.policyRevision);
    }

    function _virtualBalances(address tokenIn, address tokenOut)
        private
        view
        returns (uint256 virtualIn, uint256 virtualOut)
    {
        (uint256 availableIn, uint256 availableOut) =
            aqua.safeBalances(maker, address(router), strategy, tokenIn, tokenOut);
        return XYCConcentrateArgsBuilder.virtualBalances(
            availableIn, availableOut, tokenIn < tokenOut, sqrtPriceMin, sqrtPriceMax
        );
    }

    function _approvePolicy(uint256 floor, uint32 version, uint32 shockBps) private {
        MarginMMPolicy.MarketPolicy memory artifact = MarginMMPolicy.MarketPolicy({
            chainId: block.chainid,
            policyRegistry: address(policy),
            pairId: PAIR_ID,
            shockBps: shockBps,
            marketRegime: 1,
            policyVersion: version,
            modelVersion: policy.SUPPORTED_MODEL_VERSION(),
            issuedAt: uint64(block.timestamp),
            validUntil: uint64(block.timestamp + 6 hours),
            evidenceBlockFrom: uint64(block.number),
            evidenceBlockTo: uint64(block.number),
            evidenceHash: keccak256(abi.encode("integration-evidence", version))
        });
        bytes32 digest = policy.hashMarketPolicy(artifact);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(CALIBRATOR_KEY, digest);
        vm.prank(maker);
        policy.approveMarketPolicy(strategy, floor, artifact, abi.encodePacked(r, s, v));
    }

    function _assertPositionSafe(uint32 shockBps, uint256 floor) private view {
        MarginMMScenarioEngine.State memory state = engine.snapshot(maker);
        assertGt(state.aaveHF, 1e18);
        assertGe(engine.stressHF(state, shockBps), floor);
    }

    function _scaleState(
        MarginMMScenarioEngine.State memory state,
        uint256 targetCollateralValue,
        uint256 sourceCollateralValue
    ) private pure returns (MarginMMScenarioEngine.State memory) {
        return MarginMMScenarioEngine.State({
            wethAmount: Math.mulDiv(state.wethAmount, targetCollateralValue, sourceCollateralValue),
            usdcAmount: Math.mulDiv(state.usdcAmount, targetCollateralValue, sourceCollateralValue),
            usdcDebt: Math.mulDiv(state.usdcDebt, targetCollateralValue, sourceCollateralValue),
            wethLT: state.wethLT,
            usdcLT: state.usdcLT,
            wethPrice: state.wethPrice,
            usdcPrice: state.usdcPrice,
            wethIndex: state.wethIndex,
            usdcIndex: state.usdcIndex,
            aaveHF: state.aaveHF
        });
    }

    function _collateralUsd(MarginMMScenarioEngine.State memory state) private pure returns (uint256) {
        return _collateralBase(state) / 1e8;
    }

    function _collateralBase(MarginMMScenarioEngine.State memory state) private pure returns (uint256) {
        return
            Math.mulDiv(state.wethAmount, state.wethPrice, 1e18) + Math.mulDiv(state.usdcAmount, state.usdcPrice, 1e6);
    }

    function _executeIfCapacity(uint256 maxAmountIn, uint256 floor) private {
        MarginMMSwapVMRouter.FillCapacity memory c = router.capacity(order, aWETH, aUSDC, maxAmountIn);
        if (c.finalAmountOut == 0) {
            assertEq(c.actualAmountIn, 0);
            _assertPositionSafe(c.shockBps, floor);
            return;
        }
        bytes memory data = _data(c, c.finalAmountOut);
        vm.prank(taker);
        router.swap(order, aWETH, aUSDC, maxAmountIn, data);
        _assertPositionSafe(c.shockBps, floor);
    }

    function _supply(address user, uint256 wethAmount, uint256 usdcAmount) private {
        vm.deal(user, wethAmount);
        deal(USDC, user, usdcAmount);
        vm.startPrank(user);
        IMarginWETH(WETH).deposit{value: wethAmount}();
        IERC20(WETH).approve(POOL, wethAmount);
        IERC20(USDC).approve(POOL, usdcAmount);
        IMarginPool(POOL).supply(WETH, wethAmount, user, 0);
        IMarginPool(POOL).supply(USDC, usdcAmount, user, 0);
        IMarginPool(POOL).setUserUseReserveAsCollateral(WETH, true);
        IMarginPool(POOL).setUserUseReserveAsCollateral(USDC, true);
        vm.stopPrank();
    }
}
