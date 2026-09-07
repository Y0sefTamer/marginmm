// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {IPool} from "@aave/core-v3/contracts/interfaces/IPool.sol";
import {IAToken} from "@aave/core-v3/contracts/interfaces/IAToken.sol";
import {IPoolDataProvider} from "@aave/core-v3/contracts/interfaces/IPoolDataProvider.sol";
import {IPriceOracleGetter} from "@aave/core-v3/contracts/interfaces/IPriceOracleGetter.sol";
import {MarginMMRiskEngine} from "../src/MarginMMRiskEngine.sol";

contract MarginMMRiskEngineTest is Test {
    address internal constant POOL = address(0x1001);
    address internal constant DATA = address(0x1002);
    address internal constant ORACLE = address(0x1003);
    address internal constant MAKER = address(0xBEEF);
    address internal constant A_TOKEN = address(0xA001);
    address internal constant UNDERLYING = address(0xC001);

    MarginMMRiskEngine internal engine;

    function setUp() public {
        engine = new MarginMMRiskEngine(POOL, DATA, ORACLE, 1.1e18, 9_500, 10_500);
    }

    function _mockBaseAccount(uint256 collateralBase, uint256 debtBase, uint256 avgLt, uint256 hf) internal {
        vm.mockCall(POOL, abi.encodeCall(IPool.getUserEMode, (MAKER)), abi.encode(uint256(0)));
        vm.mockCall(
            POOL,
            abi.encodeCall(IPool.getUserAccountData, (MAKER)),
            abi.encode(collateralBase, debtBase, uint256(0), avgLt, uint256(0), hf)
        );
    }

    function _mockReserve(uint256 balance, uint256 price, uint256 lt, bool userCollateral) internal {
        vm.mockCall(A_TOKEN, abi.encodeCall(IAToken.UNDERLYING_ASSET_ADDRESS, ()), abi.encode(UNDERLYING));
        vm.mockCall(
            DATA,
            abi.encodeCall(IPoolDataProvider.getReserveTokensAddresses, (UNDERLYING)),
            abi.encode(A_TOKEN, address(0), address(0xD001))
        );
        vm.mockCall(
            DATA,
            abi.encodeCall(IPoolDataProvider.getReserveConfigurationData, (UNDERLYING)),
            abi.encode(
                uint256(18), // decimals
                uint256(7_500), // ltv
                lt,
                uint256(10_500), // liquidation bonus
                uint256(1_000), // reserve factor
                true, // collateral enabled for reserve
                true, // borrowing
                false, // stable borrowing
                true, // active
                false // frozen
            )
        );
        vm.mockCall(
            DATA,
            abi.encodeCall(IPoolDataProvider.getUserReserveData, (UNDERLYING, MAKER)),
            abi.encode(
                balance,
                uint256(0),
                uint256(0),
                uint256(0),
                uint256(0),
                uint256(0),
                uint256(0),
                uint40(0),
                userCollateral
            )
        );
        vm.mockCall(ORACLE, abi.encodeCall(IPriceOracleGetter.getAssetPrice, (UNDERLYING)), abi.encode(price));
    }

    function test_SafeCapacityClampsRiskyOutput() public {
        _mockBaseAccount(25_000e8, 10_000e8, 8_000, 2e18);
        _mockReserve(10e18, 3_000e8, 8_000, true);

        uint256 q = engine.safeCapacity(MAKER, A_TOKEN);
        assertGt(q, 0);
        assertLt(q, 10e18);

        MarginMMRiskEngine.CapacityQuote memory quote = engine.quoteCapacity(MAKER, A_TOKEN, 10e18);
        assertEq(quote.qMax, q);
        assertEq(quote.executableOut, q);
        assertTrue(quote.partialFill);
    }

    function test_NonCollateralATokenDoesNotConsumeHFHeadroom() public {
        _mockBaseAccount(25_000e8, 10_000e8, 8_000, 2e18);
        _mockReserve(10e18, 3_000e8, 8_000, false);

        assertEq(engine.safeCapacity(MAKER, A_TOKEN), 10e18);
    }

    function test_NoDebtAllowsFullATokenBalance() public {
        _mockBaseAccount(25_000e8, 0, 8_000, type(uint256).max);
        _mockReserve(10e18, 3_000e8, 8_000, true);

        assertEq(engine.safeCapacity(MAKER, A_TOKEN), 10e18);
    }

    function test_EModeFailsClosed() public {
        vm.mockCall(POOL, abi.encodeCall(IPool.getUserEMode, (MAKER)), abi.encode(uint256(1)));

        vm.expectRevert(abi.encodeWithSelector(MarginMMRiskEngine.UnsupportedEMode.selector, uint256(1)));
        engine.safeCapacity(MAKER, A_TOKEN);
    }

    function test_RejectsTokenThatIsNotOfficialReserveAToken() public {
        _mockBaseAccount(25_000e8, 10_000e8, 8_000, 2e18);
        vm.mockCall(A_TOKEN, abi.encodeCall(IAToken.UNDERLYING_ASSET_ADDRESS, ()), abi.encode(UNDERLYING));
        vm.mockCall(
            DATA,
            abi.encodeCall(IPoolDataProvider.getReserveTokensAddresses, (UNDERLYING)),
            abi.encode(address(0xBAD), address(0), address(0xD001))
        );

        vm.expectRevert(abi.encodeWithSelector(MarginMMRiskEngine.NotAaveAToken.selector, A_TOKEN));
        engine.safeCapacity(MAKER, A_TOKEN);
    }
}
