// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

// Minimal, static-return ABIs: deliberately never decode Pool.getReserveData,
// whose legacy/current tuple layouts differ between Aave versions.
interface IScenarioPool {
    function ADDRESSES_PROVIDER() external view returns (address);
    function getUserEMode(address user) external view returns (uint256);
    function getUserConfiguration(address user) external view returns (uint256);
    function getReserveAddressById(uint16 id) external view returns (address);
    function getReservesList() external view returns (address[] memory);
    function getReserveNormalizedIncome(address asset) external view returns (uint256);
    function getUserAccountData(address user)
        external
        view
        returns (uint256, uint256, uint256, uint256, uint256, uint256);
}

interface IScenarioProvider {
    function getPool() external view returns (address);
    function getPriceOracle() external view returns (address);
    function getPoolDataProvider() external view returns (address);
}

interface IScenarioOracle {
    function ADDRESSES_PROVIDER() external view returns (address);
    function getAssetPrice(address asset) external view returns (uint256);
}

interface IScenarioDataProvider {
    function ADDRESSES_PROVIDER() external view returns (address);
    function getReserveTokensAddresses(address asset) external view returns (address, address, address);
    function getReserveConfigurationData(address asset)
        external
        view
        returns (uint256, uint256, uint256, uint256, uint256, bool, bool, bool, bool, bool);
    function getUserReserveData(address asset, address user)
        external
        view
        returns (uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint40, bool);
    function getPaused(address asset) external view returns (bool);
    function getDebtCeiling(address asset) external view returns (uint256);
    function getSiloedBorrowing(address asset) external view returns (bool);
}

interface IScenarioToken {
    function UNDERLYING_ASSET_ADDRESS() external view returns (address);
    function POOL() external view returns (address);
    function decimals() external view returns (uint8);
}

