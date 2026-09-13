// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {XYCSwapMath} from "../src/libraries/XYCSwapMath.sol";
import {MarginMMScenarioEngine} from "../src/MarginMMScenarioEngine.sol";
import {MarginMMTradeMath} from "../src/libraries/MarginMMTradeMath.sol";

contract ScenarioRiskStub {
    uint256 private constant BPS = 10_000;
    uint256 private constant RAY = 1e27;

    function stressHF(MarginMMScenarioEngine.State memory state, uint32 shockBps) external pure returns (uint256) {
        if (state.usdcDebt == 0) return type(uint256).max;
        uint256 wethBase = Math.mulDiv(state.wethAmount, state.wethPrice * (BPS - shockBps), 1e18 * BPS);
        uint256 usdcBase = Math.mulDiv(state.usdcAmount, state.usdcPrice, 1e6);
        uint256 collateral = Math.mulDiv(wethBase, state.wethLT, BPS) + Math.mulDiv(usdcBase, state.usdcLT, BPS);
        uint256 debt = Math.mulDiv(state.usdcDebt, state.usdcPrice, 1e6, Math.Rounding.Ceil);
        return Math.mulDiv(collateral, 1e18, debt);
    }

    function preview(
        MarginMMScenarioEngine.State memory state,
        bool wethIn,
        uint256 amountIn,
        uint256 amountOut,
        uint32 shockBps
    ) external view returns (uint256) {
        uint256 inputIndex = wethIn ? state.wethIndex : state.usdcIndex;
        uint256 outputIndex = wethIn ? state.usdcIndex : state.wethIndex;
        uint256 loss = 2 * Math.ceilDiv(inputIndex, RAY) + 2;
        uint256 credit = amountIn > loss ? amountIn - loss : 0;
        uint256 outputBalance = wethIn ? state.usdcAmount : state.wethAmount;
        uint256 debit = amountOut == 0 ? 0 : Math.min(outputBalance, amountOut + Math.ceilDiv(outputIndex, RAY) + 1);
        if (wethIn) {
            state.wethAmount += credit;
            state.usdcAmount -= debit;
        } else {
            state.usdcAmount += credit;
            state.wethAmount -= debit;
        }
        return this.stressHF(state, shockBps);
    }
}

contract TradeMathHarness {
    function solve(
        address riskEngine,
        MarginMMScenarioEngine.State memory state,
        bool wethIn,
        uint256 maxAmountIn,
        uint256 virtualBalanceIn,
        uint256 virtualBalanceOut,
        uint256 availableAmountOut,
        uint256 floor,
        uint32 shockBps
    ) external view returns (MarginMMTradeMath.Result memory) {
        return MarginMMTradeMath.solve(
            MarginMMScenarioEngine(riskEngine),
            state,
            wethIn,
            maxAmountIn,
            virtualBalanceIn,
            virtualBalanceOut,
            availableAmountOut,
            floor,
            shockBps
        );
    }
}

