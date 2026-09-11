// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {
    MarginMMScenarioEngine,
    IScenarioPool,
    IScenarioProvider,
    IScenarioOracle,
    IScenarioDataProvider,
    IScenarioToken
} from "../src/MarginMMScenarioEngine.sol";

interface IScenarioPoolActions {
    function supply(address asset, uint256 amount, address user, uint16 referral) external;
    function borrow(address asset, uint256 amount, uint256 mode, uint16 referral, address user) external;
    function setUserUseReserveAsCollateral(address asset, bool enabled) external;
    function setUserEMode(uint8 category) external;
}

interface IScenarioWETH {
    function deposit() external payable;
}

contract ScenarioHarness is MarginMMScenarioEngine {
    constructor(address p, address d, address o) MarginMMScenarioEngine(p, d, o) {}

    function scenarioValues(State memory s, uint256 wethBps, uint256 usdcBps)
        external
        pure
        returns (uint256 collateral, uint256 debt)
    {
        _validateState(s);
        require(wethBps > 0 && wethBps <= BPS && usdcBps > 0 && usdcBps <= BPS);
        return _scenarioValues(s, wethBps, usdcBps);
    }
}

abstract contract ScenarioAddresses is Test {
    address internal constant POOL = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2;
    address internal constant PROVIDER = 0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e;
    address internal constant DATA = 0x0a16f2FCC0D44FaE41cc54e079281D84A363bECD;
    address internal constant ORACLE = 0x54586bE62E3c3580375aE3723C145253060Ca0C2;
    address internal constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address internal constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal constant AWETH = 0x4d5F47FA6A74757f35C14fD3a6Ef8E3C9BC514E8;
    address internal constant AUSDC = 0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c;
    address internal constant OTHER = 0x6B175474E89094C44Da98b954EedeAC495271d0F;
    uint256 internal constant RAY = 1e27;
    uint32 internal constant ACTIVE_SHOCK_BPS = 1_240;
    ScenarioHarness internal engine;

    function _state() internal pure returns (MarginMMScenarioEngine.State memory s) {
        s = MarginMMScenarioEngine.State(10e18, 50_000e6, 40_000e6, 8_000, 8_500, 3_000e8, 1e8, 11e26, 12e26, 1.6625e18);
    }
}

