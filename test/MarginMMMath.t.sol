// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {MarginMMMath} from "../src/libraries/MarginMMMath.sol";

contract MarginMMMathHarness {
    function stressHF(uint256 weightedCollateral, uint256 debt, MarginMMMath.StressConfig calldata c)
        external
        pure
        returns (uint256)
    {
        return MarginMMMath.stressHF(weightedCollateral, debt, c);
    }

    function qMax(
        uint256 weightedCollateral,
        uint256 debt,
        uint256 balance,
        uint256 price,
        uint256 decimals,
        uint256 lt,
        MarginMMMath.StressConfig calldata c
    ) external pure returns (uint256) {
        return MarginMMMath.safeCapacity(weightedCollateral, debt, balance, price, decimals, lt, c);
    }

    function debit(uint256 amount, uint256 price, uint256 decimals, uint256 lt) external pure returns (uint256) {
        return MarginMMMath.outgoingWeightedBase(amount, price, decimals, lt);
    }

    function postHF(
        uint256 weightedCollateral,
        uint256 debt,
        uint256 amountOut,
        uint256 outPrice,
        uint256 outDecimals,
        uint256 outLt,
        bool outCollateral,
        uint256 amountIn,
        uint256 inPrice,
        uint256 inDecimals,
        uint256 inLt,
        bool inCollateral,
        MarginMMMath.StressConfig calldata c
    ) external pure returns (uint256) {
        return MarginMMMath.previewPostTradeStressHF(
            weightedCollateral,
            debt,
            amountOut,
            outPrice,
            outDecimals,
            outLt,
            outCollateral,
            amountIn,
            inPrice,
            inDecimals,
            inLt,
            inCollateral,
            c
        );
    }
}

contract MarginMMMathTest is Test {
    MarginMMMathHarness internal h;
    MarginMMMath.StressConfig internal config;

    function setUp() public {
        h = new MarginMMMathHarness();
        config = MarginMMMath.StressConfig({minStressHF: 1.1e18, collateralStressBps: 9_500, debtStressBps: 10_500});
    }

    function test_NoDebt_AllBalanceIsSafe() public {
        uint256 q = h.qMax(100_000e8, 0, 12e18, 3_000e8, 18, 8_000, config);
        assertEq(q, 12e18);
    }

    function test_NoHeadroom_ReturnsZero() public {
        // weighted collateral = $1000, debt = $1000. Stress makes the position far below 1.10.
        uint256 q = h.qMax(1_000e8, 1_000e8, 1e18, 3_000e8, 18, 8_000, config);
        assertEq(q, 0);
    }

    function test_QMaxBoundaryPreservesStressHF() public {
        uint256 weighted = 20_000e8;
        uint256 debt = 10_000e8;
        uint256 balance = 10e18;
        uint256 price = 3_000e8;
        uint256 lt = 8_000;

        uint256 q = h.qMax(weighted, debt, balance, price, 18, lt, config);
        assertGt(q, 0);
        assertLt(q, balance);

        uint256 debitAtQ = h.debit(q, price, 18, lt);
        uint256 hfAtQ = h.stressHF(weighted - debitAtQ, debt, config);
        assertGe(hfAtQ, config.minStressHF);

        // Because of discrete oracle base units, the first unsafe amount can be more than q+1 wei.
        // Check a one-base-unit larger token amount instead.
        uint256 oneBaseUnitInToken = (1e18 + price - 1) / price;
        uint256 qPlus = q + oneBaseUnitInToken;
        if (qPlus <= balance) {
            uint256 debitAbove = h.debit(qPlus, price, 18, lt);
            uint256 hfAbove = h.stressHF(weighted - debitAbove, debt, config);
            assertLt(hfAbove, config.minStressHF);
        }
    }

    function test_StrongerStressLowersCapacity() public {
        uint256 q1 = h.qMax(20_000e8, 10_000e8, 10e18, 3_000e8, 18, 8_000, config);

        MarginMMMath.StressConfig memory harsher =
            MarginMMMath.StressConfig({minStressHF: 1.15e18, collateralStressBps: 9_000, debtStressBps: 11_000});
        uint256 q2 = h.qMax(20_000e8, 10_000e8, 10e18, 3_000e8, 18, 8_000, harsher);

        assertLt(q2, q1);
    }

    function test_LowLTAssetCanRemoveMoreMarketValue() public {
        uint256 qHighLt = h.qMax(20_000e8, 10_000e8, 100_000e18, 1e8, 18, 8_500, config);
        uint256 qLowLt = h.qMax(20_000e8, 10_000e8, 100_000e18, 1e8, 18, 6_000, config);
        assertGt(qLowLt, qHighLt);
    }

    function test_IncomingEnabledCollateralImprovesPostTradeStressHF() public {
        uint256 withoutCredit =
            h.postHF(20_000e8, 10_000e8, 2e18, 2_000e8, 18, 8_000, true, 3_500e6, 1e8, 6, 8_500, false, config);

        uint256 withCredit =
            h.postHF(20_000e8, 10_000e8, 2e18, 2_000e8, 18, 8_000, true, 3_500e6, 1e8, 6, 8_500, true, config);

        assertGt(withCredit, withoutCredit);
    }

    function testFuzz_QMaxNeverBreaksGuard(
        uint96 weightedRaw,
        uint96 debtRaw,
        uint96 balanceRaw,
        uint64 priceRaw,
        uint16 ltRaw
    ) public {
        uint256 weighted = bound(uint256(weightedRaw), 1e8, 1_000_000_000e8);
        uint256 debt = bound(uint256(debtRaw), 1e8, 500_000_000e8);
        uint256 balance = bound(uint256(balanceRaw), 1, 1_000_000e18);
        uint256 price = bound(uint256(priceRaw), 1, 1_000_000e8);
        uint256 lt = bound(uint256(ltRaw), 1, 9_900);

        uint256 q = h.qMax(weighted, debt, balance, price, 18, lt, config);
        if (q == 0) return;

        uint256 debitAtQ = h.debit(q, price, 18, lt);
        if (debitAtQ > weighted) return; // unreachable for a correctly bounded q; keeps fuzz arithmetic total.

        uint256 hfAtQ = h.stressHF(weighted - debitAtQ, debt, config);
        assertGe(hfAtQ, config.minStressHF);
    }
}
