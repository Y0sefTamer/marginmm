// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {MarginMMScenarioEngine} from "../MarginMMScenarioEngine.sol";

/// @notice Conservative affine capacity at a live oracle reference price plus maker spread.
/// @dev Outgoing units are token base units. No floating point or iterative monotonicity assumption.
library MarginMMTradeMath {
    uint256 internal constant BPS = 10_000;
    uint256 internal constant RAY = 1e27;

    function inputFor(MarginMMScenarioEngine.State memory s, bool wethIn, uint256 out, uint256 spread)
        internal
        pure
        returns (uint256)
    {
        uint256 inPrice = wethIn ? s.wethPrice : s.usdcPrice;
        uint256 outPrice = wethIn ? s.usdcPrice : s.wethPrice;
        uint256 inUnit = wethIn ? 1e18 : 1e6;
        uint256 outUnit = wethIn ? 1e6 : 1e18;
        uint256 fair = Math.mulDiv(out, outPrice * inUnit, outUnit * inPrice, Math.Rounding.Ceil);
        return Math.mulDiv(fair, BPS + spread, BPS, Math.Rounding.Ceil);
    }

    function weighted(uint256 amount, uint256 price, uint256 unit, uint256 shock, uint256 lt)
        internal
        pure
        returns (uint256)
    {
        return Math.mulDiv(Math.mulDiv(amount, price, unit), shock * lt, BPS * BPS);
    }

    function capacity(MarginMMScenarioEngine.State memory s, bool wethIn, uint256 spread, uint256 floor)
        internal
        pure
        returns (uint256 result)
    {
        uint256 outBalance = wethIn ? s.usdcAmount : s.wethAmount;
        uint256 outGuard = Math.ceilDiv(wethIn ? s.usdcIndex : s.wethIndex, RAY) + 1;
        if (outBalance <= outGuard) return 0;
        result = outBalance - outGuard;
        if (s.usdcDebt == 0) return result;
        for (uint256 i; i < 4; ++i) {
            uint256 ws = i == 1 ? 8_000 : i == 2 ? 7_000 : BPS;
            uint256 us = i == 3 ? 9_500 : BPS;
            result = Math.min(result, scenarioCapacity(s, wethIn, spread, floor, ws, us));
        }
    }

    function scenarioCapacity(
        MarginMMScenarioEngine.State memory s,
        bool wethIn,
        uint256 spread,
        uint256 floor,
        uint256 ws,
        uint256 us
    ) internal pure returns (uint256) {
        uint256 collateral = weighted(s.wethAmount, s.wethPrice, 1e18, ws, s.wethLT)
            + weighted(s.usdcAmount, s.usdcPrice, 1e6, us, s.usdcLT);
        uint256 debt =
            Math.mulDiv(Math.mulDiv(s.usdcDebt, s.usdcPrice, 1e6, Math.Rounding.Ceil), us, BPS, Math.Rounding.Ceil);
        uint256 required = Math.mulDiv(debt, floor, 1e18, Math.Rounding.Ceil);
        // Reserve a fixed loss allowance for both aToken input hops, the output hop,
        // and the floors at each base-value/shock/LT calculation. This keeps the bound
        // affine even when token/base conversions have discrete rounding steps.
        uint256 inGuard = 2 * Math.ceilDiv(wethIn ? s.wethIndex : s.usdcIndex, RAY) + 2;
        uint256 outGuard = Math.ceilDiv(wethIn ? s.usdcIndex : s.wethIndex, RAY) + 1;
        uint256 inUnit = wethIn ? 1e18 : 1e6;
        uint256 outUnit = wethIn ? 1e6 : 1e18;
        uint256 inPrice = wethIn ? s.wethPrice : s.usdcPrice;
        uint256 outPrice = wethIn ? s.usdcPrice : s.wethPrice;
        uint256 inWeight = wethIn ? ws * s.wethLT : us * s.usdcLT;
        uint256 outWeight = wethIn ? us * s.usdcLT : ws * s.wethLT;
        uint256 allowance = Math.mulDiv(inGuard, inPrice, inUnit, Math.Rounding.Ceil)
            + Math.mulDiv(outGuard, outPrice, outUnit, Math.Rounding.Ceil) + 8;
        if (collateral <= required || collateral - required <= allowance) return 0;
        uint256 headroom = collateral - required - allowance;
        uint256 debitSlope = outWeight * BPS;
        uint256 creditSlope = inWeight * (BPS + spread);
        if (creditSlope >= debitSlope) return type(uint256).max;
        uint256 maxBase = Math.mulDiv(headroom, BPS * BPS * BPS, debitSlope - creditSlope);
        return Math.mulDiv(maxBase, outUnit, outPrice);
    }
}
