// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {MarginMMRiskEngine} from "./MarginMMRiskEngine.sol";

/**
 * @title SwapVM Context Mocks
 * @dev Minimal representations of 1inch SwapVM context structs.
 * In the final deployment with the official 1inch dependency, these will be imported directly from the SwapVM library.
 */
struct SwapQuery {
    address maker;
    address tokenOut;
    address tokenIn;
    uint256 amountIn;
}

struct SwapState {
    uint256 balanceOut;
    uint256 balanceIn;
}

struct Context {
    SwapQuery query;
    SwapState swap;
}

/**
 * @title MarginMM SwapVM Instruction
 * @notice Custom SwapVM opcode implementation that enforces MarginMM's partial-fill safety bounds.
 * @dev Designed to execute immediately before the standard SwapVM constant-product/concentrated liquidity curve.
 */
contract MarginMMInstruction {
    MarginMMRiskEngine public immutable riskEngine;

    error ZeroAddress();

    /**
     * @notice Initializes the instruction with the MarginMM Risk Engine.
     */
    constructor(address riskEngine_) {
        if (riskEngine_ == address(0)) revert ZeroAddress();
        riskEngine = MarginMMRiskEngine(riskEngine_);
    }

    /**
     * @notice Executes the MarginMM capacity clamp on the active SwapVM context.
     * @dev Mutates `ctx.swap.balanceOut` in-place, restricting the output to the safe physical capacity (qMax) derived from live Aave state.
     * @param ctx The active SwapVM execution context containing the maker's query and current swap state.
     * @return The updated context with the safely clamped balanceOut.
     */
    function executeCapacityClamp(Context memory ctx) public view returns (Context memory) {
        // Step 1: Fetch the physical risk limit (qMax) from Aave via the Risk Engine
        uint256 qMax = riskEngine.safeCapacity(ctx.query.maker, ctx.query.tokenOut);

        // Step 2: Clamp the SwapVM output balance.
        // If qMax is less than the current balanceOut, this forces a Partial Fill execution.
        ctx.swap.balanceOut = Math.min(ctx.swap.balanceOut, qMax);

        return ctx;
    }
}
