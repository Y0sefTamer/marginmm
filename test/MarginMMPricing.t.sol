// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {MarginMMPricing} from "../src/MarginMMPricing.sol";

contract MarginMMPricingTest is Test {
    MarginMMPricing internal pricing;

    function setUp() public {
        pricing = new MarginMMPricing(1.10e18, 1.50e18, 10, 50);
    }

    function test_SafeHFGetsMinimumFee() public {
        assertEq(pricing.calculateDynamicFee(1.50e18), 10);
        assertEq(pricing.calculateDynamicFee(2e18), 10);
    }

    function test_FeeIncreasesAsRiskIncreases() public {
        uint256 safe = pricing.calculateDynamicFee(1.45e18);
        uint256 riskier = pricing.calculateDynamicFee(1.20e18);
        assertGt(riskier, safe);
        assertLe(riskier, 50);
    }

    function test_RevertBelowGuard() public {
        vm.expectRevert();
        pricing.calculateDynamicFee(1.099e18);
    }
}