contract MarginMMTradeMathTest is Test {
    uint32 private constant SHOCK_BPS = 1_240;
    uint256 private constant FLOOR = 1.1e18;

    ScenarioRiskStub private risk;
    TradeMathHarness private solver;

    function setUp() public {
        risk = new ScenarioRiskStub();
        solver = new TradeMathHarness();
    }

    function testFullExactInKeepsRequestedInput() public view {
        MarginMMScenarioEngine.State memory state = _state();
        uint256 maxAmountIn = 0.1 ether;
        uint256 virtualIn = 30 ether;
        uint256 virtualOut = 120_000e6;
        MarginMMTradeMath.Result memory result = solver.solve(
            address(risk), state, true, maxAmountIn, virtualIn, virtualOut, state.usdcAmount, FLOOR, SHOCK_BPS
        );

        assertEq(result.baseAmountOut, XYCSwapMath.exactIn(virtualIn, virtualOut, maxAmountIn));
        assertEq(result.qMax, result.baseAmountOut);
        assertEq(result.actualAmountIn, maxAmountIn);
        assertFalse(result.riskCapped);
        assertFalse(result.liquidityCapped);
        assertGe(result.stressHFAfter, FLOOR);
    }

    function testRiskCapUsesSameExactOutMathAndFindsAtomicBoundary() public view {
        MarginMMScenarioEngine.State memory state = _state();
        uint256 maxAmountIn = 20 ether;
        uint256 virtualIn = 30 ether;
        uint256 virtualOut = 120_000e6;
        uint256 boundaryFloor = 1.23e18;
        MarginMMTradeMath.Result memory result = solver.solve(
            address(risk), state, true, maxAmountIn, virtualIn, virtualOut, state.usdcAmount, boundaryFloor, SHOCK_BPS
        );

        assertTrue(result.riskCapped);
        assertLt(result.qMax, result.baseAmountOut);
        assertEq(result.actualAmountIn, XYCSwapMath.exactOut(virtualIn, virtualOut, result.qMax));
        assertLt(result.actualAmountIn, maxAmountIn);
        assertGe(result.stressHFAfter, boundaryFloor);

        uint256 above = result.qMax + 1;
        uint256 aboveInput = XYCSwapMath.exactOut(virtualIn, virtualOut, above);
        assertLt(risk.preview(state, true, aboveInput, above, SHOCK_BPS), boundaryFloor);
    }

    function testReverseRiskCapUsesSameExactOutMathAndFindsAtomicBoundary() public view {
        MarginMMScenarioEngine.State memory state = _state();
        uint256 maxAmountIn = 20_000e6;
        // 1,500 USDC/WETH is the explicit lower XYC price bound used by the
        // fork fixture. At this edge, outgoing shocked WETH can be risk-capped.
        uint256 virtualIn = 45_000e6;
        uint256 virtualOut = 30 ether;
        uint256 boundaryFloor = 1.23e18;
        MarginMMTradeMath.Result memory result = solver.solve(
            address(risk), state, false, maxAmountIn, virtualIn, virtualOut, state.wethAmount, boundaryFloor, SHOCK_BPS
        );

        assertTrue(result.riskCapped);
        assertLt(result.qMax, result.baseAmountOut);
        assertEq(result.actualAmountIn, XYCSwapMath.exactOut(virtualIn, virtualOut, result.qMax));
        assertLt(result.actualAmountIn, maxAmountIn);
        assertGe(result.stressHFAfter, boundaryFloor);

        uint256 above = result.qMax + 1;
        uint256 aboveInput = XYCSwapMath.exactOut(virtualIn, virtualOut, above);
        assertLt(risk.preview(state, false, aboveInput, above, SHOCK_BPS), boundaryFloor);
    }

    function testPhysicalLiquidityCapRecomputesInput() public view {
        MarginMMScenarioEngine.State memory state = _state();
        uint256 maxAmountIn = 1 ether;
        uint256 virtualIn = 30 ether;
        uint256 virtualOut = 120_000e6;
        uint256 availableOut = 100e6;
        MarginMMTradeMath.Result memory result = solver.solve(
            address(risk), state, true, maxAmountIn, virtualIn, virtualOut, availableOut, FLOOR, SHOCK_BPS
        );

        assertTrue(result.liquidityCapped);
        assertFalse(result.riskCapped);
        assertEq(result.qMax, availableOut);
        assertEq(result.actualAmountIn, XYCSwapMath.exactOut(virtualIn, virtualOut, availableOut));
        assertLt(result.actualAmountIn, maxAmountIn);
    }

    function testUnsafeStartingPositionHasNoCapacity() public view {
        MarginMMScenarioEngine.State memory state = _state();
        state.usdcDebt = 60_000e6;
        MarginMMTradeMath.Result memory result =
            solver.solve(address(risk), state, true, 1 ether, 30 ether, 120_000e6, state.usdcAmount, FLOOR, SHOCK_BPS);
        assertEq(result.qMax, 0);
        assertEq(result.actualAmountIn, 0);
        assertLt(result.stressHFBefore, FLOOR);
    }

    function testFuzzBoundaryNeverCrossesFloor(uint64 maxInRaw, uint16 floorRaw, uint16 shockRaw) public view {
        MarginMMScenarioEngine.State memory state = _state();
        uint256 maxAmountIn = bound(maxInRaw, 1e12, 50 ether);
        uint256 floor = bound(floorRaw, 10_100, 13_000) * 1e14;
        uint32 shockBps = uint32(bound(shockRaw, 100, 5_000));
        uint256 virtualIn = 30 ether;
        uint256 virtualOut = 120_000e6;
        MarginMMTradeMath.Result memory result = solver.solve(
            address(risk), state, true, maxAmountIn, virtualIn, virtualOut, state.usdcAmount, floor, shockBps
        );

        assertLe(result.qMax, result.baseAmountOut);
        assertLe(result.actualAmountIn, maxAmountIn);
        if (result.qMax == 0) return;
        assertGe(result.stressHFAfter, floor);
        if (result.riskCapped && result.qMax + 1 < result.baseAmountOut) {
            uint256 above = result.qMax + 1;
            uint256 aboveInput = XYCSwapMath.exactOut(virtualIn, virtualOut, above);
            assertLt(risk.preview(state, true, aboveInput, above, shockBps), floor);
        }
    }

    function _state() private pure returns (MarginMMScenarioEngine.State memory state) {
        state = MarginMMScenarioEngine.State({
            wethAmount: 10 ether,
            usdcAmount: 50_000e6,
            usdcDebt: 46_000e6,
            wethLT: 8_300,
            usdcLT: 7_800,
            wethPrice: 2_500e8,
            usdcPrice: 1e8,
            wethIndex: 11e26,
            usdcIndex: 12e26,
            aaveHF: 0
        });
    }
}
