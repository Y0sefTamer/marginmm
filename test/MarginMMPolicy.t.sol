// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {MarginMMPolicy} from "../src/MarginMMPolicy.sol";

contract MarginMMPolicyTest is Test {
    uint256 internal constant CALIBRATOR_KEY = 0xCA11B;

    MarginMMPolicy internal policy;
    address internal calibrator;
    address internal maker = address(0xA11CE);
    bytes32 internal strategy = keccak256("strategy");
    bytes32 internal pairId = keccak256("aWETH/aUSDC:USDC-debt:v1");

    function setUp() public {
        vm.warp(1_800_000_000);
        calibrator = vm.addr(CALIBRATOR_KEY);
        policy = new MarginMMPolicy(address(this), calibrator);
    }

    function testRegisterAndMakerApprovalAreSeparatedAndNamespaced() public {
        MarginMMPolicy.MarketPolicy memory artifact = _artifact(1, 1_240, uint64(block.timestamp));
        bytes memory signature = _sign(artifact, CALIBRATOR_KEY);

        vm.prank(address(0xB0B));
        bytes32 digest = policy.registerMarketPolicy(artifact, signature);
        assertEq(digest, policy.policyDigest(pairId, 1));

        vm.prank(maker);
        policy.setMakerSettings(strategy, pairId, 1.1e18, 1);

        (MarginMMPolicy.MarketPolicy memory active, MarginMMPolicy.MakerSettings memory settings) =
            policy.activePolicy(maker, strategy);
        assertEq(active.shockBps, 1_240);
        assertEq(settings.hardFloorStressHF, 1.1e18);
        assertEq(settings.policyVersion, 1);
        assertEq(settings.revision, 1);
        assertTrue(settings.enabled);
        assertEq(policy.riskFloor(maker, strategy), 1.1e18);
        assertEq(policy.riskFloor(address(this), strategy), 0);
    }

    function testMakerCanAtomicallyApproveSignedPolicy() public {
        MarginMMPolicy.MarketPolicy memory artifact = _artifact(1, 1_240, uint64(block.timestamp));
        bytes memory signature = _sign(artifact, CALIBRATOR_KEY);

        vm.prank(maker);
        policy.approveMarketPolicy(strategy, 1.1e18, artifact, signature);

        assertEq(policy.latestPolicyVersion(pairId), 1);
        assertEq(policy.riskFloor(maker, strategy), 1.1e18);
    }

    function testShockBoundsRejectInsteadOfClamp() public {
        MarginMMPolicy.MarketPolicy memory artifact = _artifact(1, 99, uint64(block.timestamp));
        _expectInvalidArtifact(artifact);

        artifact.shockBps = 5_001;
        _expectInvalidArtifact(artifact);
    }

    function testTTLIsMeasuredFromIssuanceAndExpiresFailClosed() public {
        uint64 issuedAt = uint64(block.timestamp - 5 hours);
        MarginMMPolicy.MarketPolicy memory artifact = _artifact(1, 1_240, issuedAt);
        artifact.validUntil = issuedAt + policy.MAX_POLICY_TTL();
        bytes memory signature = _sign(artifact, CALIBRATOR_KEY);
        vm.prank(maker);
        policy.approveMarketPolicy(strategy, 1.1e18, artifact, signature);

        assertEq(artifact.validUntil - uint64(block.timestamp), 1 hours);
        vm.warp(artifact.validUntil);
        assertEq(policy.riskFloor(maker, strategy), 1.1e18);
        vm.warp(artifact.validUntil + 1);
        vm.expectRevert(abi.encodeWithSelector(MarginMMPolicy.PolicyExpired.selector, artifact.validUntil));
        policy.riskFloor(maker, strategy);
    }

    function testRejectsInvalidIssuanceWindow() public {
        MarginMMPolicy.MarketPolicy memory artifact = _artifact(1, 1_240, uint64(block.timestamp));

        artifact.validUntil = artifact.issuedAt;
        _expectInvalidArtifact(artifact);

        artifact = _artifact(1, 1_240, uint64(block.timestamp));
        artifact.validUntil = artifact.issuedAt + policy.MAX_POLICY_TTL() + 1;
        _expectInvalidArtifact(artifact);

        artifact = _artifact(1, 1_240, uint64(block.timestamp + 1));
        _expectInvalidArtifact(artifact);

        artifact = _artifact(1, 1_240, uint64(block.timestamp - 1 hours));
        artifact.validUntil = uint64(block.timestamp - 1);
        _expectInvalidArtifact(artifact);
    }

    function testSignatureDomainAndArtifactIdentityAreEnforced() public {
        MarginMMPolicy.MarketPolicy memory artifact = _artifact(1, 1_240, uint64(block.timestamp));
        bytes memory signature = _sign(artifact, 0xBAD);
        vm.expectRevert(abi.encodeWithSelector(MarginMMPolicy.InvalidCalibrationSignature.selector, vm.addr(0xBAD)));
        policy.registerMarketPolicy(artifact, signature);

        artifact.chainId = block.chainid + 1;
        _expectInvalidArtifact(artifact);

        artifact = _artifact(1, 1_240, uint64(block.timestamp));
        artifact.policyRegistry = address(0xDEAD);
        _expectInvalidArtifact(artifact);

        artifact = _artifact(1, 1_240, uint64(block.timestamp));
        artifact.modelVersion = policy.SUPPORTED_MODEL_VERSION() + 1;
        _expectInvalidArtifact(artifact);

        artifact = _artifact(1, 1_240, uint64(block.timestamp));
        artifact.marketRegime = 0;
        _expectInvalidArtifact(artifact);

        artifact.marketRegime = 4;
        _expectInvalidArtifact(artifact);
    }

    function testVersionsAreUniqueMonotonicAndCannotExtendTTLByReplay() public {
        MarginMMPolicy.MarketPolicy memory v2 = _artifact(2, 1_240, uint64(block.timestamp));
        policy.registerMarketPolicy(v2, _sign(v2, CALIBRATOR_KEY));

        bytes memory v2Signature = _sign(v2, CALIBRATOR_KEY);
        vm.expectRevert(MarginMMPolicy.PolicyVersionAlreadyRegistered.selector);
        policy.registerMarketPolicy(v2, v2Signature);

        MarginMMPolicy.MarketPolicy memory extended = v2;
        extended.validUntil += 1;
        bytes memory extendedSignature = _sign(extended, CALIBRATOR_KEY);
        vm.prank(maker);
        vm.expectRevert(MarginMMPolicy.PolicyDigestMismatch.selector);
        policy.approveMarketPolicy(strategy, 1.1e18, extended, extendedSignature);

        MarginMMPolicy.MarketPolicy memory v1 = _artifact(1, 1_000, uint64(block.timestamp));
        bytes memory v1Signature = _sign(v1, CALIBRATOR_KEY);
        vm.expectRevert(MarginMMPolicy.PolicyVersionNotIncreasing.selector);
        policy.registerMarketPolicy(v1, v1Signature);
    }

    function testMakerChoosesVersionAndRevisionChangesOnEverySettingMutation() public {
        MarginMMPolicy.MarketPolicy memory v1 = _artifact(1, 1_000, uint64(block.timestamp));
        MarginMMPolicy.MarketPolicy memory v2 = _artifact(2, 1_240, uint64(block.timestamp));
        policy.registerMarketPolicy(v1, _sign(v1, CALIBRATOR_KEY));
        policy.registerMarketPolicy(v2, _sign(v2, CALIBRATOR_KEY));

        vm.startPrank(maker);
        policy.setMakerSettings(strategy, pairId, 1.1e18, 1);
        policy.setMakerSettings(strategy, pairId, 1.2e18, 2);
        policy.disableStrategy(strategy);
        vm.stopPrank();

        MarginMMPolicy.MakerSettings memory settings = policy.makerSettings(maker, strategy);
        assertEq(settings.policyVersion, 2);
        assertEq(settings.hardFloorStressHF, 1.2e18);
        assertEq(settings.revision, 3);
        assertFalse(settings.enabled);
        assertEq(policy.riskFloor(maker, strategy), 0);
    }

    function testInvalidMakerSettingsAndUnregisteredVersionFailClosed() public {
        vm.startPrank(maker);
        vm.expectRevert(MarginMMPolicy.InvalidMakerSettings.selector);
        policy.setMakerSettings(bytes32(0), pairId, 1.1e18, 1);
        vm.expectRevert(MarginMMPolicy.InvalidMakerSettings.selector);
        policy.setMakerSettings(strategy, pairId, 1e18, 1);
        vm.expectRevert(MarginMMPolicy.PolicyNotRegistered.selector);
        policy.setMakerSettings(strategy, pairId, 1.1e18, 1);
        vm.stopPrank();
    }

    function testOnlyOwnerCanRotateCalibrationSigner() public {
        address replacement = address(0x1234);
        vm.prank(maker);
        vm.expectRevert();
        policy.setCalibrationSigner(replacement);
        policy.setCalibrationSigner(replacement);
        assertEq(policy.calibrationSigner(), replacement);
        vm.expectRevert(MarginMMPolicy.InvalidConfiguration.selector);
        policy.setCalibrationSigner(address(0));
    }

    function testFuzzValidFloorShockAndTTL(uint256 floor, uint32 shockBps, uint64 ttl) public {
        floor = bound(floor, policy.MIN_FLOOR(), policy.MAX_FLOOR());
        shockBps = uint32(bound(shockBps, policy.MIN_SHOCK_BPS(), policy.MAX_SHOCK_BPS()));
        ttl = uint64(bound(ttl, 1, policy.MAX_POLICY_TTL()));
        MarginMMPolicy.MarketPolicy memory artifact = _artifact(1, shockBps, uint64(block.timestamp));
        artifact.validUntil = artifact.issuedAt + ttl;
        bytes memory signature = _sign(artifact, CALIBRATOR_KEY);

        vm.prank(maker);
        policy.approveMarketPolicy(strategy, floor, artifact, signature);
        (MarginMMPolicy.MarketPolicy memory active, MarginMMPolicy.MakerSettings memory settings) =
            policy.activePolicy(maker, strategy);
        assertEq(active.shockBps, shockBps);
        assertEq(settings.hardFloorStressHF, floor);
    }

    function _artifact(uint32 version, uint32 shockBps, uint64 issuedAt)
        internal
        view
        returns (MarginMMPolicy.MarketPolicy memory artifact)
    {
        artifact = MarginMMPolicy.MarketPolicy({
            chainId: block.chainid,
            policyRegistry: address(policy),
            pairId: pairId,
            shockBps: shockBps,
            marketRegime: 1,
            policyVersion: version,
            modelVersion: policy.SUPPORTED_MODEL_VERSION(),
            issuedAt: issuedAt,
            validUntil: issuedAt + 2 hours,
            evidenceBlockFrom: 20_000_000,
            evidenceBlockTo: 20_000_100,
            evidenceHash: keccak256(abi.encode("graph-evidence", version))
        });
    }

    function _sign(MarginMMPolicy.MarketPolicy memory artifact, uint256 signerKey)
        internal
        view
        returns (bytes memory)
    {
        bytes32 digest = policy.hashMarketPolicy(artifact);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function _expectInvalidArtifact(MarginMMPolicy.MarketPolicy memory artifact) internal {
        bytes memory signature = _sign(artifact, CALIBRATOR_KEY);
        vm.expectRevert(MarginMMPolicy.InvalidMarketPolicy.selector);
        policy.registerMarketPolicy(artifact, signature);
    }
}
