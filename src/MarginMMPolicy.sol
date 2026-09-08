// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Maker-owned risk policies for immutable Aqua strategy hashes.
/// @dev Zero means disabled. A floor is a scenario policy, not a universal safety guarantee.
contract MarginMMPolicy {
    uint256 public constant DEMO_FLOOR = 1.1e18;
    uint256 public constant MIN_FLOOR = 1.01e18;
    uint256 public constant MAX_FLOOR = 3e18;

    mapping(address maker => mapping(bytes32 strategy => uint256 floor)) public riskFloor;
    mapping(address maker => mapping(bytes32 strategy => uint256 revision)) public revision;

    error InvalidPolicy();
    event PolicyUpdated(address indexed maker, bytes32 indexed strategy, uint256 floor, uint256 revision);

    function setRiskFloor(bytes32 strategy, uint256 floor) external {
        if (strategy == bytes32(0) || (floor != 0 && (floor < MIN_FLOOR || floor > MAX_FLOOR))) {
            revert InvalidPolicy();
        }
        riskFloor[msg.sender][strategy] = floor;
        uint256 next = ++revision[msg.sender][strategy];
        emit PolicyUpdated(msg.sender, strategy, floor, next);
    }
}
