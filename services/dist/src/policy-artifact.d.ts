import { type TypedDataField } from "ethers";
import { type CalibrationArtifact } from "./calibration.js";
export declare const MARKET_POLICY_DOMAIN_NAME = "MarginMM Market Policy";
export declare const MARKET_POLICY_DOMAIN_VERSION = "1";
export declare const MARKET_POLICY_TYPES: Record<string, TypedDataField[]>;
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
export declare function signCalibrationArtifact(artifact: CalibrationArtifact, calibrationPrivateKey: string, expectedSigner: string, now: number): Promise<SignedCalibration>;
export declare function validateSignedCalibration(signed: SignedCalibration, context: ArtifactValidationContext): void;
export declare function validateSignedCalibrationEvidence(signed: SignedCalibration, canonicalEvidence: string, context: ArtifactValidationContext): void;
export declare function validateArtifactShape(artifact: CalibrationArtifact, now: number): void;
