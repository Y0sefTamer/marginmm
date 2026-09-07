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
 */
contract MarginMMSwapVMRouter is SwapVM, Opcodes {
    MarginMMRiskEngine public immutable riskEngine;

    error ZeroAddress();

    /**
     * @notice Initializes the custom router.
     * @dev Added `owner` to satisfy the SwapVM (Rescuable) base constructor.
     */
    constructor(
        address aqua,
        address weth,
        address riskEngine_,
        address owner,
        string memory name,
        string memory version
    ) SwapVM(aqua, weth, owner, name, version) Opcodes(aqua) {
        if (riskEngine_ == address(0)) revert ZeroAddress();
        riskEngine = MarginMMRiskEngine(riskEngine_);
    }

    /**
     * @notice The Custom MarginMM Instruction: Clamps available output liquidity to the safe qMax.
     * @dev Mutates `ctx` in-place as expected by 1inch's function pointer definition.
     */
    function _executeCapacityClamp(Context memory ctx, bytes calldata /* args */) internal view {
        uint256 qMax = riskEngine.safeCapacity(ctx.query.maker, ctx.query.tokenOut);
        ctx.swap.balanceOut = Math.min(ctx.swap.balanceOut, qMax);
    }

    /**
     * @notice Overrides the official opcode dispatcher to include MarginMM's clamp instruction.
     * @dev Must be `pure` and strictly match `function(Context memory, bytes calldata) internal[] memory`.
     */
    function _instructions() internal pure override returns (function(Context memory, bytes calldata) internal[] memory opcodesList) {
        function(Context memory, bytes calldata) internal[] memory standardOpcodes = super._instructions();
        
        opcodesList = new function(Context memory, bytes calldata) internal[](standardOpcodes.length + 1);
        
        for (uint256 i = 0; i < standardOpcodes.length; i++) {
            opcodesList[i] = standardOpcodes[i];
        }
        
        opcodesList[standardOpcodes.length] = _executeCapacityClamp;
    }
}