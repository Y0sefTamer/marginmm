// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {MarginMMScenarioEngine} from "../src/MarginMMScenarioEngine.sol";
import {MarginMMTradeMath} from "../src/libraries/MarginMMTradeMath.sol";

contract TradeMathHarness {
    function inputFor(MarginMMScenarioEngine.State memory s, bool wethIn, uint256 amountOut, uint256 spread)
        external
        pure
        returns (uint256)
    {
        return MarginMMTradeMath.inputFor(s, wethIn, amountOut, spread);
    }

    function capacity(MarginMMScenarioEngine.State memory s, bool wethIn, uint256 spread, uint256 floor)
        external
        pure
        returns (uint256)
    {
        return MarginMMTradeMath.capacity(s, wethIn, spread, floor);
    }
}

contract MarginMMTradeMathTest is Test {
    uint256 private constant BPS = 10_000;
    uint256 private constant RAY = 1e27;
    TradeMathHarness private math;

    function setUp() public {
        math = new TradeMathHarness();
    }

    function _state() private pure returns (MarginMMScenarioEngine.State memory s) {
        s = MarginMMScenarioEngine.State({
            wethAmount: 10e18,
            usdcAmount: 50_000e6,
            usdcDebt: 46_000e6,
            wethLT: 8_300,
            usdcLT: 7_700,
            wethPrice: 4_000e8,
            usdcPrice: 1e8,
            wethIndex: 11e26,
            usdcIndex: 12e26,
            aaveHF: 0
        });
    }

    function test_InputPriceAlwaysRoundsAgainstTaker() public view {
        MarginMMScenarioEngine.State memory s = _state();
        uint256 amountIn = math.inputFor(s, true, 1e6, 10);
        assertEq(amountIn, 250_250_000_000_000);
        assertGe(amountIn * s.wethPrice * BPS, 1e6 * s.usdcPrice * 1e12 * (BPS + 10));
    }

    function test_NoDebtIsLimitedOnlyByActualOutputRounding() public view {
        MarginMMScenarioEngine.State memory s = _state();
        s.usdcDebt = 0;
        uint256 guard = Math.ceilDiv(s.usdcIndex, RAY) + 1;
        assertEq(math.capacity(s, true, 10, 1.1e18), s.usdcAmount - guard);
    }

    function test_StrongerFloorNeverIncreasesCapacity() public view {
        MarginMMScenarioEngine.State memory s = _state();
        assertLe(math.capacity(s, true, 10, 1.15e18), math.capacity(s, true, 10, 1.1e18));
        assertLe(math.capacity(s, false, 10, 1.15e18), math.capacity(s, false, 10, 1.1e18));
    }

    function testFuzz_CapacityRemainsAboveFloorAfterConservativeSettlement(
        uint64 wethWhole,
        uint64 usdcWhole,
        uint64 debtWhole,
        uint32 wethPriceWhole,
        uint32 usdcPriceRaw,
        uint16 wethLTRaw,
        uint16 usdcLTRaw,
        uint32 wethIndexExtra,
        uint32 usdcIndexExtra,
        uint16 floorRaw,
        uint8 spreadRaw,
        bool wethIn
    ) public view {
        MarginMMScenarioEngine.State memory s;
        s.wethAmount = bound(wethWhole, 1, 10_000) * 1e18;
        s.usdcAmount = bound(usdcWhole, 1, 10_000_000) * 1e6;
        s.usdcDebt = bound(debtWhole, 1, 10_000_000) * 1e6;
        s.wethPrice = bound(wethPriceWhole, 100, 100_000) * 1e8;
        s.usdcPrice = bound(usdcPriceRaw, 50_000_000, 150_000_000);
        s.wethLT = bound(wethLTRaw, 1, BPS);
        s.usdcLT = bound(usdcLTRaw, 1, BPS);
        s.wethIndex = RAY + uint256(wethIndexExtra) * 1e20;
        s.usdcIndex = RAY + uint256(usdcIndexExtra) * 1e20;
        uint256 floor = bound(floorRaw, 10_100, 30_000) * 1e14;
        uint256 spread = bound(spreadRaw, 0, 100);

        uint256 capacity = math.capacity(s, wethIn, spread, floor);
        uint256 outputGuard = Math.ceilDiv(wethIn ? s.usdcIndex : s.wethIndex, RAY) + 1;
        uint256 outputBalance = wethIn ? s.usdcAmount : s.wethAmount;
        assertLe(capacity, outputBalance > outputGuard ? outputBalance - outputGuard : 0);

        if (_stressHF(s) < floor) {
            assertEq(capacity, 0);
            return;
        }
        if (capacity == 0) return;
        uint256 amountIn = math.inputFor(s, wethIn, capacity, spread);
        assertGe(_preview(s, wethIn, amountIn, capacity), floor);
    }

    function _preview(MarginMMScenarioEngine.State memory s, bool wethIn, uint256 amountIn, uint256 amountOut)
        private
        pure
        returns (uint256)
    {
        uint256 inputIndex = wethIn ? s.wethIndex : s.usdcIndex;
        uint256 outputIndex = wethIn ? s.usdcIndex : s.wethIndex;
        uint256 loss = 2 * Math.ceilDiv(inputIndex, RAY) + 2;
        uint256 credit = amountIn > loss ? amountIn - loss : 0;
        uint256 outputBalance = wethIn ? s.usdcAmount : s.wethAmount;
        uint256 debit = amountOut + Math.ceilDiv(outputIndex, RAY) + 1;
        assertLe(debit, outputBalance);
        if (wethIn) {
            s.wethAmount += credit;
            s.usdcAmount -= debit;
        } else {
            s.usdcAmount += credit;
            s.wethAmount -= debit;
        }
        return _stressHF(s);
    }

    function _stressHF(MarginMMScenarioEngine.State memory s) private pure returns (uint256 worst) {
        if (s.usdcDebt == 0) return type(uint256).max;
        worst = _scenarioHF(s, BPS, BPS);
        worst = Math.min(worst, _scenarioHF(s, 8_000, BPS));
        worst = Math.min(worst, _scenarioHF(s, 7_000, BPS));
        worst = Math.min(worst, _scenarioHF(s, BPS, 9_500));
    }

    function _scenarioHF(MarginMMScenarioEngine.State memory s, uint256 wethShock, uint256 usdcShock)
        private
        pure
        returns (uint256)
    {
        uint256 wethBase = Math.mulDiv(s.wethAmount, s.wethPrice * wethShock, 1e18 * BPS);
        uint256 usdcBase = Math.mulDiv(s.usdcAmount, s.usdcPrice * usdcShock, 1e6 * BPS);
        uint256 collateral = Math.mulDiv(wethBase, s.wethLT, BPS) + Math.mulDiv(usdcBase, s.usdcLT, BPS);
        uint256 debt = Math.mulDiv(s.usdcDebt, s.usdcPrice * usdcShock, 1e6 * BPS, Math.Rounding.Ceil);
        return Math.mulDiv(collateral, 1e18, debt);
    }
}
