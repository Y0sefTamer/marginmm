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
}
