// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title MarginMMPricing
/// @notice Fee curve driven by stressed HF rather than treating Aave LT as a volatility oracle.
contract MarginMMPricing {
    uint256 public constant WAD = 1e18;

    uint256 public immutable minStressHF;
    uint256 public immutable safeStressHF;
    uint256 public immutable minFeeBps;
    uint256 public immutable maxFeeBps;

    error UnsafeStressHF(uint256 stressHF);
    error InvalidConfig();

    constructor(uint256 minStressHF_, uint256 safeStressHF_, uint256 minFeeBps_, uint256 maxFeeBps_) {
        if (
            minStressHF_ < WAD || safeStressHF_ <= minStressHF_ || minFeeBps_ > maxFeeBps_
                || maxFeeBps_ > 1_000
        ) revert InvalidConfig();

        minStressHF = minStressHF_;
        safeStressHF = safeStressHF_;
        minFeeBps = minFeeBps_;
        maxFeeBps = maxFeeBps_;
    }

    /// @notice Fee rises linearly as stressed HF approaches the safety floor.
    function calculateDynamicFee(uint256 stressHF) external view returns (uint256 feeBps) {
        if (stressHF < minStressHF) revert UnsafeStressHF(stressHF);
        if (stressHF >= safeStressHF) return minFeeBps;

        uint256 riskWindow = safeStressHF - minStressHF;
        uint256 riskUsed = safeStressHF - stressHF;
        uint256 feeRange = maxFeeBps - minFeeBps;

        return minFeeBps + (feeRange * riskUsed) / riskWindow;
    }
}
