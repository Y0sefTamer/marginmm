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
    constructor(
        address _pricingEngine, 
        address _asset, 
        address _initialOwner
    ) Ownable(_initialOwner) {
        require(_pricingEngine != address(0) && _asset != address(0), "Zero address");
        pricingEngine = MarginMMPricing(_pricingEngine);
        asset = IERC20(_asset);
    }

   
    function depositLiquidity(uint256 amount) external {
        asset.safeTransferFrom(msg.sender, address(this), amount);
    }

   
}