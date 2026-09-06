// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import {MarginMMPricing} from "../src/MarginMMPricing.sol";
import {MarginMMAquaPosition} from "../src/MarginMMAquaPosition.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

// ==========================================
// MOCKS: Simulating External Dependencies
// ==========================================

/**
 * @title MockToken
 * @dev A simple ERC20 token to simulate assets like USDC or LINK in the testing environment.
 */
contract MockToken is ERC20 {
    constructor() ERC20("Mock USDC", "mUSDC") {}
    function mint(address to, uint256 amount) public {
        _mint(to, amount);
    }
}

/**
 * @title MockAaveProvider
 * @dev Mocks the Aave V3 IPoolDataProvider to allow injection of custom Liquidation Thresholds (LT) during tests.
 */
contract MockAaveProvider {
    uint256 public mockLiquidationThreshold = 8500; // Default: 85% LT
    
    function setMockLT(uint256 _lt) external {
        mockLiquidationThreshold = _lt;
    }

    function getReserveConfigurationData(address) external view returns (
        uint256, uint256, uint256 lt, uint256, uint256, bool, bool, bool, bool, bool
    ) {
        // We only care about the LT (3rd parameter) for the MarginMM pricing engine
        return (0, 0, mockLiquidationThreshold, 0, 0, false, false, false, false, false);
    }
}

// ==========================================
// TEST SUITE: Core Logic & Edge Cases
// ==========================================

/**
 * @title MarginMMTest
 * @dev Comprehensive test suite covering unit tests for normal operations and fuzz tests for mathematical robustness.
 */
contract MarginMMTest is Test {
    MarginMMPricing public pricingEngine;
    MarginMMAquaPosition public vault;
    MockToken public token;
    MockAaveProvider public aaveProvider;

    // Test accounts
    address public owner = address(0x1);
    address public liquidityProvider = address(0x2);
    address public taker = address(0x3);

    function setUp() public {
        // 1. Deploy Mocks
        token = new MockToken();
        aaveProvider = new MockAaveProvider();

        // 2. Deploy the core Pricing Engine
        pricingEngine = new MarginMMPricing(address(aaveProvider));

        // 3. Deploy the execution Vault (Aqua Position)
        vault = new MarginMMAquaPosition(address(pricingEngine), address(token), owner);

        // 4. Fund the Liquidity Provider and deposit into the Vault
        vm.startPrank(liquidityProvider);
        token.mint(liquidityProvider, 100000 ether);
        token.approve(address(vault), 100000 ether);
        vault.depositLiquidity(10000 ether); // Seed vault with 10k mock tokens
        vm.stopPrank();
    }

    // ==========================================
    // UNIT TESTS: Happy Paths & Reverts
    // ==========================================

    /**
     * @notice Verifies that Liquidity Providers can successfully seed the Vault.
     */
    function test_DepositLiquidity() public {
        assertEq(token.balanceOf(address(vault)), 10000 ether, "Vault balance should reflect LP deposit");
    }

    /**
     * @notice Verifies that safe trades (HF >= 1.5) receive the discounted fee structure.
     */
    function test_ExecuteSwap_SafeDiscount() public {
        uint256 safeHF = 1.6e18; // Healthy portfolio state
        uint256 requestAmount = 1000 ether;

        uint256 expectedFee = (requestAmount * 10) / 10000; // 0.1% discount fee

        vm.prank(taker);
        uint256 netOut = vault.executeAquaSwap(safeHF, requestAmount, taker);

        assertEq(netOut, requestAmount - expectedFee, "Taker should pay the discounted base fee");
        assertEq(token.balanceOf(taker), netOut, "Taker balance mismatch");
    }

    /**
     * @notice Verifies that risky trades (HF < 1.5) are charged a dynamic risk premium.
     */
    function test_ExecuteSwap_RiskyPremium() public {
        uint256 riskyHF = 1.1e18; // Portfolio is nearing liquidation
        uint256 requestAmount = 1000 ether;

        vm.prank(taker);
        uint256 netOut = vault.executeAquaSwap(riskyHF, requestAmount, taker);

        // The netOut should be strictly less than the discounted scenario due to the risk penalty
        assertTrue(netOut < (requestAmount - ((requestAmount * 10) / 10000)), "Risk premium was not applied");
    }

    /**
     * @notice Ensures the Vault strictly reverts any trade that pushes HF below the critical threshold.
     */
    function test_Revert_WhenLiquidation() public {
        uint256 deadlyHF = 1.0e18; // Liquidation territory
        
        vm.expectRevert("MarginMM: Trade causes liquidation!");
        vm.prank(taker);
        vault.executeAquaSwap(deadlyHF, 100 ether, taker);
    }

    // ==========================================
    // FUZZ TESTS: Mathematical Robustness
    // ==========================================

    /**
     * @notice Injects thousands of random HF and LT combinations to ensure math scaling never panics.
     */
    function testFuzz_DynamicFeeNeverRevertsUnnecessarily(uint256 randomHF, uint256 randomLT) public {
        // Bound HF to strictly valid, non-liquidating states
        randomHF = bound(randomHF, pricingEngine.LIQUIDATION_THRESHOLD_HF(), type(uint128).max);
        
        // Bound LT between realistic Aave constraints (1% to 99%)
        randomLT = bound(randomLT, 100, 9900);

        // Inject the fuzzed LT into our mock
        aaveProvider.setMockLT(randomLT);

        // Calculate fee; if math overflows, the test will fail
        uint256 fee = pricingEngine.calculateDynamicFee(randomHF, address(token));
        
        assertTrue(fee > 0, "Fee calculation should always return a positive bps value");
    }

    /**
     * @notice Verifies the Vault can process varying swap sizes safely without underflowing balances.
     */
    function testFuzz_ExecuteSwap(uint256 requestAmount) public {
        // Bound request size to available liquidity
        requestAmount = bound(requestAmount, 1, 10000 ether);
        
        uint256 safeHF = 1.8e18;

        vm.prank(taker);
        uint256 netOut = vault.executeAquaSwap(safeHF, requestAmount, taker);

        assertTrue(netOut <= requestAmount, "Net out cannot exceed requested amount");
    }
}