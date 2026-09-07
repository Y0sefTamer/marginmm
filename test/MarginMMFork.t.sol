// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPool} from "@aave/core-v3/contracts/interfaces/IPool.sol";
import {IPoolDataProvider} from "@aave/core-v3/contracts/interfaces/IPoolDataProvider.sol";
import {IPriceOracleGetter} from "@aave/core-v3/contracts/interfaces/IPriceOracleGetter.sol";
import {MarginMMRiskEngine} from "../src/MarginMMRiskEngine.sol";

interface IWETH is IERC20 {
    function deposit() external payable;
}

/// @notice Optional Ethereum-mainnet fork test. It is skipped when MAINNET_RPC_URL is unset.
contract MarginMMForkTest is Test {
    address internal constant AAVE_POOL = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2;
    address internal constant AAVE_DATA_PROVIDER = 0x0a16f2FCC0D44FaE41cc54e079281D84A363bECD;
    address internal constant AAVE_ORACLE = 0x54586bE62E3c3580375aE3723C145253060Ca0C2;

    address internal constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address internal constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;

    function testFork_qMaxSurvivesRealATokenTransfer() public {
        string memory rpc = vm.envOr("MAINNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;

        vm.createSelectFork(rpc);

        IPool pool = IPool(AAVE_POOL);
        IPoolDataProvider dataProvider = IPoolDataProvider(AAVE_DATA_PROVIDER);
        IPriceOracleGetter oracle = IPriceOracleGetter(AAVE_ORACLE);

        MarginMMRiskEngine engine = new MarginMMRiskEngine(
            AAVE_POOL,
            AAVE_DATA_PROVIDER,
            AAVE_ORACLE,
            1.10e18,
            9_500,
            10_500
        );

        address maker = makeAddr("fork-maker");
        address receiver = makeAddr("fork-receiver");

        vm.deal(maker, 20 ether);
        vm.startPrank(maker);
        IWETH(WETH).deposit{value: 20 ether}();
        IERC20(WETH).approve(AAVE_POOL, type(uint256).max);
        pool.supply(WETH, 20 ether, maker, 0);
        vm.stopPrank();

        (, , uint256 availableBorrowsBase, , , ) = pool.getUserAccountData(maker);
        uint256 usdcPrice = oracle.getAssetPrice(USDC);

        // Borrow 60% of Aave's currently reported capacity so the test is price-independent.
        uint256 borrowBase = Math.mulDiv(availableBorrowsBase, 60, 100);
        uint256 borrowAmount = Math.mulDiv(borrowBase, 1e6, usdcPrice);
        assertGt(borrowAmount, 0);

        vm.prank(maker);
        pool.borrow(USDC, borrowAmount, 2, 0, maker);

        (address aWETH, , ) = dataProvider.getReserveTokensAddresses(WETH);
        uint256 makerATokenBalance = IERC20(aWETH).balanceOf(maker);
        uint256 qMax = engine.safeCapacity(maker, aWETH);

        assertGt(qMax, 0);
        assertLt(qMax, makerATokenBalance);

        // This is a real aToken transfer on a fork. Aave's finalizeTransfer hook runs too.
        vm.prank(maker);
        IERC20(aWETH).transfer(receiver, qMax);

        assertEq(IERC20(aWETH).balanceOf(receiver), qMax);
        MarginMMRiskEngine.AccountSnapshot memory post = engine.accountSnapshot(maker);
        assertGe(post.stressHF, 1.10e18);
    }
}
