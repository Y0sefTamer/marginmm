// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

/// @notice Registry for signed market calibration and maker-owned strategy settings.
/// @dev Market shocks are calibrator-authored. The hard floor remains a maker preference.
contract MarginMMPolicy is EIP712, Ownable {
    uint256 public constant DEMO_FLOOR = 1.1e18;
    uint256 public constant MIN_FLOOR = 1.01e18;
    uint256 public constant MAX_FLOOR = 3e18;
    uint32 public constant MIN_SHOCK_BPS = 100;
    uint32 public constant MAX_SHOCK_BPS = 5_000;
    uint64 public constant MAX_POLICY_TTL = 6 hours;
    uint32 public constant SUPPORTED_MODEL_VERSION = 1;

    bytes32 public constant MARKET_POLICY_TYPEHASH = keccak256(
        "MarketPolicy(uint256 chainId,address policyRegistry,bytes32 pairId,uint32 shockBps,uint8 marketRegime,uint32 policyVersion,uint32 modelVersion,uint64 issuedAt,uint64 validUntil,uint64 evidenceBlockFrom,uint64 evidenceBlockTo,bytes32 evidenceHash)"
    );

    struct MarketPolicy {
        uint256 chainId;
        address policyRegistry;
        bytes32 pairId;
        uint32 shockBps;
        uint8 marketRegime;
        uint32 policyVersion;
        uint32 modelVersion;
        uint64 issuedAt;
        uint64 validUntil;
        uint64 evidenceBlockFrom;
        uint64 evidenceBlockTo;
        bytes32 evidenceHash;
    }

    struct MakerSettings {
        bytes32 pairId;
        uint256 hardFloorStressHF;
        uint32 policyVersion;
        uint256 revision;
        bool enabled;
    }

    address public calibrationSigner;

    mapping(bytes32 pairId => mapping(uint32 version => MarketPolicy policy)) private _marketPolicies;
    mapping(bytes32 pairId => mapping(uint32 version => bytes32 digest)) public policyDigest;
    mapping(bytes32 pairId => uint32 version) public latestPolicyVersion;
    mapping(address maker => mapping(bytes32 strategy => MakerSettings settings)) private _makerSettings;

    error InvalidConfiguration();
    error InvalidMarketPolicy();
    error InvalidMakerSettings();
    error InvalidCalibrationSignature(address recovered);
    error PolicyVersionAlreadyRegistered();
    error PolicyVersionNotIncreasing();
    error PolicyDigestMismatch();
    error PolicyNotRegistered();
    error PolicyDisabled();
    error PolicyExpired(uint64 validUntil);

    event CalibrationSignerUpdated(address indexed previousSigner, address indexed newSigner);
    event MarketPolicyRegistered(
        bytes32 indexed pairId,
        uint32 indexed policyVersion,
        uint32 shockBps,
        uint32 modelVersion,
        uint64 issuedAt,
        uint64 validUntil,
        bytes32 evidenceHash,
        bytes32 digest
    );
    event MakerSettingsUpdated(
        address indexed maker,
        bytes32 indexed strategy,
        bytes32 indexed pairId,
        uint256 hardFloorStressHF,
        uint32 policyVersion,
        uint256 revision,
        bool enabled
    );

    constructor(address initialOwner, address initialCalibrationSigner)
        EIP712("MarginMM Market Policy", "1")
        Ownable(initialOwner)
    {
        if (initialCalibrationSigner == address(0)) revert InvalidConfiguration();
        calibrationSigner = initialCalibrationSigner;
        emit CalibrationSignerUpdated(address(0), initialCalibrationSigner);
    }

    function setCalibrationSigner(address newSigner) external onlyOwner {
        if (newSigner == address(0)) revert InvalidConfiguration();
        address previous = calibrationSigner;
        calibrationSigner = newSigner;
        emit CalibrationSignerUpdated(previous, newSigner);
    }

    function hashMarketPolicy(MarketPolicy calldata artifact) public view returns (bytes32) {
        return _hashTypedDataV4(_hashMarketPolicyStruct(artifact));
    }

    function registerMarketPolicy(MarketPolicy calldata artifact, bytes calldata signature)
        external
        returns (bytes32 digest)
    {
        digest = _validateSignedPolicy(artifact, signature);
        if (policyDigest[artifact.pairId][artifact.policyVersion] != bytes32(0)) {
            revert PolicyVersionAlreadyRegistered();
        }
        _storeMarketPolicy(artifact, digest);
    }

    /// @notice Atomically register a signed artifact and activate it for the caller's strategy.
    /// @dev If another account registered the exact artifact first, activation remains safe.
    function approveMarketPolicy(
        bytes32 strategy,
        uint256 hardFloorStressHF,
        MarketPolicy calldata artifact,
        bytes calldata signature
    ) external {
        bytes32 digest = _validateSignedPolicy(artifact, signature);
        bytes32 existing = policyDigest[artifact.pairId][artifact.policyVersion];
        if (existing == bytes32(0)) {
            _storeMarketPolicy(artifact, digest);
        } else if (existing != digest) {
            revert PolicyDigestMismatch();
        }
        _setMakerSettings(msg.sender, strategy, artifact.pairId, hardFloorStressHF, artifact.policyVersion);
    }

    function setMakerSettings(bytes32 strategy, bytes32 pairId, uint256 hardFloorStressHF, uint32 policyVersion)
        external
    {
        _setMakerSettings(msg.sender, strategy, pairId, hardFloorStressHF, policyVersion);
    }

    function disableStrategy(bytes32 strategy) external {
        MakerSettings storage settings = _makerSettings[msg.sender][strategy];
        if (strategy == bytes32(0) || !settings.enabled) revert InvalidMakerSettings();
        settings.enabled = false;
        uint256 nextRevision = ++settings.revision;
        emit MakerSettingsUpdated(
            msg.sender,
            strategy,
            settings.pairId,
            settings.hardFloorStressHF,
            settings.policyVersion,
            nextRevision,
            false
        );
    }

    function marketPolicy(bytes32 pairId, uint32 policyVersion) external view returns (MarketPolicy memory) {
        return _marketPolicies[pairId][policyVersion];
    }

    function makerSettings(address maker, bytes32 strategy) external view returns (MakerSettings memory) {
        return _makerSettings[maker][strategy];
    }

    function activePolicy(address maker, bytes32 strategy)
        public
        view
        returns (MarketPolicy memory marketPolicy_, MakerSettings memory settings)
    {
        settings = _makerSettings[maker][strategy];
        if (!settings.enabled) revert PolicyDisabled();
        marketPolicy_ = _marketPolicies[settings.pairId][settings.policyVersion];
        _requireUsable(marketPolicy_);
    }

    /// @notice Convenience view retained for current router and UI integrations.
    function riskFloor(address maker, bytes32 strategy) external view returns (uint256) {
        MakerSettings memory settings = _makerSettings[maker][strategy];
        if (!settings.enabled) return 0;
        _requireUsable(_marketPolicies[settings.pairId][settings.policyVersion]);
        return settings.hardFloorStressHF;
    }

    function revision(address maker, bytes32 strategy) external view returns (uint256) {
        return _makerSettings[maker][strategy].revision;
    }

    function _setMakerSettings(
        address maker,
        bytes32 strategy,
        bytes32 pairId,
        uint256 hardFloorStressHF,
        uint32 policyVersion
    ) private {
        if (
            strategy == bytes32(0) || pairId == bytes32(0) || hardFloorStressHF < MIN_FLOOR
                || hardFloorStressHF > MAX_FLOOR
        ) revert InvalidMakerSettings();
        _requireUsable(_marketPolicies[pairId][policyVersion]);

        MakerSettings storage settings = _makerSettings[maker][strategy];
        settings.pairId = pairId;
        settings.hardFloorStressHF = hardFloorStressHF;
        settings.policyVersion = policyVersion;
        settings.enabled = true;
        uint256 nextRevision = ++settings.revision;
        emit MakerSettingsUpdated(maker, strategy, pairId, hardFloorStressHF, policyVersion, nextRevision, true);
    }

    function _storeMarketPolicy(MarketPolicy calldata artifact, bytes32 digest) private {
        uint32 latest = latestPolicyVersion[artifact.pairId];
        if (artifact.policyVersion <= latest) revert PolicyVersionNotIncreasing();
        _marketPolicies[artifact.pairId][artifact.policyVersion] = artifact;
        policyDigest[artifact.pairId][artifact.policyVersion] = digest;
        latestPolicyVersion[artifact.pairId] = artifact.policyVersion;
        emit MarketPolicyRegistered(
            artifact.pairId,
            artifact.policyVersion,
            artifact.shockBps,
            artifact.modelVersion,
            artifact.issuedAt,
            artifact.validUntil,
            artifact.evidenceHash,
            digest
        );
    }

    function _validateSignedPolicy(MarketPolicy calldata artifact, bytes calldata signature)
        private
        view
        returns (bytes32 digest)
    {
        _validateArtifact(artifact);
        digest = hashMarketPolicy(artifact);
        address recovered = ECDSA.recover(digest, signature);
        if (recovered != calibrationSigner) revert InvalidCalibrationSignature(recovered);
    }

    function _validateArtifact(MarketPolicy calldata artifact) private view {
        if (
            artifact.chainId != block.chainid || artifact.policyRegistry != address(this)
                || artifact.pairId == bytes32(0) || artifact.shockBps < MIN_SHOCK_BPS
                || artifact.shockBps > MAX_SHOCK_BPS || artifact.policyVersion == 0 || artifact.marketRegime < 1
                || artifact.marketRegime > 3 || artifact.modelVersion != SUPPORTED_MODEL_VERSION
                || artifact.issuedAt == 0 || artifact.issuedAt > block.timestamp
                || artifact.validUntil <= artifact.issuedAt || artifact.validUntil - artifact.issuedAt > MAX_POLICY_TTL
                || block.timestamp > artifact.validUntil || artifact.evidenceBlockFrom > artifact.evidenceBlockTo
                || artifact.evidenceHash == bytes32(0)
        ) revert InvalidMarketPolicy();
    }

    function _requireUsable(MarketPolicy memory artifact) private view {
        if (policyDigest[artifact.pairId][artifact.policyVersion] == bytes32(0)) {
            revert PolicyNotRegistered();
        }
        if (block.timestamp > artifact.validUntil) revert PolicyExpired(artifact.validUntil);
    }

    function _hashMarketPolicyStruct(MarketPolicy calldata artifact) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                MARKET_POLICY_TYPEHASH,
                artifact.chainId,
                artifact.policyRegistry,
                artifact.pairId,
                artifact.shockBps,
                artifact.marketRegime,
                artifact.policyVersion,
                artifact.modelVersion,
                artifact.issuedAt,
                artifact.validUntil,
                artifact.evidenceBlockFrom,
                artifact.evidenceBlockTo,
                artifact.evidenceHash
            )
        );
    }
}