contract MarginMMScenarioEngineTest is ScenarioAddresses {
    address internal constant MAKER = address(0xBEEF);
    address internal constant DWETH = address(0xD001);
    address internal constant DUSDC = address(0xD002);

    function setUp() public {
        vm.chainId(1);
        _mockAddress(POOL, abi.encodeCall(IScenarioPool.ADDRESSES_PROVIDER, ()), PROVIDER);
        _mockAddress(DATA, abi.encodeCall(IScenarioDataProvider.ADDRESSES_PROVIDER, ()), PROVIDER);
        _mockAddress(ORACLE, abi.encodeCall(IScenarioOracle.ADDRESSES_PROVIDER, ()), PROVIDER);
        _mockAddress(PROVIDER, abi.encodeCall(IScenarioProvider.getPool, ()), POOL);
        _mockAddress(PROVIDER, abi.encodeCall(IScenarioProvider.getPriceOracle, ()), ORACLE);
        _mockAddress(PROVIDER, abi.encodeCall(IScenarioProvider.getPoolDataProvider, ()), DATA);
        _mockTokens(WETH, AWETH, DWETH, 18);
        _mockTokens(USDC, AUSDC, DUSDC, 6);
        _mockReserve(WETH, 18, 8_000, true, false, true);
        _mockReserve(USDC, 6, 8_500, true, false, true);
        _mockUint(POOL, abi.encodeCall(IScenarioPool.getUserEMode, (MAKER)), 0);
        // IDs deliberately have holes; getReservesList indices cannot decode this bitmap.
        _mockUint(POOL, abi.encodeCall(IScenarioPool.getUserConfiguration, (MAKER)), 2 | (3 << 6));
        _mockAddress(POOL, abi.encodeCall(IScenarioPool.getReserveAddressById, (uint16(0))), WETH);
        _mockAddress(POOL, abi.encodeCall(IScenarioPool.getReserveAddressById, (uint16(3))), USDC);
        _mockAddress(POOL, abi.encodeCall(IScenarioPool.getReserveAddressById, (uint16(7))), OTHER);
        address[] memory list = new address[](3);
        list[0] = WETH;
        list[1] = OTHER;
        list[2] = USDC;
        vm.mockCall(POOL, abi.encodeCall(IScenarioPool.getReservesList, ()), abi.encode(list));
        _mockUser(WETH, 10e18, 0, 0, 0, 0, true);
        _mockUser(USDC, 50_000e6, 0, 40_000e6, 0, 39_000e6, true);
        _mockUser(OTHER, 0, 0, 0, 0, 0, false);
        _mockUint(ORACLE, abi.encodeCall(IScenarioOracle.getAssetPrice, (WETH)), 3_000e8);
        _mockUint(ORACLE, abi.encodeCall(IScenarioOracle.getAssetPrice, (USDC)), 1e8);
        _mockUint(POOL, abi.encodeCall(IScenarioPool.getReserveNormalizedIncome, (WETH)), 11e26);
        _mockUint(POOL, abi.encodeCall(IScenarioPool.getReserveNormalizedIncome, (USDC)), 12e26);
        vm.mockCall(
            POOL,
            abi.encodeCall(IScenarioPool.getUserAccountData, (MAKER)),
            abi.encode(uint256(80_000e8), uint256(40_000e8), uint256(0), uint256(8_312), uint256(0), uint256(1.6625e18))
        );
        engine = new ScenarioHarness(POOL, DATA, ORACLE);
    }

    function _mockAddress(address target, bytes memory callData, address result) internal {
        vm.mockCall(target, callData, abi.encode(result));
    }

    function _mockUint(address target, bytes memory callData, uint256 result) internal {
        vm.mockCall(target, callData, abi.encode(result));
    }

    function _mockTokens(address asset, address aToken, address debtToken, uint8 decimals_) internal {
        vm.mockCall(
            DATA,
            abi.encodeCall(IScenarioDataProvider.getReserveTokensAddresses, (asset)),
            abi.encode(aToken, address(0), debtToken)
        );
        _mockAddress(aToken, abi.encodeCall(IScenarioToken.UNDERLYING_ASSET_ADDRESS, ()), asset);
        _mockAddress(debtToken, abi.encodeCall(IScenarioToken.UNDERLYING_ASSET_ADDRESS, ()), asset);
        _mockAddress(aToken, abi.encodeCall(IScenarioToken.POOL, ()), POOL);
        _mockAddress(debtToken, abi.encodeCall(IScenarioToken.POOL, ()), POOL);
        _mockUint(asset, abi.encodeCall(IScenarioToken.decimals, ()), decimals_);
        _mockUint(aToken, abi.encodeCall(IScenarioToken.decimals, ()), decimals_);
        _mockUint(debtToken, abi.encodeCall(IScenarioToken.decimals, ()), decimals_);
    }

    function _mockReserve(address asset, uint256 decimals_, uint256 lt, bool active, bool frozen, bool collateral)
        internal
    {
        vm.mockCall(
            DATA,
            abi.encodeCall(IScenarioDataProvider.getReserveConfigurationData, (asset)),
            abi.encode(
                decimals_, uint256(7_000), lt, uint256(10_500), uint256(1_000), collateral, true, false, active, frozen
            )
        );
        _mockUint(DATA, abi.encodeCall(IScenarioDataProvider.getPaused, (asset)), 0);
        _mockUint(DATA, abi.encodeCall(IScenarioDataProvider.getDebtCeiling, (asset)), 0);
        _mockUint(DATA, abi.encodeCall(IScenarioDataProvider.getSiloedBorrowing, (asset)), 0);
    }

    function _mockUser(
        address asset,
        uint256 balance,
        uint256 stable,
        uint256 variableDebt,
        uint256 principalStable,
        uint256 scaledVariable,
        bool collateral
    ) internal {
        vm.mockCall(
            DATA,
            abi.encodeCall(IScenarioDataProvider.getUserReserveData, (asset, MAKER)),
            abi.encode(
                balance,
                stable,
                variableDebt,
                principalStable,
                scaledVariable,
                uint256(0),
                uint256(0),
                uint40(0),
                collateral
            )
        );
    }

    function test_SnapshotAllFieldsAndGappedReserveIDs() public view {
        assertEq(abi.encode(engine.snapshot(MAKER)), abi.encode(_state()));
        assertEq(engine.aWETH(), AWETH);
        assertEq(engine.aUSDC(), AUSDC);
    }

    function test_ActiveOneFactorShockAndBenchmarkScenariosAreSeparated() public view {
        MarginMMScenarioEngine.State memory s = _state();
        assertEq(engine.stressHF(s, ACTIVE_SHOCK_BPS), 1.5881e18);
        (uint256 activeCollateral, uint256 activeDebt) = engine.scenarioValues(s, 8_760, 10_000);
        assertEq(engine.stressHF(s, ACTIVE_SHOCK_BPS), activeCollateral * 1e18 / activeDebt);

        // Historical 20%/30% WETH and 5% USDC shocks remain explicit sensitivity benchmarks only.
        uint256 worst = type(uint256).max;
        uint256[4] memory wethBps = [uint256(10_000), 8_000, 7_000, 10_000];
        for (uint256 i; i < 4; ++i) {
            (uint256 collateral, uint256 debt) = engine.scenarioValues(s, wethBps[i], i == 3 ? 9_500 : 10_000);
            worst = Math.min(worst, collateral * 1e18 / debt);
        }
        assertEq(worst, 1.4825e18);
        assertEq(engine.benchmarkStressHF(s, 7_000, 10_000), worst);
        s.usdcDebt = 0;
        assertEq(engine.stressHF(s, ACTIVE_SHOCK_BPS), type(uint256).max);
    }

    function testFuzz_UsdcStressScalesCollateralAndDebtTogether(uint64 amountRaw, uint64 debtRaw, uint32 priceRaw)
        public
        view
    {
        MarginMMScenarioEngine.State memory s = _state();
        s.wethAmount = 0;
        s.usdcAmount = bound(amountRaw, 1, 1e12) * 1e6;
        s.usdcDebt = bound(debtRaw, 1, 1e12) * 1e6;
        s.usdcPrice = bound(priceRaw, 1, 1e6) * 10_000;
        s.usdcLT = 10_000;
        (uint256 c, uint256 d) = engine.scenarioValues(s, 10_000, 10_000);
        (uint256 stressedC, uint256 stressedD) = engine.scenarioValues(s, 10_000, 9_500);
        assertEq(stressedC * 10_000, c * 9_500);
        assertEq(stressedD * 10_000, d * 9_500);
        assertEq(stressedC * 1e18 / stressedD, c * 1e18 / d);
    }

    function testFuzz_PreviewBoundsTwoRoundedHops(
        uint96 seed,
        uint96 inRaw,
        uint96 outRaw,
        uint64 indexRaw,
        bool wethIn
    ) public view {
        MarginMMScenarioEngine.State memory s = _state();
        uint256 index = bound(indexRaw, 1, 100) * RAY + uint256(seed) % RAY;
        s.wethIndex = index;
        s.usdcIndex = index + RAY / 3;
        uint256 inIndex = wethIn ? s.wethIndex : s.usdcIndex;
        uint256 outIndex = wethIn ? s.usdcIndex : s.wethIndex;
        uint256 inScaled = bound(seed, 1e18, 1e24);
        uint256 outScaled = inScaled + 17;
        if (wethIn) {
            s.wethAmount = _rayMul(inScaled, inIndex);
            s.usdcAmount = _rayMul(outScaled, outIndex);
        } else {
            s.usdcAmount = _rayMul(inScaled, inIndex);
            s.wethAmount = _rayMul(outScaled, outIndex);
        }
        uint256 amountIn = bound(inRaw, 1, 1e20);
        uint256 amountOut = bound(outRaw, 0, _rayMul(outScaled, outIndex) / 4);
        uint256 predicted = engine.preview(s, wethIn, amountIn, amountOut, ACTIVE_SHOCK_BPS);
        // Independent scaled-balance simulation of Aave half-up ray arithmetic.
        uint256 hop1 = _rayDiv(amountIn, inIndex);
        uint256 receivedByRouter = _rayMul(hop1, inIndex);
        uint256 hop2 = _rayDiv(Math.min(amountIn, receivedByRouter), inIndex);
        uint256 afterIn = _rayMul(inScaled + hop2, inIndex);
        uint256 afterOut = _rayMul(outScaled - _rayDiv(amountOut, outIndex), outIndex);
        if (wethIn) {
            s.wethAmount = afterIn;
            s.usdcAmount = afterOut;
        } else {
            s.usdcAmount = afterIn;
            s.wethAmount = afterOut;
        }
        assertLe(predicted, engine.stressHF(s, ACTIVE_SHOCK_BPS));
    }

    function _rayMul(uint256 x, uint256 index) internal pure returns (uint256) {
        return (x * index + RAY / 2) / RAY;
    }

    function _rayDiv(uint256 x, uint256 index) internal pure returns (uint256) {
        return (x * RAY + index / 2) / index;
    }

    function test_PreviewZeroDustFullOutputAndRepeatedCalls() public view {
        MarginMMScenarioEngine.State memory s = _state();
        uint256 initialHF = engine.stressHF(s, ACTIVE_SHOCK_BPS);
        assertEq(engine.preview(s, true, 0, 0, ACTIVE_SHOCK_BPS), initialHF);
        assertEq(engine.preview(s, true, 6, 0, ACTIVE_SHOCK_BPS), initialHF);
        uint256 quoted = engine.preview(s, false, 100e6, 1e18, ACTIVE_SHOCK_BPS);
        assertEq(engine.preview(s, false, 100e6, 1e18, ACTIVE_SHOCK_BPS), quoted);
        assertEq(engine.stressHF(s, ACTIVE_SHOCK_BPS), initialHF);
        s.usdcAmount = 0;
        assertEq(engine.preview(_state(), true, 0, 50_000e6, ACTIVE_SHOCK_BPS), engine.stressHF(s, ACTIVE_SHOCK_BPS));
    }

    function test_RejectImpossibleOutputAndOverflow() public {
        MarginMMScenarioEngine.State memory s = _state();
        vm.expectRevert(MarginMMScenarioEngine.InsufficientOutputBalance.selector);
        engine.preview(s, true, 0, s.usdcAmount + 1, ACTIVE_SHOCK_BPS);
        vm.expectRevert(MarginMMScenarioEngine.InvalidState.selector);
        engine.preview(s, false, type(uint256).max, 0, ACTIVE_SHOCK_BPS);
        s.wethAmount = type(uint128).max;
        vm.expectRevert(MarginMMScenarioEngine.InvalidState.selector);
        engine.preview(s, true, 100, 0, ACTIVE_SHOCK_BPS);
    }

    function test_MaximumDomainDoesNotOverflow() public view {
        MarginMMScenarioEngine.State memory s = _state();
        s.wethAmount = type(uint128).max;
        s.usdcAmount = type(uint128).max;
        s.usdcDebt = 1;
        s.wethPrice = type(uint64).max;
        s.usdcPrice = 1;
        s.wethLT = 10_000;
        s.usdcLT = 10_000;
        s.wethIndex = type(uint128).max;
        s.usdcIndex = type(uint128).max;
        assertGt(engine.stressHF(s, ACTIVE_SHOCK_BPS), 0);
        assertGt(engine.preview(s, false, 0, 1, ACTIVE_SHOCK_BPS), 0);
    }

    function test_RejectInvalidPricesThresholdsAndIndices() public {
        MarginMMScenarioEngine.State memory s = _state();
        s.wethPrice = 0;
        vm.expectRevert(MarginMMScenarioEngine.InvalidState.selector);
        engine.stressHF(s, ACTIVE_SHOCK_BPS);
        s = _state();
        s.usdcPrice = uint256(type(uint64).max) + 1;
        vm.expectRevert(MarginMMScenarioEngine.InvalidState.selector);
        engine.stressHF(s, ACTIVE_SHOCK_BPS);
        s = _state();
        s.usdcLT = 10_001;
        vm.expectRevert(MarginMMScenarioEngine.InvalidState.selector);
        engine.stressHF(s, ACTIVE_SHOCK_BPS);
        s = _state();
        s.wethIndex = RAY - 1;
        vm.expectRevert(MarginMMScenarioEngine.InvalidState.selector);
        engine.stressHF(s, ACTIVE_SHOCK_BPS);
    }

    function test_RejectEModeAndDifferentUser() public {
        _mockUint(POOL, abi.encodeCall(IScenarioPool.getUserEMode, (MAKER)), 1);
        vm.expectRevert(abi.encodeWithSelector(MarginMMScenarioEngine.UnsupportedEMode.selector, 1));
        engine.snapshot(MAKER);
        address otherUser = address(0xCAFE);
        _mockUint(POOL, abi.encodeCall(IScenarioPool.getUserEMode, (otherUser)), 0);
        _mockUint(POOL, abi.encodeCall(IScenarioPool.getUserConfiguration, (otherUser)), 0);
        vm.expectRevert(abi.encodeWithSelector(MarginMMScenarioEngine.UnsupportedPosition.selector, address(0)));
        engine.snapshot(otherUser);
    }

    function test_RejectMissingCollateralFlags() public {
        _mockUint(POOL, abi.encodeCall(IScenarioPool.getUserConfiguration, (MAKER)), 2 | (1 << 6));
        vm.expectRevert(abi.encodeWithSelector(MarginMMScenarioEngine.UnsupportedPosition.selector, USDC));
        engine.snapshot(MAKER);
        _mockUint(POOL, abi.encodeCall(IScenarioPool.getUserConfiguration, (MAKER)), 2 | (3 << 6));
        _mockUser(WETH, 10e18, 0, 0, 0, 0, false);
        vm.expectRevert(abi.encodeWithSelector(MarginMMScenarioEngine.UnsupportedPosition.selector, WETH));
        engine.snapshot(MAKER);
    }

    function testFuzz_RejectEveryUnsupportedConfigBit(uint8 rawId, bool borrowing) public {
        uint16 id = uint16(bound(rawId, 4, 127));
        _mockAddress(POOL, abi.encodeCall(IScenarioPool.getReserveAddressById, (id)), OTHER);
        uint256 bit = uint256(1) << (2 * id + (borrowing ? 0 : 1));
        _mockUint(POOL, abi.encodeCall(IScenarioPool.getUserConfiguration, (MAKER)), 2 | (3 << 6) | bit);
        vm.expectRevert(abi.encodeWithSelector(MarginMMScenarioEngine.UnsupportedPosition.selector, OTHER));
        engine.snapshot(MAKER);
    }

    function test_CanonicalBitmapDefinesActiveReserveScope() public {
        _mockUser(OTHER, 0, 0, 1, 0, 1, false);
        // The official Aave bitmap has no active bit for OTHER, so its reserve
        // data is not queried. A real debt position always sets its borrow bit.
        assertEq(abi.encode(engine.snapshot(MAKER)), abi.encode(_state()));
    }

    function test_RejectOtherCollateralEvenAtZeroBalance() public {
        _mockUint(POOL, abi.encodeCall(IScenarioPool.getUserConfiguration, (MAKER)), 2 | (3 << 6) | (2 << 8));
        _mockAddress(POOL, abi.encodeCall(IScenarioPool.getReserveAddressById, (4)), OTHER);
        vm.expectRevert(abi.encodeWithSelector(MarginMMScenarioEngine.UnsupportedPosition.selector, OTHER));
        engine.snapshot(MAKER);
    }

    function test_RejectStableAndWethDebt() public {
        _mockUser(USDC, 50_000e6, 1, 40_000e6, 1, 1, true);
        vm.expectRevert(abi.encodeWithSelector(MarginMMScenarioEngine.UnsupportedPosition.selector, USDC));
        engine.snapshot(MAKER);
        _mockUser(USDC, 50_000e6, 0, 40_000e6, 0, 1, true);
        _mockUser(WETH, 10e18, 0, 1, 0, 1, true);
        vm.expectRevert(abi.encodeWithSelector(MarginMMScenarioEngine.UnsupportedPosition.selector, WETH));
        engine.snapshot(MAKER);
    }

    function test_RejectPausedInactiveIsolationSiloedAndWrongDecimals() public {
        _mockUint(DATA, abi.encodeCall(IScenarioDataProvider.getPaused, (USDC)), 1);
        _expectReserveRejected(USDC);
        _mockReserve(USDC, 6, 8_500, false, false, true);
        _expectReserveRejected(USDC);
        _mockReserve(USDC, 6, 8_500, true, false, true);
        _mockUint(DATA, abi.encodeCall(IScenarioDataProvider.getDebtCeiling, (USDC)), 1);
        _expectReserveRejected(USDC);
        _mockReserve(USDC, 6, 8_500, true, false, true);
        _mockUint(DATA, abi.encodeCall(IScenarioDataProvider.getSiloedBorrowing, (USDC)), 1);
        _expectReserveRejected(USDC);
        _mockReserve(USDC, 18, 8_500, true, false, true);
        _expectReserveRejected(USDC);
        _mockReserve(USDC, 6, 0, true, false, false);
        _expectReserveRejected(USDC);
    }

    function _expectReserveRejected(address asset) internal {
        vm.expectRevert(abi.encodeWithSelector(MarginMMScenarioEngine.UnsupportedReserve.selector, asset));
        engine.snapshot(MAKER);
    }

    function test_FrozenAndUnusedNonCollateralBalancesPermitted() public {
        _mockReserve(WETH, 18, 8_000, true, true, true);
        _mockReserve(USDC, 6, 8_500, true, true, true);
        _mockUser(OTHER, 123e18, 0, 0, 0, 0, false);
        assertEq(abi.encode(engine.snapshot(MAKER)), abi.encode(_state()));
    }

    function test_RejectMarketChangeAndMismatchedOracleProvider() public {
        _mockAddress(PROVIDER, abi.encodeCall(IScenarioProvider.getPriceOracle, ()), address(0xBAD));
        vm.expectRevert(MarginMMScenarioEngine.InvalidMarket.selector);
        engine.snapshot(MAKER);
        _mockAddress(PROVIDER, abi.encodeCall(IScenarioProvider.getPriceOracle, ()), ORACLE);
        _mockAddress(ORACLE, abi.encodeCall(IScenarioOracle.ADDRESSES_PROVIDER, ()), address(0xBAD));
        vm.expectRevert(MarginMMScenarioEngine.InvalidMarket.selector);
        new ScenarioHarness(POOL, DATA, ORACLE);
    }

    function test_RejectWrongChainAndTokenMarket() public {
        vm.chainId(10);
        vm.expectRevert(MarginMMScenarioEngine.InvalidMarket.selector);
        engine.snapshot(MAKER);
        vm.chainId(1);
        _mockAddress(AWETH, abi.encodeCall(IScenarioToken.POOL, ()), address(0xBAD));
        vm.expectRevert(abi.encodeWithSelector(MarginMMScenarioEngine.InvalidToken.selector, WETH));
        engine.snapshot(MAKER);
    }

    function test_RejectChangedOfficialAToken() public {
        vm.mockCall(
            DATA,
            abi.encodeCall(IScenarioDataProvider.getReserveTokensAddresses, (WETH)),
            abi.encode(address(0xBAD), address(0), DWETH)
        );
        vm.expectRevert(abi.encodeWithSelector(MarginMMScenarioEngine.InvalidToken.selector, WETH));
        engine.snapshot(MAKER);
    }
}

