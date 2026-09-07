// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {MarginMMRiskEngine} from "./MarginMMRiskEngine.sol";

/// @title MarginMMAquaPosition
/// @notice Read-only policy/lens that bridges Aqua virtual liquidity with MarginMM qMax.
/// @dev This contract deliberately DOES NOT custody maker funds. Aqua should hold the strategy's virtual balances.
contract MarginMMAquaPosition {
    MarginMMRiskEngine public immutable riskEngine;

    error ZeroAddress();

    struct FillQuote {
        uint256 aaveQMax;
        uint256 aquaAvailableOut;
        uint256 effectiveCapacity;
        uint256 requestedOut;
        uint256 executableOut;
        bool partialFill;
    }

    constructor(address riskEngine_) {
        if (riskEngine_ == address(0)) revert ZeroAddress();
        riskEngine = MarginMMRiskEngine(riskEngine_);
    }

    /// @notice Combine Aave safety capacity with Aqua's current virtual output balance.
    /// @param maker Aave borrower / Aqua maker.
    /// @param aTokenOut Aave aToken being sold from the maker's wallet.
    /// @param aquaAvailableOut Value read from Aqua.safeBalances for this strategy/token.
    /// @param requestedOut Output requested by the swap path.
    function quoteFill(address maker, address aTokenOut, uint256 aquaAvailableOut, uint256 requestedOut)
        external
        view
        returns (FillQuote memory quote)
    {
        uint256 aaveQMax = riskEngine.safeCapacity(maker, aTokenOut);
        uint256 effectiveCapacity = Math.min(aaveQMax, aquaAvailableOut);
        uint256 executableOut = Math.min(requestedOut, effectiveCapacity);

        quote = FillQuote({
            aaveQMax: aaveQMax,
            aquaAvailableOut: aquaAvailableOut,
            effectiveCapacity: effectiveCapacity,
            requestedOut: requestedOut,
            executableOut: executableOut,
            partialFill: executableOut < requestedOut
        });
    }
}
