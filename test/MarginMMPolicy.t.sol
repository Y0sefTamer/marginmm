// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import {Test} from "forge-std/Test.sol";
import {MarginMMPolicy} from "../src/MarginMMPolicy.sol";

contract MarginMMPolicyTest is Test {
    MarginMMPolicy internal policy;
    address internal maker = address(0xA11CE);
    bytes32 internal strategy = keccak256("strategy");

    function setUp() public {
        policy = new MarginMMPolicy();
    }

    function testOwnerNamespaceAndStrategyIsolation() public {
        vm.prank(maker);
        policy.setRiskFloor(strategy, 1.1e18);
        policy.setRiskFloor(strategy, 1.2e18);
        assertEq(policy.riskFloor(maker, strategy), 1.1e18);
        assertEq(policy.riskFloor(address(this), strategy), 1.2e18);
        assertEq(policy.riskFloor(maker, keccak256("another")), 0);
    }

    function testUpdateDisableAndRevision() public {
        policy.setRiskFloor(strategy, 1.1e18);
        policy.setRiskFloor(strategy, 1.2e18);
        assertEq(policy.riskFloor(address(this), strategy), 1.2e18);
        policy.setRiskFloor(strategy, 0);
        assertEq(policy.riskFloor(address(this), strategy), 0);
        assertEq(policy.revision(address(this), strategy), 3);
    }

    function testInvalidFloorsAndEmptyStrategy() public {
        vm.expectRevert(MarginMMPolicy.InvalidPolicy.selector);
        policy.setRiskFloor(strategy, 1e18);
        vm.expectRevert(MarginMMPolicy.InvalidPolicy.selector);
        policy.setRiskFloor(strategy, 3e18 + 1);
        vm.expectRevert(MarginMMPolicy.InvalidPolicy.selector);
        policy.setRiskFloor(bytes32(0), 1.1e18);
    }

    function testFuzzValidFloor(uint256 floor) public {
        floor = bound(floor, policy.MIN_FLOOR(), policy.MAX_FLOOR());
        policy.setRiskFloor(strategy, floor);
        assertEq(policy.riskFloor(address(this), strategy), floor);
    }
}
