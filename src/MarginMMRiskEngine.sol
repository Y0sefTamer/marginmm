// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPool} from "@aave/core-v3/contracts/interfaces/IPool.sol";
import {IAToken} from "@aave/core-v3/contracts/interfaces/IAToken.sol";
import {IPoolDataProvider} from "@aave/core-v3/contracts/interfaces/IPoolDataProvider.sol";
import {IPriceOracleGetter} from "@aave/core-v3/contracts/interfaces/IPriceOracleGetter.sol";
import {MarginMMMath} from "./libraries/MarginMMMath.sol";

/// @title MarginMMRiskEngine
/// @notice Reads live Aave V3 state and computes a conservative stressed health factor and qMax.
/// @dev V1 intentionally rejects eMode because reserve-level LT may be overridden by eMode configuration.
contract MarginMMRiskEngine {
    uint256 public constant WAD = 1e18;
    uint256 public constant BPS = 10_000;

    IPool public immutable pool;
    IPoolDataProvider public immutable dataProvider;
    IPriceOracleGetter public immutable oracle;
    MarginMMMath.StressConfig public stressConfig;

    error ZeroAddress();
    error UnsupportedEMode(uint256 categoryId);
    error NotAaveAToken(address token);
    error InactiveReserve(address underlying);
    error InvalidStressConfig();

    struct AccountSnapshot {
        uint256 totalCollateralBase;
        uint256 totalDebtBase;
        uint256 currentLiquidationThresholdBps;
        uint256 currentHF;
        uint256 weightedCollateralBase;
        uint256 stressHF;
    }

    struct ReserveSnapshot {
        address aToken;
        address underlying;
        uint256 aTokenBalance;
        uint256 decimals;
        uint256 price;
        uint256 liquidationThresholdBps;
        bool reserveCollateralEnabled;
        bool userUsesAsCollateral;
        bool isActive;
        bool isFrozen;
    }

    struct CapacityQuote {
        uint256 qMax;
        uint256 requestedOut;
        uint256 executableOut;
        bool partialFill;
        AccountSnapshot account;
        ReserveSnapshot reserveOut;
    }

    constructor(
        address pool_,
        address dataProvider_,
        address oracle_,
        uint256 minStressHF_,
        uint256 collateralStressBps_,
        uint256 debtStressBps_
    ) {
        if (pool_ == address(0) || dataProvider_ == address(0) || oracle_ == address(0)) {
            revert ZeroAddress();
        }

        pool = IPool(pool_);
        dataProvider = IPoolDataProvider(dataProvider_);
        oracle = IPriceOracleGetter(oracle_);
        stressConfig = MarginMMMath.StressConfig({
            minStressHF: minStressHF_, collateralStressBps: collateralStressBps_, debtStressBps: debtStressBps_
        });
        _validateStoredConfig();
    }

    /// @notice Snapshot Aave's current account state plus MarginMM's stressed HF.
    function accountSnapshot(address user) public view returns (AccountSnapshot memory snapshot) {
        _requireNoEMode(user);

        (uint256 totalCollateralBase, uint256 totalDebtBase,, uint256 currentLiquidationThreshold,, uint256 currentHF) =
            pool.getUserAccountData(user);

        uint256 weighted = MarginMMMath.weightedCollateralBase(totalCollateralBase, currentLiquidationThreshold);

        snapshot = AccountSnapshot({
            totalCollateralBase: totalCollateralBase,
            totalDebtBase: totalDebtBase,
            currentLiquidationThresholdBps: currentLiquidationThreshold,
            currentHF: currentHF,
            weightedCollateralBase: weighted,
            stressHF: MarginMMMath.stressHF(weighted, totalDebtBase, stressConfig)
        });
    }

    /// @notice Resolve and validate an Aave aToken against the configured market.
    function reserveSnapshot(address user, address aToken) public view returns (ReserveSnapshot memory snapshot) {
        address underlying;
        try IAToken(aToken).UNDERLYING_ASSET_ADDRESS() returns (address asset) {
            underlying = asset;
        } catch {
            revert NotAaveAToken(aToken);
        }

        (address officialAToken,,) = dataProvider.getReserveTokensAddresses(underlying);
        if (officialAToken != aToken || officialAToken == address(0)) revert NotAaveAToken(aToken);

        (
            uint256 decimals,,
            uint256 liquidationThreshold,,,
            bool reserveCollateralEnabled,,,
            bool isActive,
            bool isFrozen
        ) = dataProvider.getReserveConfigurationData(underlying);

        // A frozen reserve may still contain transferable collateral; inactivity is the hard failure here.
        if (!isActive) revert InactiveReserve(underlying);

        (uint256 currentATokenBalance,,,,,,,, bool usageAsCollateralEnabled) =
            dataProvider.getUserReserveData(underlying, user);

        snapshot = ReserveSnapshot({
            aToken: aToken,
            underlying: underlying,
            aTokenBalance: currentATokenBalance,
            decimals: decimals,
            price: oracle.getAssetPrice(underlying),
            liquidationThresholdBps: liquidationThreshold,
            reserveCollateralEnabled: reserveCollateralEnabled,
            userUsesAsCollateral: usageAsCollateralEnabled,
            isActive: isActive,
            isFrozen: isFrozen
        });
    }

    /// @notice Maximum aToken amount that can leave the maker while preserving minStressHF.
    /// @dev qMax ignores incoming collateral by design, making it safe before/after the input leg settles.
    function safeCapacity(address maker, address aTokenOut) public view returns (uint256 qMax) {
        AccountSnapshot memory account = accountSnapshot(maker);
        ReserveSnapshot memory outReserve = reserveSnapshot(maker, aTokenOut);

        if (!outReserve.userUsesAsCollateral || !outReserve.reserveCollateralEnabled) {
            return outReserve.aTokenBalance;
        }

        qMax = MarginMMMath.safeCapacity(
            account.weightedCollateralBase,
            account.totalDebtBase,
            outReserve.aTokenBalance,
            outReserve.price,
            outReserve.decimals,
            outReserve.liquidationThresholdBps,
            stressConfig
        );
    }

    /// @notice Clamp a requested output amount to qMax (the Partial Fill primitive).
    function quoteCapacity(address maker, address aTokenOut, uint256 requestedOut)
        external
        view
        returns (CapacityQuote memory quote)
    {
        AccountSnapshot memory account = accountSnapshot(maker);
        ReserveSnapshot memory outReserve = reserveSnapshot(maker, aTokenOut);

        uint256 qMax = outReserve.aTokenBalance;
        if (outReserve.userUsesAsCollateral && outReserve.reserveCollateralEnabled) {
            qMax = MarginMMMath.safeCapacity(
                account.weightedCollateralBase,
                account.totalDebtBase,
                outReserve.aTokenBalance,
                outReserve.price,
                outReserve.decimals,
                outReserve.liquidationThresholdBps,
                stressConfig
            );
        }

        uint256 executable = Math.min(requestedOut, qMax);
        quote = CapacityQuote({
            qMax: qMax,
            requestedOut: requestedOut,
            executableOut: executable,
            partialFill: executable < requestedOut,
            account: account,
            reserveOut: outReserve
        });
    }

    /// @notice Preview final stressed HF for an aToken -> aToken trade.
    /// @dev Incoming collateral is credited only when it is already enabled as collateral for the maker.
    ///      This is reporting/simulation. qMax remains the stricter outgoing-only bound.
    function previewPostTrade(address maker, address aTokenIn, uint256 amountIn, address aTokenOut, uint256 amountOut)
        external
        view
        returns (uint256 postTradeStressHF, bool meetsStressGuard)
    {
        AccountSnapshot memory account = accountSnapshot(maker);
        ReserveSnapshot memory inReserve = reserveSnapshot(maker, aTokenIn);
        ReserveSnapshot memory outReserve = reserveSnapshot(maker, aTokenOut);

        postTradeStressHF = MarginMMMath.previewPostTradeStressHF(
            account.weightedCollateralBase,
            account.totalDebtBase,
            amountOut,
            outReserve.price,
            outReserve.decimals,
            outReserve.liquidationThresholdBps,
            outReserve.userUsesAsCollateral && outReserve.reserveCollateralEnabled,
            amountIn,
            inReserve.price,
            inReserve.decimals,
            inReserve.liquidationThresholdBps,
            inReserve.userUsesAsCollateral && inReserve.reserveCollateralEnabled,
            stressConfig
        );
        meetsStressGuard = postTradeStressHF >= stressConfig.minStressHF;
    }

    function _requireNoEMode(address user) internal view {
        uint256 categoryId = pool.getUserEMode(user);
        if (categoryId != 0) revert UnsupportedEMode(categoryId);
    }

    function _validateStoredConfig() internal view {
        MarginMMMath.StressConfig memory config = stressConfig;
        if (
            config.minStressHF < WAD || config.collateralStressBps == 0 || config.collateralStressBps > BPS
                || config.debtStressBps < BPS || config.debtStressBps > 20_000
        ) revert InvalidStressConfig();
    }
}
