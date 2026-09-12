import type { GraphEvidence } from "./graph.js";
export declare const MIN_SHOCK_BPS = 100;
export declare const MAX_SHOCK_BPS = 5000;
export declare const MAX_POLICY_TTL: number;
export declare const MODEL_VERSION = 1;
export interface CalibrationArtifact {
    chainId: bigint;
    policyRegistry: string;
    pairId: string;
    shockBps: number;
    marketRegime: number;
    policyVersion: number;
    modelVersion: number;
    issuedAt: number;
    validUntil: number;
    evidenceBlockFrom: number;
    evidenceBlockTo: number;
    evidenceHash: string;
}
export interface CalibrationResult {
    artifact: CalibrationArtifact;
    diagnostics: {
        observationCount: number;
        q99DownsideBps: number;
        twoSigmaDownsideBps: number;
        maxDrawdownBps: number;
        shockBps: number;
        aaveUtilization: {
            weth: string;
            usdc: string;
        };
        marketDeployment: string;
        aaveDeployment: string;
    };
    canonicalEvidence: string;
}
export interface CalibrationRequest {
    chainId: bigint;
    policyRegistry: string;
    pairId: string;
    policyVersion: number;
    issuedAt: number;
    validUntil: number;
}
export declare function calibrate(evidence: GraphEvidence, request: CalibrationRequest): CalibrationResult;
export declare function canonicalJson(value: unknown): string;
