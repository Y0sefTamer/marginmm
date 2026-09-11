import {
  getAddress,
  keccak256,
  Signature,
  toUtf8Bytes,
  TypedDataEncoder,
  verifyTypedData,
  Wallet,
  type TypedDataField,
} from "ethers";
import {
  MAX_POLICY_TTL,
  MAX_SHOCK_BPS,
  MIN_SHOCK_BPS,
  MODEL_VERSION,
  type CalibrationArtifact,
} from "./calibration.js";

export const MARKET_POLICY_DOMAIN_NAME = "MarginMM Market Policy";
export const MARKET_POLICY_DOMAIN_VERSION = "1";

export const MARKET_POLICY_TYPES: Record<string, TypedDataField[]> = {
  MarketPolicy: [
    { name: "chainId", type: "uint256" },
    { name: "policyRegistry", type: "address" },
    { name: "pairId", type: "bytes32" },
    { name: "shockBps", type: "uint32" },
    { name: "marketRegime", type: "uint8" },
    { name: "policyVersion", type: "uint32" },
    { name: "modelVersion", type: "uint32" },
    { name: "issuedAt", type: "uint64" },
    { name: "validUntil", type: "uint64" },
    { name: "evidenceBlockFrom", type: "uint64" },
    { name: "evidenceBlockTo", type: "uint64" },
    { name: "evidenceHash", type: "bytes32" },
  ],
};

export interface SignedCalibration {
  artifact: CalibrationArtifact;
  signature: string;
  digest: string;
  signer: string;
}

export interface ArtifactValidationContext {
  now: number;
  chainId: bigint;
  policyRegistry: string;
  pairId: string;
  policyVersion: number;
  calibrationSigner: string;
}

export async function signCalibrationArtifact(
  artifact: CalibrationArtifact,
  calibrationPrivateKey: string,
  expectedSigner: string,
  now: number,
): Promise<SignedCalibration> {
  validateArtifactShape(artifact, now);
  const wallet = new Wallet(calibrationPrivateKey);
  if (wallet.address !== getAddress(expectedSigner)) throw new Error("Calibration private key does not match configured signer");
  const domain = domainFor(artifact);
  const signature = await wallet.signTypedData(domain, MARKET_POLICY_TYPES, artifact);
  const digest = TypedDataEncoder.hash(domain, MARKET_POLICY_TYPES, artifact);
  const signed = { artifact, signature, digest, signer: wallet.address };
  validateSignedCalibration(signed, {
    now,
    chainId: artifact.chainId,
    policyRegistry: artifact.policyRegistry,
    pairId: artifact.pairId,
    policyVersion: artifact.policyVersion,
    calibrationSigner: expectedSigner,
  });
  return signed;
}

export function validateSignedCalibration(
  signed: SignedCalibration,
  context: ArtifactValidationContext,
): void {
  validateArtifactShape(signed.artifact, context.now);
  if (
    signed.artifact.chainId !== context.chainId
    || getAddress(signed.artifact.policyRegistry) !== getAddress(context.policyRegistry)
    || signed.artifact.pairId.toLowerCase() !== context.pairId.toLowerCase()
    || signed.artifact.policyVersion !== context.policyVersion
  ) {
    throw new Error("Calibration artifact does not match the requested policy context");
  }
  const domain = domainFor(signed.artifact);
  const digest = TypedDataEncoder.hash(domain, MARKET_POLICY_TYPES, signed.artifact);
  if (digest !== signed.digest) throw new Error("Calibration artifact digest mismatch");
  Signature.from(signed.signature);
  const recovered = verifyTypedData(domain, MARKET_POLICY_TYPES, signed.artifact, signed.signature);
  const expected = getAddress(context.calibrationSigner);
  if (getAddress(signed.signer) !== expected || recovered !== expected) {
    throw new Error("Calibration signature is not from the configured signer");
  }
}

export function validateSignedCalibrationEvidence(
  signed: SignedCalibration,
  canonicalEvidence: string,
  context: ArtifactValidationContext,
): void {
  validateSignedCalibration(signed, context);
  if (keccak256(toUtf8Bytes(canonicalEvidence)) !== signed.artifact.evidenceHash) {
    throw new Error("Calibration evidence does not match the signed evidence hash");
  }
}

export function validateArtifactShape(artifact: CalibrationArtifact, now: number): void {
  if (artifact.chainId <= 0n) throw new Error("Invalid artifact chain ID");
  getAddress(artifact.policyRegistry);
  if (!/^0x[0-9a-fA-F]{64}$/.test(artifact.pairId) || /^0x0{64}$/.test(artifact.pairId)) {
    throw new Error("Invalid artifact pair ID");
  }
  if (artifact.shockBps < MIN_SHOCK_BPS || artifact.shockBps > MAX_SHOCK_BPS) {
    throw new Error("Artifact shock is outside the accepted security envelope");
  }
  if (![1, 2, 3].includes(artifact.marketRegime)) throw new Error("Unsupported market regime");
  if (!Number.isInteger(artifact.policyVersion) || artifact.policyVersion <= 0 || artifact.policyVersion > 0xffff_ffff) {
    throw new Error("Invalid artifact policy version");
  }
  if (artifact.modelVersion !== MODEL_VERSION) throw new Error("Unsupported calibration model version");
  if (
    !Number.isSafeInteger(now)
    || !Number.isSafeInteger(artifact.issuedAt)
    || !Number.isSafeInteger(artifact.validUntil)
    || artifact.issuedAt <= 0
    || artifact.issuedAt > now
    || artifact.validUntil <= artifact.issuedAt
    || artifact.validUntil - artifact.issuedAt > MAX_POLICY_TTL
    || now > artifact.validUntil
  ) {
    throw new Error("Artifact validity window is invalid or expired");
  }
  if (
    !Number.isSafeInteger(artifact.evidenceBlockFrom)
    || !Number.isSafeInteger(artifact.evidenceBlockTo)
    || artifact.evidenceBlockFrom < 0
    || artifact.evidenceBlockFrom > artifact.evidenceBlockTo
  ) {
    throw new Error("Invalid artifact evidence block range");
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(artifact.evidenceHash) || /^0x0{64}$/.test(artifact.evidenceHash)) {
    throw new Error("Invalid artifact evidence hash");
  }
}

function domainFor(artifact: CalibrationArtifact) {
  return {
    name: MARKET_POLICY_DOMAIN_NAME,
    version: MARKET_POLICY_DOMAIN_VERSION,
    chainId: artifact.chainId,
    verifyingContract: getAddress(artifact.policyRegistry),
  };
}
