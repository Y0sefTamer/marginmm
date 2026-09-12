import { type Model } from "@openai/agents";
import type { SettleResponse } from "@x402/core/types";
import { type CalibrationApiRequest, type CalibrationApiResponse } from "./calibration-service.js";
import { fetchGraphEvidence, type GraphEvidenceConfig } from "./graph.js";
import { HEDERA_TESTNET, type HbarPaymentConfig } from "./x402.js";
export declare const GROQ_OPENAI_BASE_URL = "https://api.groq.com/openai/v1";
export interface RiskAgentConfig extends HbarPaymentConfig {
    ethereumRpcUrl: string;
    policyRegistry: string;
    pairId: string;
    maker: string;
    strategy: string;
    makerHardFloorStressHF: string;
    calibrationSignerAddress: string;
    calibrationServiceUrl: string;
    agentAccountId: string;
    agentPrivateKey: string;
    graph: GraphEvidenceConfig;
    refreshLeadSeconds: number;
    policyValiditySeconds: number;
    forceRefresh: boolean;
    modelApiKey: string;
    modelBaseUrl: string;
    model: string;
}
export interface PolicyStatus {
    state: "missing" | "disabled" | "valid" | "expiring" | "expired";
    chainTimestamp: number;
    latestPolicyVersion: number;
    activePolicyVersion: number;
    revision: string;
    hardFloorStressHF: string;
    shockBps: number;
    validUntil: number;
    secondsRemaining: number;
}
export interface GraphEvidenceSummary {
    queriedAt: number;
    observationCount: number;
    marketDeployment: string;
    marketIndexedBlock: number;
    aaveDeployment: string;
    aaveIndexedBlock: number;
}
export interface HederaPaymentReceipt {
    transaction: string;
    network: typeof HEDERA_TESTNET;
    payer?: string;
    amount?: string;
    idempotentReplay: boolean;
}
export interface RiskPolicyProposal {
    decision: "proposal_ready" | "no_refresh";
    headline: string;
    rationale: string[];
    policyStatus: PolicyStatus;
    graphEvidence?: GraphEvidenceSummary;
    paymentReceipt?: HederaPaymentReceipt;
    calibration?: CalibrationApiResponse;
    strategy: string;
    makerHardFloorStressHF: string;
}
export interface RiskAgentDependencies {
    model?: Model;
    readPolicyStatus?: (config: RiskAgentConfig) => Promise<PolicyStatus>;
    fetchGraphEvidence?: typeof fetchGraphEvidence;
    paidRequester?: (body: string, idempotencyKey: string) => Promise<Response>;
    wallClockSeconds?: () => number;
    chainTimestampSeconds?: () => number | Promise<number>;
}
/**
 * Carries the only retry classification the demo backend may trust.
 * A false value proves the paid HTTP request was never started; an unknown or
 * true value must remain fail-closed so a requester cannot be charged twice.
 */
export declare class RiskAgentWorkflowError extends Error {
    readonly paymentMayHaveBeenAttempted: boolean;
    constructor(message: string, paymentMayHaveBeenAttempted: boolean, cause: unknown);
}
export declare function assessRefreshNeed(status: PolicyStatus, forceRefresh: boolean): boolean;
export declare function validateHederaSettlement(receipt: SettleResponse, expectedAmount: string): HederaPaymentReceipt;
export declare function validateCalibrationApiResponse(value: unknown, expectedRequest: CalibrationApiRequest, config: Pick<RiskAgentConfig, "policyRegistry" | "pairId" | "calibrationSignerAddress">, chainTimestamp: number): CalibrationApiResponse;
export declare function runRiskAgent(config: RiskAgentConfig, dependencies?: RiskAgentDependencies): Promise<RiskPolicyProposal>;
