// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {MarginMMRiskEngine} from "./MarginMMRiskEngine.sol";
import {SwapVM} from "@1inch/swap-vm/src/SwapVM.sol";
import {Opcodes} from "@1inch/swap-vm/src/opcodes/Opcodes.sol";
import {Context} from "@1inch/swap-vm/src/libs/VM.sol";

/**
 * @title MarginMM SwapVM Router
 * @notice Custom router for 1inch SwapVM that integrates MarginMM's physical safety capacity (qMax).
 * @dev Inherits the official 1inch execution environment and extends the opcode array with a capacity clamp.
 */
contract MarginMMSwapVMRouter is SwapVM, Opcodes {
    MarginMMRiskEngine public immutable riskEngine;

    error ZeroAddress();

    /**
     * @notice Initializes the custom router with 1inch addresses and MarginMM's risk engine.
     */
    constructor(address aqua, address weth, address riskEngine_, string memory name, string memory version)
        SwapVM(aqua, weth, name, version)
        Opcodes(aqua)
    {
        if (riskEngine_ == address(0)) revert ZeroAddress();
        riskEngine = MarginMMRiskEngine(riskEngine_);
    }

    /**
     * @notice The Custom MarginMM Instruction: Clamps available output liquidity to the safe qMax.
     * @dev Executes immediately before partial-fill curves (like XYC) to enforce Aave safety bounds.
     */
    function _executeCapacityClamp(
        Context memory ctx,
        bytes calldata /* args */
    )
        internal
        view
        returns (Context memory)
    {
        // Fetch safe capacity from Aave
        uint256 qMax = riskEngine.safeCapacity(ctx.query.maker, ctx.query.tokenOut);

        // Clamp the SwapVM balanceOut register. This forces subsequent opcodes to execute a Partial Fill if qMax is hit.
        ctx.swap.balanceOut = Math.min(ctx.swap.balanceOut, qMax);

        return ctx;
    }

    /**
     * @notice Overrides the official opcode dispatcher to include MarginMM's clamp instruction.
     * @dev Appends `_executeCapacityClamp` to the array of standard 1inch opcodes.
     */
    function _instructions()
        internal
        view
        override
        returns (function(Context memory, bytes calldata) internal view returns (Context memory)[] memory opcodesList)
    {
        // Fetch the standard 1inch opcodes
        function(Context memory, bytes calldata) internal view returns (Context memory)[] memory standardOpcodes =
            super._instructions();

        // Create a new array with space for our custom instruction
        opcodesList = new function(Context memory, bytes calldata)
        internal
        view returns (Context memory)[](standardOpcodes.length + 1);

        // Copy standard opcodes
        for (uint256 i = 0; i < standardOpcodes.length; i++) {
            opcodesList[i] = standardOpcodes[i];
        }

        // Append MarginMM capacity clamp as the final opcode index
        opcodesList[standardOpcodes.length] = _executeCapacityClamp;
    }
}
