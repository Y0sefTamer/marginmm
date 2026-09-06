// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {MarginMMPricing} from "./MarginMMPricing.sol";

/**
 * @title MarginMM Aqua Position
 * @dev This is the main Vault contract that interacts with 1inch/Aqua.
 * It holds liquidity and uses MarginMMPricing to quote dynamic fees.
 */
contract MarginMMAquaPosition is Ownable {
    using SafeERC20 for IERC20;

    MarginMMPricing public pricingEngine;
    IERC20 public asset; // The token this vault holds (e.g., USDC)

    /**
     * @dev Constructor sets the owner, the pricing engine, and the asset token.
     */
    constructor(address _pricingEngine, address _asset, address _initialOwner) Ownable(_initialOwner) {
        require(_pricingEngine != address(0) && _asset != address(0), "Zero address");
        pricingEngine = MarginMMPricing(_pricingEngine);
        asset = IERC20(_asset);
    }

    function depositLiquidity(uint256 amount) external {
        asset.safeTransferFrom(msg.sender, address(this), amount);
    }

    /**
     * @notice Executes a swap requested by 1inch SwapVM/Taker.
     * @param simulatedNewHF The projected HF (passed by off-chain logic or solver).
     * @param requestedAmount The amount of asset the taker wants to buy.
     * @param taker The address of the user/solver executing the swap.
     * @return netAmountOut The actual amount sent to the taker after dynamic fees.
     */
    function executeAquaSwap(uint256 simulatedNewHF, uint256 requestedAmount, address taker)
        external
        returns (uint256 netAmountOut)
    {
        // 1. Check if Vault has enough liquidity
        require(asset.balanceOf(address(this)) >= requestedAmount, "MarginMM: Insufficient liquidity");

        // 2. Consult the Pricing Engine for the dynamic fee
        // We pass the simulated HF and the asset address to get the specific fee in basis points (bps)
        uint256 feeBps = pricingEngine.calculateDynamicFee(simulatedNewHF, address(asset));

        // 3. Calculate actual fee amount
        // 10000 bps = 100%. Example: (1000 USDC * 30 bps) / 10000 = 3 USDC fee
        uint256 feeAmount = (requestedAmount * feeBps) / 10000;

        // 4. Calculate net amount for the taker
        netAmountOut = requestedAmount - feeAmount;

        // 5. Transfer the net amount to the taker
        // SafeERC20 ensures the transfer doesn't fail silently
        asset.safeTransfer(taker, netAmountOut);

        // NOTE: The feeAmount remains inside this contract (the Vault)
        // as profit (Yield) for the Market Makers / Liquidity Providers!
    }
}
