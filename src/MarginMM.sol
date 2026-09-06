// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IPoolDataProvider} from "@aave/core-v3/contracts/interfaces/IPoolDataProvider.sol";

contract MarginMM {
    // State variable to store the Aave Data Provider contract instance
    IPoolDataProvider public immutable aaveDataProvider;

    // --- Risk Constants ---
    // We use Basis Points (bps) for precision. 10000 = 100%
    uint256 public constant BASE_FEE_BPS = 30; // 0.3% base fee

    // Health Factor (HF) is scaled by 1e18 in Aave
    uint256 public constant SAFE_HF = 1.5e18; // HF >= 1.5 is considered safe
    uint256 public constant LIQUIDATION_THRESHOLD_HF = 1.05e18; // HF < 1.05 triggers rejection

    /**
     * @dev Constructor initializes the contract with the correct Aave Data Provider address.
     * @param _aaveDataProvider The address of the Aave V3 PoolDataProvider on the target network.
     */
    constructor(address _aaveDataProvider) {
        require(_aaveDataProvider != address(0), "Invalid Data Provider address");
        aaveDataProvider = IPoolDataProvider(_aaveDataProvider);
    }

    /**
     * @notice Calculates the dynamic fee for a trade based on post-trade Health Factor and asset volatility.
     * @param simulatedNewHF The projected Health Factor of the portfolio after the trade (scaled by 1e18).
     * @param tokenOut The address of the asset being withdrawn from the AMM.
     * @return finalFeeBps The calculated fee in Basis Points (bps).
     */
    function calculateDynamicFee(uint256 simulatedNewHF, address tokenOut) public view returns (uint256 finalFeeBps) {
        // 1. Revert if the trade pushes the portfolio into liquidation territory
        require(simulatedNewHF >= LIQUIDATION_THRESHOLD_HF, "MarginMM: Trade causes liquidation!");

        // 2. Reward healthy trades: If the HF remains safe, apply a discounted fee (0.1%)
        if (simulatedNewHF >= SAFE_HF) {
            return 10;
        }

        // 3. Fetch Asset Risk Profile from Aave
        // getReserveConfigurationData returns multiple values, we only need the 3rd one (liquidationThreshold)
        // LT is returned in bps (e.g., 8500 = 85%)
        (,, uint256 assetLiquidationThreshold,,,,,,,) = aaveDataProvider.getReserveConfigurationData(tokenOut);

        // 4. Calculate Asset Risk Weight
        // Volatile assets have lower LT, resulting in a higher risk weight.
        uint256 assetRiskWeight = 10000 - assetLiquidationThreshold;

        // 5. Calculate Health Factor Risk Delta
        uint256 hfRiskDelta = SAFE_HF - simulatedNewHF;

        // 6. Calculate Dynamic Premium
        // We divide by (1e18 * 100) to normalize the large e18 numbers into reasonable basis points (bps)
        // Example: If HF delta is 0.4e18 and Risk Weight is 3500 -> Premium will be 14 bps.
        uint256 dynamicPremium = (hfRiskDelta * assetRiskWeight) / (1e18 * 100);

        // 7. Return Base Fee + Risk Premium
        return BASE_FEE_BPS + dynamicPremium;
    }
}
