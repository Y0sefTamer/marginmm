// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
pragma solidity 0.8.30;

/// @custom:license-url https://github.com/1inch/swap-vm/blob/main/LICENSES/SwapVM-1.1.txt
/// @custom:copyright © 2025 Degensoft Ltd

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

/// @dev Single source of truth for the XYC amount and rounding semantics.
library XYCSwapMath {
    function exactIn(uint256 balanceIn, uint256 balanceOut, uint256 amountIn)
        internal
        pure
        returns (uint256 amountOut)
    {
        // Floor division for tokenOut is maker-favoring and matches XYCSwap.
        return (amountIn * balanceOut) / (balanceIn + amountIn);
    }

    function exactOut(uint256 balanceIn, uint256 balanceOut, uint256 amountOut)
        internal
        pure
        returns (uint256 amountIn)
    {
        // Ceiling division for tokenIn is maker-favoring and matches XYCSwap.
        return Math.ceilDiv(amountOut * balanceIn, balanceOut - amountOut);
    }
}
