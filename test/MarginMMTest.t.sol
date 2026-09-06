// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import {MarginMMPricing} from "../src/MarginMMPricing.sol";
import {MarginMMAquaPosition} from "../src/MarginMMAquaPosition.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

// ==========================================
// MOCKS: Simulating External Dependencies
// ==========================================

contract MockToken is ERC20 {
    constructor() ERC20("Mock USDC", "mUSDC") {}
    function mint(address to, uint256 amount) public {
        _mint(to, amount);
    }
}

contract MockAaveProvider {
    uint256 public mockLiquidationThreshold = 8500; // Default: 85% LT
    
    function setMockLT(uint256 _lt) external {
        mockLiquidationThreshold = _lt;
    }

    function getReserveConfigurationData(address) external view returns (
        uint256, uint256, uint256 lt, uint256, uint256, bool, bool, bool, bool, bool
    ) {
        return (0, 0, mockLiquidationThreshold, 0, 0, false, false, false, false, false);
    }
}

// ==========================================
// TEST SUITE: Core Logic & Edge Cases
// ==========================================

contract MarginMMTest is Test {
    MarginMMPricing public pricingEngine;
    MarginMMAquaPosition public vault;
    MockToken public token;
    MockAaveProvider public aaveProvider;

    address public owner = address(0x1);
    address public liquidityProvider = address(0x2);
    address public taker = address(0x3);

    function setUp() public {
        token = new MockToken();
        aaveProvider = new MockAaveProvider();
        pricingEngine = new MarginMMPricing(address(aaveProvider));
        vault = new MarginMMAquaPosition(address(pricingEngine), address(token), owner);

        vm.startPrank(liquidityProvider);
        token.mint(liquidityProvider, 100000 ether);
        token.approve(address(vault), 100000 ether);
        vault.depositLiquidity(10000 ether);
        vm.stopPrank();
    }

    // ==========================================
    // UNIT TESTS
    // ==========================================

    function test_DepositLiquidity() public {
        assertEq(token.balanceOf(address(vault)), 10000 ether, "Vault balance should reflect LP deposit");
    }

    function test_ExecuteSwap_SafeDiscount() public {
        uint256 safeHF = 1.6e18; 
        uint256 requestAmount = 1000 ether;
        uint256 expectedFee = (requestAmount * 10) / 10000; 

        // 1inch SwapVM Payload encoding
        bytes memory swapVMPayload = abi.encode(safeHF);

        vm.prank(taker);
        // Using the official SwapVM Interface
        uint256 netOut = vault.executeSwapInstruction(taker, address(token), requestAmount, swapVMPayload);

        assertEq(netOut, requestAmount - expectedFee, "Taker should pay the discounted base fee");
        assertEq(token.balanceOf(taker), netOut, "Taker balance mismatch");
    }

    function test_ExecuteSwap_RiskyPremium() public {
        uint256 riskyHF = 1.1e18; 
        uint256 requestAmount = 1000 ether;

        // 1inch SwapVM Payload encoding
        bytes memory swapVMPayload = abi.encode(riskyHF);

        vm.prank(taker);
        uint256 netOut = vault.executeSwapInstruction(taker, address(token), requestAmount, swapVMPayload);

        assertTrue(netOut < (requestAmount - ((requestAmount * 10) / 10000)), "Risk premium was not applied");
    }

    function test_Revert_WhenLiquidation() public {
        uint256 deadlyHF = 1.0e18; 
        
        bytes memory swapVMPayload = abi.encode(deadlyHF);

        vm.expectRevert("MarginMM: Trade causes liquidation!");
        vm.prank(taker);
        vault.executeSwapInstruction(taker, address(token), 100 ether, swapVMPayload);
    }

    // ==========================================
    // FUZZ TESTS
    // ==========================================

    function testFuzz_DynamicFeeNeverRevertsUnnecessarily(uint256 randomHF, uint256 randomLT) public {
        randomHF = bound(randomHF, pricingEngine.LIQUIDATION_THRESHOLD_HF(), type(uint128).max);
        randomLT = bound(randomLT, 100, 9900);

        aaveProvider.setMockLT(randomLT);

        uint256 fee = pricingEngine.calculateDynamicFee(randomHF, address(token));
        assertTrue(fee > 0, "Fee calculation should always return a positive bps value");
    }

    function testFuzz_ExecuteSwap(uint256 requestAmount) public {
        requestAmount = bound(requestAmount, 1, 10000 ether);
        uint256 safeHF = 1.8e18;

        bytes memory swapVMPayload = abi.encode(safeHF);

        vm.prank(taker);
        uint256 netOut = vault.executeSwapInstruction(taker, address(token), requestAmount, swapVMPayload);

        assertTrue(netOut <= requestAmount, "Net out cannot exceed requested amount");
    }
}