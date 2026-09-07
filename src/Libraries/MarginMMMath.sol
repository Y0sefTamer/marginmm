// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title MarginMMMath
/// @notice Conservative health-factor and safe-capacity math for MarginMM.
/// @dev All health factors use 1e18 (WAD). Liquidation thresholds and stress parameters use BPS.
library MarginMMMath {
    uint256 internal constant BPS = 10_000;
    uint256 internal constant WAD = 1e18;

    error InvalidBps();
    error InvalidPrice();
    error InvalidDecimals();

    struct StressConfig {
        /// @notice Minimum stressed HF that a quote must preserve. Must be >= 1e18.
        uint256 minStressHF;
        /// @notice Collateral multiplier under stress, e.g. 9500 = 5% haircut.
        uint256 collateralStressBps;
        /// @notice Debt multiplier under stress, e.g. 10500 = 5% debt shock.
        uint256 debtStressBps;
    }

    function validateConfig(StressConfig memory config) internal pure {
        if (
            config.minStressHF < WAD || config.collateralStressBps == 0
                || config.collateralStressBps > BPS || config.debtStressBps < BPS
                || config.debtStressBps > 20_000
        ) revert InvalidBps();
    }

    /// @notice Conservative liquidation-adjusted collateral in Aave base-currency units.
    /// @dev Aave returns an average LT. Flooring here intentionally understates the safety buffer.
    function weightedCollateralBase(uint256 totalCollateralBase, uint256 currentLiquidationThresholdBps)
        internal
        pure
        returns (uint256)
    {
        return Math.mulDiv(totalCollateralBase, currentLiquidationThresholdBps, BPS, Math.Rounding.Floor);
    }

    /// @notice Convert a token amount to Aave oracle base units, rounding down.
    function tokenToBaseDown(uint256 amount, uint256 price, uint256 decimals) internal pure returns (uint256) {
        if (price == 0) revert InvalidPrice();
        if (decimals > 77) revert InvalidDecimals();
        return Math.mulDiv(amount, price, 10 ** decimals, Math.Rounding.Floor);
    }

    /// @notice Convert an outgoing token amount to base units, rounding up for safety.
    function tokenToBaseUp(uint256 amount, uint256 price, uint256 decimals) internal pure returns (uint256) {
        if (price == 0) revert InvalidPrice();
        if (decimals > 77) revert InvalidDecimals();
        return Math.mulDiv(amount, price, 10 ** decimals, Math.Rounding.Ceil);
    }

    /// @notice Liquidation-adjusted value of incoming collateral, rounded down.
    function incomingWeightedBase(uint256 amount, uint256 price, uint256 decimals, uint256 liquidationThresholdBps)
        internal
        pure
        returns (uint256)
    {
        uint256 baseValue = tokenToBaseDown(amount, price, decimals);
        return Math.mulDiv(baseValue, liquidationThresholdBps, BPS, Math.Rounding.Floor);
    }

    /// @notice Liquidation-adjusted value removed by outgoing collateral, rounded up.
    function outgoingWeightedBase(uint256 amount, uint256 price, uint256 decimals, uint256 liquidationThresholdBps)
        internal
        pure
        returns (uint256)
    {
        uint256 baseValue = tokenToBaseUp(amount, price, decimals);
        return Math.mulDiv(baseValue, liquidationThresholdBps, BPS, Math.Rounding.Ceil);
    }

    function stressedDebt(uint256 totalDebtBase, StressConfig memory config) internal pure returns (uint256) {
        validateConfig(config);
        return Math.mulDiv(totalDebtBase, config.debtStressBps, BPS, Math.Rounding.Ceil);
    }

    /// @notice Stress HF from liquidation-adjusted collateral and raw debt.
    /// @dev Collateral is floored and debt is ceiled, so the result is deliberately conservative.
    function stressHF(uint256 weightedCollateral, uint256 totalDebtBase, StressConfig memory config)
        internal
        pure
        returns (uint256)
    {
        validateConfig(config);
        if (totalDebtBase == 0) return type(uint256).max;

        uint256 stressedCollateral =
            Math.mulDiv(weightedCollateral, config.collateralStressBps, BPS, Math.Rounding.Floor);
        uint256 debt = Math.mulDiv(totalDebtBase, config.debtStressBps, BPS, Math.Rounding.Ceil);
        if (debt == 0) return type(uint256).max;
        return Math.mulDiv(stressedCollateral, WAD, debt, Math.Rounding.Floor);
    }

    /// @notice Minimum pre-stress weighted collateral required to satisfy minStressHF.
    function requiredWeightedCollateral(uint256 totalDebtBase, StressConfig memory config)
        internal
        pure
        returns (uint256)
    {
        validateConfig(config);
        if (totalDebtBase == 0) return 0;

        uint256 debt = Math.mulDiv(totalDebtBase, config.debtStressBps, BPS, Math.Rounding.Ceil);
        uint256 requiredStressedCollateral =
            Math.mulDiv(config.minStressHF, debt, WAD, Math.Rounding.Ceil);
        return Math.mulDiv(requiredStressedCollateral, BPS, config.collateralStressBps, Math.Rounding.Ceil);
    }

    /// @notice Conservative qMax for removing one collateral asset.
    /// @dev Incoming collateral is intentionally ignored. This makes qMax safe independent of settlement ordering.
    function safeCapacity(
        uint256 weightedCollateral,
        uint256 totalDebtBase,
        uint256 tokenBalance,
        uint256 price,
        uint256 decimals,
        uint256 liquidationThresholdBps,
        StressConfig memory config
    ) internal pure returns (uint256 qMax) {
        validateConfig(config);
        if (tokenBalance == 0) return 0;
        if (totalDebtBase == 0 || liquidationThresholdBps == 0) return tokenBalance;
        if (price == 0) revert InvalidPrice();
        if (decimals > 77) revert InvalidDecimals();

        uint256 required = requiredWeightedCollateral(totalDebtBase, config);
        if (weightedCollateral <= required) return 0;

        uint256 weightedHeadroom = weightedCollateral - required;

        // For ceil(baseValue * LT / BPS) <= headroom, baseValue must be <= floor(headroom*BPS/LT).
        uint256 maxBaseValue = Math.mulDiv(weightedHeadroom, BPS, liquidationThresholdBps, Math.Rounding.Floor);
        uint256 amountByRisk = Math.mulDiv(maxBaseValue, 10 ** decimals, price, Math.Rounding.Floor);

        return Math.min(tokenBalance, amountByRisk);
    }

    /// @notice Conservative post-trade stressed HF, optionally crediting collateral that is already enabled.
    function previewPostTradeStressHF(
        uint256 weightedCollateral,
        uint256 totalDebtBase,
        uint256 amountOut,
        uint256 outPrice,
        uint256 outDecimals,
        uint256 outLiquidationThresholdBps,
        bool outUsedAsCollateral,
        uint256 amountIn,
        uint256 inPrice,
        uint256 inDecimals,
        uint256 inLiquidationThresholdBps,
        bool inUsedAsCollateral,
        StressConfig memory config
    ) internal pure returns (uint256) {
        uint256 postWeighted = weightedCollateral;

        if (outUsedAsCollateral && amountOut != 0) {
            uint256 debit = outgoingWeightedBase(
                amountOut, outPrice, outDecimals, outLiquidationThresholdBps
            );
            if (debit >= postWeighted) postWeighted = 0;
            else postWeighted -= debit;
        }

        // Only credit an incoming asset if Aave already marks that reserve as collateral for the maker.
        // This avoids assuming automatic collateral enablement during settlement.
        if (inUsedAsCollateral && amountIn != 0) {
            postWeighted += incomingWeightedBase(
                amountIn, inPrice, inDecimals, inLiquidationThresholdBps
            );
        }

        return stressHF(postWeighted, totalDebtBase, config);
    }
}