/// @notice Actual Aave fork; missing RPC is an explicit skip, never a passing fork assertion.
contract MarginMMScenarioEngineForkTest is ScenarioAddresses {
    address internal maker = makeAddr("scenario-maker");
    address internal taker = makeAddr("scenario-taker");
    address internal intermediate = makeAddr("scenario-intermediate");
    address internal receiver = makeAddr("scenario-receiver");

    function setUp() public {
        string memory rpc = vm.envOr("ETH_RPC_URL", string(""));
        if (bytes(rpc).length == 0) rpc = vm.envOr("MAINNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc, 25_913_344);
        engine = new ScenarioHarness(POOL, DATA, ORACLE);
        _supply(maker, 10 ether, 50_000e6);
        vm.prank(maker);
        IScenarioPoolActions(POOL).borrow(USDC, 40_000e6, 2, 0, maker);
        _supply(taker, 3 ether, 20_000e6);
    }

    function _supply(address user, uint256 weth, uint256 usdc) internal {
        vm.deal(user, weth);
        deal(USDC, user, usdc);
        vm.startPrank(user);
        IScenarioWETH(WETH).deposit{value: weth}();
        IERC20(WETH).approve(POOL, weth);
        IERC20(USDC).approve(POOL, usdc);
        IScenarioPoolActions(POOL).supply(WETH, weth, user, 0);
        IScenarioPoolActions(POOL).supply(USDC, usdc, user, 0);
        IScenarioPoolActions(POOL).setUserUseReserveAsCollateral(WETH, true);
        IScenarioPoolActions(POOL).setUserUseReserveAsCollateral(USDC, true);
        vm.stopPrank();
    }

    function testFork_SnapshotMatchesLivePoolTokensOracleAndDebtAccrual() public {
        MarginMMScenarioEngine.State memory s = engine.snapshot(maker);
        assertEq(s.wethAmount, IERC20(AWETH).balanceOf(maker));
        assertEq(s.usdcAmount, IERC20(AUSDC).balanceOf(maker));
        (,, address debtToken) = IScenarioDataProvider(DATA).getReserveTokensAddresses(USDC);
        assertEq(s.usdcDebt, IERC20(debtToken).balanceOf(maker));
        assertEq(s.wethPrice, IScenarioOracle(ORACLE).getAssetPrice(WETH));
        assertEq(s.usdcPrice, IScenarioOracle(ORACLE).getAssetPrice(USDC));
        assertEq(s.wethIndex, IScenarioPool(POOL).getReserveNormalizedIncome(WETH));
        assertEq(s.usdcIndex, IScenarioPool(POOL).getReserveNormalizedIncome(USDC));
        (,,,,, uint256 hf) = IScenarioPool(POOL).getUserAccountData(maker);
        assertEq(s.aaveHF, hf);
        (uint256 collateral, uint256 debt) = engine.scenarioValues(s, 10_000, 10_000);
        assertApproxEqRel(collateral * 1e18 / debt, hf, 1e14);
        vm.warp(block.timestamp + 30 days);
        MarginMMScenarioEngine.State memory accrued = engine.snapshot(maker);
        assertGt(accrued.usdcDebt, s.usdcDebt);
        assertGt(accrued.wethIndex, s.wethIndex);
        assertGt(accrued.usdcIndex, s.usdcIndex);
    }

    function testFork_TwoHopPreviewBothDirectionsAndRepeatedSettlement() public {
        _trade(true, 1 ether + 1, 1_000e6 + 1);
        _trade(false, 1_000e6 + 1, 0.1 ether + 1);
        _trade(true, 0.01 ether + 7, 10e6 + 1);
    }

    /// forge-config: default.fuzz.runs = 32
    function testFuzzFork_ConservativePreview(uint64 inRaw, uint64 outRaw, bool wethIn) public {
        uint256 amountIn = bound(inRaw, 100, wethIn ? 1 ether : 5_000e6);
        uint256 amountOut = bound(outRaw, 1, wethIn ? 5_000e6 : 1 ether);
        _trade(wethIn, amountIn, amountOut);
    }

    function testFork_PreviewAfterAccrualAndDustTransfers() public {
        vm.warp(block.timestamp + 90 days);
        _trade(true, 100, 1);
        _trade(false, 100, 1);
    }

    function _trade(bool wethIn, uint256 amountIn, uint256 amountOut) internal {
        MarginMMScenarioEngine.State memory beforeState = engine.snapshot(maker);
        uint256 previewHF = engine.preview(beforeState, wethIn, amountIn, amountOut, ACTIVE_SHOCK_BPS);
        address tokenIn = wethIn ? AWETH : AUSDC;
        address tokenOut = wethIn ? AUSDC : AWETH;
        uint256 intermediateBefore = IERC20(tokenIn).balanceOf(intermediate);
        vm.prank(taker);
        assertTrue(IERC20(tokenIn).transfer(intermediate, amountIn));
        uint256 received = IERC20(tokenIn).balanceOf(intermediate) - intermediateBefore;
        vm.prank(intermediate);
        assertTrue(IERC20(tokenIn).transfer(maker, Math.min(received, amountIn)));
        vm.prank(maker);
        assertTrue(IERC20(tokenOut).transfer(receiver, amountOut));
        MarginMMScenarioEngine.State memory afterState = engine.snapshot(maker);
        assertEq(afterState.usdcDebt, beforeState.usdcDebt, "aToken trades must not change debt");
        assertLe(previewHF, engine.stressHF(afterState, ACTIVE_SHOCK_BPS), "preview overcredited actual settlement");
        assertGt(afterState.aaveHF, 1e18);
    }

    function testFork_RejectActualOtherCollateralAndDebt() public {
        vm.prank(maker);
        IScenarioPoolActions(POOL).borrow(OTHER, 100e18, 2, 0, maker);
        vm.expectRevert(abi.encodeWithSelector(MarginMMScenarioEngine.UnsupportedPosition.selector, OTHER));
        engine.snapshot(maker);
    }

    function testFork_RejectActualDisabledCollateral() public {
        vm.prank(taker);
        IScenarioPoolActions(POOL).setUserUseReserveAsCollateral(WETH, false);
        vm.expectRevert(abi.encodeWithSelector(MarginMMScenarioEngine.UnsupportedPosition.selector, address(0)));
        engine.snapshot(taker);
        assertGt(engine.snapshot(maker).usdcDebt, 0);
    }
}
