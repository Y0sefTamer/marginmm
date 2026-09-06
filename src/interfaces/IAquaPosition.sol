// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IAquaPosition
 * @dev The official standard interface required by 1inch SwapVM.
 * Any custom DeFi position or instruction must implement this so the
 * SwapVM engine can route the trade through it.
 */
interface IAquaPosition {
    /**
     * @notice Executes the custom instruction (our Risk Engine) during a SwapVM transaction.
     * @param taker The address initiating the swap.
     * @param tokenOut The token the taker wants to receive.
     * @param requestedAmount The amount requested.
     * @param instructionData Custom bytes passed by the solver (e.g., simulated HF).
     * @return netAmountOut The final amount returned after our dynamic fee is applied.
     */
    function executeSwapInstruction(
        address taker,
        address tokenOut,
        uint256 requestedAmount,
        bytes calldata instructionData
    ) external returns (uint256 netAmountOut);
}