/// @notice WETH/USDC collateral and variable USDC debt lens for Aave V3 Ethereum.
/// @dev Pure inputs are simulations, not authenticated account state. Settlement must
///      take a fresh snapshot and enforce its own stress floor after actual transfers.
///      Frozen reserves are allowed: Aave's validateTransfer checks pause, not freeze.
///      Both collateral flags must already be enabled; no automatic enablement is assumed.
contract MarginMMScenarioEngine {
    uint256 public constant WAD = 1e18;
    uint256 public constant RAY = 1e27;
    uint256 public constant BPS = 10_000;
    address public constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address public constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address public constant MAINNET_POOL = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2;
    address public constant MAINNET_PROVIDER = 0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e;

    IScenarioPool public immutable pool;
    IScenarioDataProvider public immutable dataProvider;
    IScenarioOracle public immutable oracle;
    address public immutable aWETH;
    address public immutable aUSDC;

    struct State {
        uint256 wethAmount;
        uint256 usdcAmount;
        uint256 usdcDebt;
        uint256 wethLT;
        uint256 usdcLT;
        uint256 wethPrice;
        uint256 usdcPrice;
        uint256 wethIndex;
        uint256 usdcIndex;
        uint256 aaveHF;
    }

    error InvalidMarket();
    error InvalidToken(address asset);
    error UnsupportedEMode(uint256 category);
    error UnsupportedPosition(address asset);
    error UnsupportedReserve(address asset);
    error InvalidState();
    error InsufficientOutputBalance();

    constructor(address pool_, address dataProvider_, address oracle_) {
        pool = IScenarioPool(pool_);
        dataProvider = IScenarioDataProvider(dataProvider_);
        oracle = IScenarioOracle(oracle_);
        _validateMarket();
        (aWETH,,) = dataProvider.getReserveTokensAddresses(WETH);
        (aUSDC,,) = dataProvider.getReserveTokensAddresses(USDC);
        _validateToken(WETH, aWETH, 18);
        _validateToken(USDC, aUSDC, 6);
    }

    function snapshot(address maker) external view returns (State memory s) {
        _validateMarket();
        uint256 category = pool.getUserEMode(maker);
        if (category != 0) revert UnsupportedEMode(category);
        bool usdcBorrowing = _validateUserConfiguration(maker);
        // The canonical Aave user-configuration bitmap above is the authority for
        // every active collateral/debt reserve. Reading all listed reserves again
        // adds no protection and makes one snapshot unnecessarily expensive.
        (
            uint256 wethBalance,
            uint256 wethStable,
            uint256 wethDebt,
            uint256 wethPrincipal,
            uint256 wethScaled,,,,
            bool wethCollateral
        ) = dataProvider.getUserReserveData(WETH, maker);
        if (!wethCollateral || wethStable != 0 || wethDebt != 0 || wethPrincipal != 0 || wethScaled != 0) {
            revert UnsupportedPosition(WETH);
        }
        (
            uint256 usdcBalance,
            uint256 usdcStable,
            uint256 usdcDebt,
            uint256 usdcPrincipal,
            uint256 usdcScaled,,,,
            bool usdcCollateral
        ) = dataProvider.getUserReserveData(USDC, maker);
        if (
            !usdcCollateral || usdcStable != 0 || usdcPrincipal != 0
                || ((usdcDebt != 0 || usdcScaled != 0) != usdcBorrowing)
        ) revert UnsupportedPosition(USDC);
        s.wethAmount = wethBalance;
        s.usdcAmount = usdcBalance;
        s.usdcDebt = usdcDebt;
        s.wethLT = _validateReserve(WETH, aWETH, 18);
        s.usdcLT = _validateReserve(USDC, aUSDC, 6);
        s.wethPrice = oracle.getAssetPrice(WETH);
        s.usdcPrice = oracle.getAssetPrice(USDC);
        s.wethIndex = pool.getReserveNormalizedIncome(WETH);
        s.usdcIndex = pool.getReserveNormalizedIncome(USDC);
        (,,,,, s.aaveHF) = pool.getUserAccountData(maker);
        _validateState(s);
    }

    /// @notice Minimum HF across (10000,10000), (8000,10000),
    ///         (7000,10000), (10000,9500), ordered as (WETH, USDC) price BPS.
    function stressHF(State memory s) public pure returns (uint256 worst) {
        _validateState(s);
        if (s.usdcDebt == 0) return type(uint256).max;
        worst = _scenarioHF(s, 10_000, 10_000);
        worst = Math.min(worst, _scenarioHF(s, 8_000, 10_000));
        worst = Math.min(worst, _scenarioHF(s, 7_000, 10_000));
        worst = Math.min(worst, _scenarioHF(s, 10_000, 9_500));
    }

    /// @notice Conservative same-transaction preview: input traverses two aToken hops.
    /// @dev Incoming credit = max(0, amountIn - 2*ceil(index/RAY) - 2).
    ///      Outgoing debit = amountOut + ceil(index/RAY) + 1, capped at balance.
    ///      Zero legs have zero effect. An impossible nominal output reverts.
    ///      Fresh snapshots are required if time, prices or account state changes.
    function preview(State memory s, bool wethIn, uint256 amountIn, uint256 amountOut) external pure returns (uint256) {
        _validateState(s);
        if (amountIn > type(uint128).max || amountOut > type(uint128).max) revert InvalidState();
        uint256 inputIndex = wethIn ? s.wethIndex : s.usdcIndex;
        uint256 outputIndex = wethIn ? s.usdcIndex : s.wethIndex;
        uint256 loss = 2 * Math.ceilDiv(inputIndex, RAY) + 2;
        uint256 credit = amountIn > loss ? amountIn - loss : 0;
        uint256 outBalance = wethIn ? s.usdcAmount : s.wethAmount;
        if (amountOut > outBalance) revert InsufficientOutputBalance();
        uint256 debit = amountOut == 0 ? 0 : Math.min(outBalance, amountOut + Math.ceilDiv(outputIndex, RAY) + 1);
        if (wethIn) {
            s.wethAmount += credit;
            s.usdcAmount -= debit;
        } else {
            s.usdcAmount += credit;
            s.wethAmount -= debit;
        }
        return stressHF(s);
    }

    function _scenarioHF(State memory s, uint256 wethBps, uint256 usdcBps) internal pure returns (uint256) {
        (uint256 collateral, uint256 debt) = _scenarioValues(s, wethBps, usdcBps);
        return Math.mulDiv(collateral, WAD, debt);
    }

    function _scenarioValues(State memory s, uint256 wethBps, uint256 usdcBps)
        internal
        pure
        returns (uint256 collateral, uint256 debt)
    {
        // Identical stressed USDC price numerator for BOTH sides; only rounding differs.
        uint256 wethBase = Math.mulDiv(s.wethAmount, s.wethPrice * wethBps, 1e18 * BPS);
        uint256 usdcBase = Math.mulDiv(s.usdcAmount, s.usdcPrice * usdcBps, 1e6 * BPS);
        collateral = Math.mulDiv(wethBase, s.wethLT, BPS) + Math.mulDiv(usdcBase, s.usdcLT, BPS);
        debt = Math.mulDiv(s.usdcDebt, s.usdcPrice * usdcBps, 1e6 * BPS, Math.Rounding.Ceil);
    }

    function _validateMarket() internal view {
        // 31337 is the packaged local Anvil demo. Every canonical contract and
        // provider relationship is still verified below, so a plain local chain
        // without the pinned Mainnet state fails closed.
        if (
            (block.chainid != 1 && block.chainid != 31_337) || address(pool) != MAINNET_POOL
                || pool.ADDRESSES_PROVIDER() != MAINNET_PROVIDER
                || dataProvider.ADDRESSES_PROVIDER() != MAINNET_PROVIDER
                || oracle.ADDRESSES_PROVIDER() != MAINNET_PROVIDER
        ) revert InvalidMarket();
        IScenarioProvider provider = IScenarioProvider(MAINNET_PROVIDER);
        if (
            provider.getPool() != address(pool) || provider.getPriceOracle() != address(oracle)
                || provider.getPoolDataProvider() != address(dataProvider)
        ) revert InvalidMarket();
    }

    function _validateToken(address asset, address aToken, uint256 decimals_) internal view {
        (address official,, address debtToken) = dataProvider.getReserveTokensAddresses(asset);
        if (
            aToken == address(0) || aToken != official || debtToken == address(0)
                || IScenarioToken(aToken).UNDERLYING_ASSET_ADDRESS() != asset
                || IScenarioToken(aToken).POOL() != address(pool)
                || IScenarioToken(debtToken).UNDERLYING_ASSET_ADDRESS() != asset
                || IScenarioToken(debtToken).POOL() != address(pool) || IScenarioToken(aToken).decimals() != decimals_
                || IScenarioToken(debtToken).decimals() != decimals_ || IScenarioToken(asset).decimals() != decimals_
        ) revert InvalidToken(asset);
    }

    function _validateReserve(address asset, address aToken, uint256 decimals_) internal view returns (uint256 lt) {
        _validateToken(asset, aToken, decimals_);
        (uint256 decimals,, uint256 threshold,,, bool collateral,,, bool active,) =
            dataProvider.getReserveConfigurationData(asset);
        // Freeze prevents new supplies/borrows, but not aToken transfers. Existing
        // variable debt is allowed even when new borrowing has been disabled.
        if (
            decimals != decimals_ || !active || !collateral || threshold == 0 || threshold > BPS
                || dataProvider.getPaused(asset) || dataProvider.getDebtCeiling(asset) != 0
                || dataProvider.getSiloedBorrowing(asset)
        ) revert UnsupportedReserve(asset);
        return threshold;
    }

    function _validateUserConfiguration(address maker) internal view returns (bool usdcBorrowing) {
        uint256 config = pool.getUserConfiguration(maker);
        bool wethCollateral;
        bool usdcCollateral;
        for (uint16 id; config != 0; ++id) {
            uint256 flags = config & 3;
            if (flags != 0) {
                // Reserve list indices are NOT reserve IDs after a reserve is dropped.
                address asset = pool.getReserveAddressById(id);
                if (asset == WETH && flags == 2) {
                    wethCollateral = true;
                } else if (asset == USDC && flags & 2 != 0) {
                    usdcCollateral = true;
                    usdcBorrowing = flags & 1 != 0;
                } else {
                    revert UnsupportedPosition(asset);
                }
            }
            config >>= 2;
        }
        if (!wethCollateral || !usdcCollateral) revert UnsupportedPosition(address(0));
    }

    function _validateState(State memory s) internal pure {
        // These explicit domains bound collateral*WAD below 2^234, including the
        // two-asset sum. mulDiv handles intermediate products; no wrap/saturation credit.
        if (
            s.wethAmount > type(uint128).max || s.usdcAmount > type(uint128).max || s.usdcDebt > type(uint128).max
                || s.wethPrice == 0 || s.usdcPrice == 0 || s.wethPrice > type(uint64).max
                || s.usdcPrice > type(uint64).max || s.wethLT == 0 || s.wethLT > BPS || s.usdcLT == 0 || s.usdcLT > BPS
                || s.wethIndex < RAY || s.usdcIndex < RAY || s.wethIndex > type(uint128).max
                || s.usdcIndex > type(uint128).max
        ) revert InvalidState();
    }
}
