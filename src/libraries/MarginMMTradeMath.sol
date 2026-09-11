// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {XYCSwapMath} from "@1inch/swap-vm/src/libs/XYCSwapMath.sol";
import {MarginMMScenarioEngine} from "../MarginMMScenarioEngine.sol";

/// @notice Composition-aware capacity solver over the pinned SwapVM XYC curve.
/// @dev All capped inputs use the same maker-favoring exact-out rounding as XYCSwap.
library MarginMMTradeMath {
    uint256 internal constant RAY = 1e27;

    struct Result {
        uint256 baseAmountOut;
        uint256 qMax;
        uint256 actualAmountIn;
        uint256 stressHFBefore;
        uint256 stressHFAfter;
        bool liquidityCapped;
        bool riskCapped;
    }

    error InvalidCurveResult();

    function solve(
        MarginMMScenarioEngine riskEngine,
        MarginMMScenarioEngine.State memory state,
        bool wethIn,
        uint256 maxAmountIn,
        uint256 virtualBalanceIn,
        uint256 virtualBalanceOut,
        uint256 availableAmountOut,
        uint256 hardFloorStressHF,
        uint32 shockBps
    ) internal view returns (Result memory result) {
        result.stressHFBefore = riskEngine.stressHF(state, shockBps);
        result.stressHFAfter = result.stressHFBefore;
        if (maxAmountIn == 0) return result;
        result.baseAmountOut = XYCSwapMath.exactIn(virtualBalanceIn, virtualBalanceOut, maxAmountIn);
        if (result.baseAmountOut == 0) return result;
        if (result.stressHFBefore < hardFloorStressHF) return result;

        uint256 outputIndex = wethIn ? state.usdcIndex : state.wethIndex;
        uint256 outputBalance = wethIn ? state.usdcAmount : state.wethAmount;
        uint256 outputRoundingGuard = Math.ceilDiv(outputIndex, RAY) + 1;
        if (outputBalance <= outputRoundingGuard) return result;

        uint256 physicalCap = Math.min(availableAmountOut, outputBalance - outputRoundingGuard);
        uint256 candidate = Math.min(result.baseAmountOut, physicalCap);
        result.liquidityCapped = candidate < result.baseAmountOut;
        if (candidate == 0) return result;

        uint256 candidateInput = candidate == result.baseAmountOut
            ? maxAmountIn
            : XYCSwapMath.exactOut(virtualBalanceIn, virtualBalanceOut, candidate);
        if (candidateInput > maxAmountIn) revert InvalidCurveResult();
        uint256 candidateStress = riskEngine.preview(state, wethIn, candidateInput, candidate, shockBps);
        if (candidateStress >= hardFloorStressHF) {
            result.qMax = candidate;
            result.actualAmountIn = candidateInput;
            result.stressHFAfter = candidateStress;
            return result;
        }

        // With a safe starting state and an unsafe upper endpoint, the XYC/post-fill
        // collateral function has one safe prefix. Search that exact atomic boundary.
        uint256 low = 0;
        uint256 high = candidate;
        while (low < high) {
            uint256 midpoint = low + (high - low + 1) / 2;
            (bool safe,,) = _evaluate(
                riskEngine,
                state,
                wethIn,
                midpoint,
                maxAmountIn,
                virtualBalanceIn,
                virtualBalanceOut,
                hardFloorStressHF,
                shockBps
            );
            if (safe) low = midpoint;
            else high = midpoint - 1;
        }

        result.qMax = low;
        result.riskCapped = low < candidate;
        if (low == 0) return result;
        (, result.actualAmountIn, result.stressHFAfter) = _evaluate(
            riskEngine,
            state,
            wethIn,
            low,
            maxAmountIn,
            virtualBalanceIn,
            virtualBalanceOut,
            hardFloorStressHF,
            shockBps
        );
    }

    function _evaluate(
        MarginMMScenarioEngine riskEngine,
        MarginMMScenarioEngine.State memory state,
        bool wethIn,
        uint256 amountOut,
        uint256 maxAmountIn,
        uint256 virtualBalanceIn,
        uint256 virtualBalanceOut,
        uint256 hardFloorStressHF,
        uint32 shockBps
    ) private view returns (bool safe, uint256 amountIn, uint256 stressAfter) {
        amountIn = XYCSwapMath.exactOut(virtualBalanceIn, virtualBalanceOut, amountOut);
        if (amountIn > maxAmountIn) return (false, amountIn, 0);
        stressAfter = riskEngine.preview(state, wethIn, amountIn, amountOut, shockBps);
        safe = stressAfter >= hardFloorStressHF;
    }
}
