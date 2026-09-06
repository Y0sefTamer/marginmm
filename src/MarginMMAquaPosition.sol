// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {MarginMMPricing} from "./MarginMMPricing.sol";

// 1. Import the official 1inch SwapVM/Aqua interface
import {IAquaPosition} from "./interfaces/IAquaPosition.sol";

/**
 * @title MarginMM Aqua Position
 * @dev Implements a sophisticated DeFi position as a custom SwapVM instruction.
 * This Vault holds liquidity and dynamically prices marginal liquidation risk
 * on every trade utilizing the MarginMMPricing Risk Engine.
 */
contract MarginMMAquaPosition is Ownable, IAquaPosition {
    using SafeERC20 for IERC20;

    MarginMMPricing public pricingEngine;
    IERC20 public asset;

    /**
     * @notice Initializes the Vault with the Pricing Engine and the underlying asset.
     */
    constructor(address _pricingEngine, address _asset, address _initialOwner) Ownable(_initialOwner) {
        require(_pricingEngine != address(0) && _asset != address(0), "MarginMM: Zero address");
        pricingEngine = MarginMMPricing(_pricingEngine);
        asset = IERC20(_asset);
    }

    /**
     * @notice Allows Liquidity Providers (Makers) to deposit assets into the Vault.
     * @param amount The amount of tokens to deposit.
     */
    function depositLiquidity(uint256 amount) external {
        asset.safeTransferFrom(msg.sender, address(this), amount);
    }

    /**
     * @notice The core execution function invoked by the 1inch SwapVM engine.
     * @dev Decodes solver data, calculates dynamic risk premiums, and finalizes the swap.
     * @inheritdoc IAquaPosition
     */
    function executeSwapInstruction(
        address taker,
        address tokenOut,
        uint256 requestedAmount,
        bytes calldata instructionData
    ) external override returns (uint256 netAmountOut) {
        // Step 1: Ensure the Vault holds sufficient liquidity and the correct asset is requested
        require(asset.balanceOf(address(this)) >= requestedAmount, "MarginMM: Insufficient liquidity");
        require(tokenOut == address(asset), "MarginMM: Asset mismatch");

        // Step 2: Decode the payload passed by the SwapVM solver.
        // In our architecture, the solver passes the simulated Post-Trade Health Factor.
        uint256 simulatedNewHF = abi.decode(instructionData, (uint256));

        // Step 3: Consult the Risk Engine to calculate the dynamic fee (in basis points)
        uint256 feeBps = pricingEngine.calculateDynamicFee(simulatedNewHF, tokenOut);

        // Calculate the absolute fee amount (10000 bps = 100%)
        uint256 feeAmount = (requestedAmount * feeBps) / 10000;

        // Step 4: Calculate the net amount for the taker
        netAmountOut = requestedAmount - feeAmount;

        // Step 5: Transfer the net amount to the taker.
        // Note: The `feeAmount` remains in the contract as accrued yield for the LPs.
        asset.safeTransfer(taker, netAmountOut);
    }
}
