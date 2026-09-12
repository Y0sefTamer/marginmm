import { Agent, OpenAIProvider, Runner, tool } from "@openai/agents";
import { decodePaymentResponseHeader } from "@x402/core/http";
import { Contract, getAddress, JsonRpcProvider } from "ethers";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CALIBRATION_HORIZON, CALIBRATION_PAIR, CALIBRATION_PROFILE, calibrationRequestHash, parseCalibrationApiRequest, readLatestChainTimestamp, } from "./calibration-service.js";
import { MAX_POLICY_TTL, MAX_SHOCK_BPS, MIN_SHOCK_BPS, MODEL_VERSION } from "./calibration.js";
import { fetchGraphEvidence } from "./graph.js";
import { validateSignedCalibrationEvidence, } from "./policy-artifact.js";
import { createPaidCalibrationRequester, HEDERA_TESTNET, } from "./x402.js";
const POLICY_ABI = [
    "function makerSettings(address maker,bytes32 strategy) view returns (bytes32 pairId,uint256 hardFloorStressHF,uint32 policyVersion,uint256 revision,bool enabled)",
    "function marketPolicy(bytes32 pairId,uint32 policyVersion) view returns (uint256 chainId,address policyRegistry,bytes32 pairId,uint32 shockBps,uint8 marketRegime,uint32 policyVersion,uint32 modelVersion,uint64 issuedAt,uint64 validUntil,uint64 evidenceBlockFrom,uint64 evidenceBlockTo,bytes32 evidenceHash)",
    "function latestPolicyVersion(bytes32 pairId) view returns (uint32)",
];
export const GROQ_OPENAI_BASE_URL = "https://api.groq.com/openai/v1";
const bytes32Pattern = /^0x[0-9a-fA-F]{64}$/;
const responseSchema = z.object({
    schema: z.literal("marginmm-calibration-response-v1"),
    request: z.unknown(),
    signedCalibration: z.object({
        artifact: z.object({
            chainId: z.string().regex(/^[1-9][0-9]*$/),
            policyRegistry: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
            pairId: z.string().regex(bytes32Pattern),
            shockBps: z.number().int().min(MIN_SHOCK_BPS).max(MAX_SHOCK_BPS),
            marketRegime: z.number().int().min(1).max(3),
            policyVersion: z.number().int().min(1).max(0xffff_ffff),
            modelVersion: z.literal(MODEL_VERSION),
            issuedAt: z.number().int().positive(),
            validUntil: z.number().int().positive(),
            evidenceBlockFrom: z.number().int().nonnegative(),
            evidenceBlockTo: z.number().int().nonnegative(),
            evidenceHash: z.string().regex(bytes32Pattern),
        }).strict(),
        signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
        digest: z.string().regex(bytes32Pattern),
        signer: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    }).strict(),
    diagnostics: z.object({
        observationCount: z.number().int().positive(),
        q99DownsideBps: z.number().int().nonnegative(),
        twoSigmaDownsideBps: z.number().int().nonnegative(),
        maxDrawdownBps: z.number().int().nonnegative(),
        shockBps: z.number().int().min(MIN_SHOCK_BPS).max(MAX_SHOCK_BPS),
        aaveUtilization: z.object({ weth: z.string(), usdc: z.string() }).strict(),
        marketDeployment: z.string().min(1),
        aaveDeployment: z.string().min(1),
    }).strict(),
    canonicalEvidence: z.string().min(2).max(4_000_000),
}).strict();
const evidenceMetadataSchema = z.object({
    schema: z.literal("marginmm-evidence-v1"),
    model: z.object({
        version: z.literal(MODEL_VERSION),
        method: z.string().min(1),
        shockTarget: z.literal("WETH"),
        usdcMultiplierBps: z.literal(10_000),
    }),
    queriedAt: z.number().int().positive(),
    sources: z.object({
        market: z.object({
            subgraphDeployment: z.string().min(1),
            indexedBlock: z.object({ number: z.number().int().nonnegative() }),
            firstSwapBlock: z.number().int().nonnegative(),
            lastSwapBlock: z.number().int().nonnegative(),
        }),
        aave: z.object({
            subgraphDeployment: z.string().min(1),
            indexedBlock: z.object({ number: z.number().int().nonnegative() }),
        }),
    }),
    diagnostics: z.object({ shockBps: z.number().int() }),
});
const agentOutputSchema = z.object({
    decision: z.enum(["proposal_ready", "no_refresh"]),
    headline: z.string().min(1).max(180),
    rationale: z.array(z.string().min(1).max(280)).min(1).max(4),
}).strict();
/**
 * Carries the only retry classification the demo backend may trust.
 * A false value proves the paid HTTP request was never started; an unknown or
 * true value must remain fail-closed so a requester cannot be charged twice.
 */
export class RiskAgentWorkflowError extends Error {
    paymentMayHaveBeenAttempted;
    constructor(message, paymentMayHaveBeenAttempted, cause) {
        super(message);
        this.name = "RiskAgentWorkflowError";
        this.paymentMayHaveBeenAttempted = paymentMayHaveBeenAttempted;
        this.cause = cause;
    }
}
export function assessRefreshNeed(status, forceRefresh) {
    return forceRefresh || status.state !== "valid";
}
export function validateHederaSettlement(receipt, expectedAmount) {
    if (!receipt.success || receipt.network !== HEDERA_TESTNET || !receipt.transaction) {
        throw new Error("Hedera x402 settlement receipt is invalid");
    }
    if (receipt.amount !== undefined && receipt.amount !== expectedAmount) {
        throw new Error("Hedera x402 settled amount does not match the configured price");
    }
    return {
        transaction: receipt.transaction,
        network: HEDERA_TESTNET,
        ...(receipt.payer ? { payer: receipt.payer } : {}),
        ...(receipt.amount ? { amount: receipt.amount } : {}),
        idempotentReplay: false,
    };
}
export function validateCalibrationApiResponse(value, expectedRequest, config, chainTimestamp) {
    const parsed = responseSchema.parse(value);
    const returnedRequest = parseCalibrationApiRequest(parsed.request);
    if (calibrationRequestHash(returnedRequest) !== calibrationRequestHash(expectedRequest)) {
        throw new Error("Calibration response does not match the paid request");
    }
    const signed = {
        artifact: { ...parsed.signedCalibration.artifact, chainId: BigInt(parsed.signedCalibration.artifact.chainId) },
        signature: parsed.signedCalibration.signature,
        digest: parsed.signedCalibration.digest,
        signer: parsed.signedCalibration.signer,
    };
    validateSignedCalibrationEvidence(signed, parsed.canonicalEvidence, {
        now: chainTimestamp,
        chainId: 31337n,
        policyRegistry: config.policyRegistry,
        pairId: config.pairId,
        policyVersion: expectedRequest.policyVersion,
        calibrationSigner: config.calibrationSignerAddress,
    });
    validateEvidenceMetadata(parsed, signed);
    return parsed;
}
function validateEvidenceMetadata(parsed, signed) {
    let evidence;
    try {
        evidence = JSON.parse(parsed.canonicalEvidence);
    }
    catch {
        throw new Error("Canonical calibration evidence is not JSON");
    }
    const metadata = evidenceMetadataSchema.parse(evidence);
    const blockTo = Math.min(metadata.sources.market.lastSwapBlock, metadata.sources.market.indexedBlock.number, metadata.sources.aave.indexedBlock.number);
    if (metadata.sources.market.firstSwapBlock !== signed.artifact.evidenceBlockFrom
        || blockTo !== signed.artifact.evidenceBlockTo
        || metadata.diagnostics.shockBps !== signed.artifact.shockBps
        || parsed.diagnostics.shockBps !== signed.artifact.shockBps
        || parsed.diagnostics.marketDeployment !== metadata.sources.market.subgraphDeployment
        || parsed.diagnostics.aaveDeployment !== metadata.sources.aave.subgraphDeployment) {
        throw new Error("Calibration evidence metadata is inconsistent with the signed artifact");
    }
}
function signedGraphEvidenceSummary(calibration) {
    let evidence;
    try {
        evidence = JSON.parse(calibration.canonicalEvidence);
    }
    catch {
        throw new Error("Canonical calibration evidence is not JSON");
    }
    const metadata = evidenceMetadataSchema.parse(evidence);
    return {
        queriedAt: metadata.queriedAt,
        observationCount: calibration.diagnostics.observationCount,
        marketDeployment: metadata.sources.market.subgraphDeployment,
        marketIndexedBlock: metadata.sources.market.indexedBlock.number,
        aaveDeployment: metadata.sources.aave.subgraphDeployment,
        aaveIndexedBlock: metadata.sources.aave.indexedBlock.number,
    };
}
export async function runRiskAgent(config, dependencies = {}) {
    let state;
    let modelProvider;
    try {
        validateRiskAgentConfig(config);
        state = {
            config,
            dependencies,
            paymentAttempts: 0,
            paymentMayHaveBeenAttempted: false,
            proposalPrepared: false,
        };
        const tools = createRiskAgentTools();
        if (!dependencies.model) {
            modelProvider = new OpenAIProvider({
                apiKey: config.modelApiKey,
                baseURL: config.modelBaseUrl,
                useResponses: false,
                strictFeatureValidation: true,
            });
        }
        const agent = new Agent({
            name: "MarginMM Risk Agent",
            model: dependencies.model ?? config.model,
            instructions: [
                "You operate one narrow MarginMM policy-refresh workflow.",
                "Always call get_policy_status, then assess_refresh_need.",
                "If refresh is not needed, stop after assess_refresh_need. If it is needed, call get_graph_evidence, purchase_calibration, validate_calibration, and prepare_policy_proposal in that exact order.",
                "Never invent or alter shockBps, Health Factor, qMax, signatures, evidence, policy versions, payment facts, or maker floor values.",
                "You have no Ethereum signing, swap, borrow, repay, withdraw, ship, or dock capability. The Maker must approve the proposal in the browser.",
                "Keep the rationale factual and based only on tool outputs.",
                "After the required deterministic tools succeed, reply with a brief completion message and do not call another tool.",
            ].join(" "),
            tools,
            modelSettings: { temperature: 0 },
        });
        const runner = new Runner({
            ...(modelProvider ? { modelProvider } : {}),
            tracingDisabled: true,
            traceIncludeSensitiveData: false,
            workflowName: "MarginMM policy refresh",
        });
        const result = await runner.run(agent, "Assess the current policy and prepare a refresh proposal only if required.", {
            context: state,
            maxTurns: 10,
        });
        if (!result.finalOutput || !state.policyStatus) {
            throw new Error("Risk Agent did not produce a complete result");
        }
        const finalOutput = deterministicAgentDecision(state);
        if (finalOutput.decision === "proposal_ready" && (!state.proposalPrepared || !state.validatedCalibration)) {
            throw new Error("Risk Agent claimed a proposal without deterministic validation");
        }
        if (finalOutput.decision === "no_refresh" && state.refreshNeeded !== false) {
            throw new Error("Risk Agent claimed no refresh without deterministic approval");
        }
        return {
            ...finalOutput,
            policyStatus: state.policyStatus,
            ...(state.graphEvidence ? { graphEvidence: state.graphEvidence } : {}),
            ...(state.paymentReceipt ? { paymentReceipt: state.paymentReceipt } : {}),
            ...(state.validatedCalibration ? { calibration: state.validatedCalibration } : {}),
            strategy: config.strategy,
            makerHardFloorStressHF: config.makerHardFloorStressHF,
        };
    }
    catch (error) {
        if (error instanceof RiskAgentWorkflowError)
            throw error;
        const message = error instanceof Error ? error.message : "Risk Agent workflow failed";
        throw new RiskAgentWorkflowError(message, state?.paymentMayHaveBeenAttempted ?? false, error);
    }
    finally {
        await modelProvider?.close().catch(() => undefined);
    }
}
function deterministicAgentDecision(state) {
    if (state.refreshNeeded === false) {
        return {
            decision: "no_refresh",
            headline: "Current policy does not require refresh.",
            rationale: ["The deterministic policy status check found a valid policy outside the refresh window."],
        };
    }
    if (state.refreshNeeded === true && state.proposalPrepared && state.validatedCalibration) {
        return {
            decision: "proposal_ready",
            headline: "Signed calibration is ready for Maker review.",
            rationale: ["The paid calibration passed deterministic signature, evidence, policy-bound, and expiry validation."],
        };
    }
    throw new Error("Risk Agent stopped before every required deterministic step completed");
}
function createRiskAgentTools() {
    // Groq's OpenAI-compatible endpoint requires an explicit `properties`
    // member even for a tool whose only valid call is `{}`.
    const noArguments = z.object({ noop: z.boolean().optional() }).strict();
    return [
        tool({
            name: "get_policy_status",
            description: "Read the current MarginMM policy and maker settings from local Ethereum chain 31337. Read-only and must be first.",
            parameters: noArguments,
            execute: async (_input, runContext) => {
                const state = requiredState(runContext);
                if (state.policyStatus)
                    throw new Error("Policy status was already read");
                state.policyStatus = await (state.dependencies.readPolicyStatus ?? readPolicyStatus)(state.config);
                return JSON.stringify(state.policyStatus);
            },
        }),
        tool({
            name: "assess_refresh_need",
            description: "Deterministically decide whether the policy is missing, disabled, expired, expiring, or explicitly requested for refresh. Does not use LLM judgment.",
            parameters: noArguments,
            execute: (_input, runContext) => {
                const state = requiredState(runContext);
                if (!state.policyStatus)
                    throw new Error("Policy status must be read first");
                if (state.refreshNeeded !== undefined)
                    throw new Error("Refresh need was already assessed");
                state.refreshNeeded = assessRefreshNeed(state.policyStatus, state.config.forceRefresh);
                return JSON.stringify({ refreshNeeded: state.refreshNeeded, reason: state.policyStatus.state });
            },
        }),
        tool({
            name: "get_graph_evidence",
            description: "Load live WETH/USDC and Aave evidence from The Graph after a refresh is deterministically required. Read-only.",
            parameters: noArguments,
            timeoutMs: 35_000,
            execute: async (_input, runContext) => {
                const state = requiredState(runContext);
                if (state.refreshNeeded !== true)
                    throw new Error("Graph evidence is only loaded for a required refresh");
                if (state.graphEvidence)
                    throw new Error("Graph evidence was already loaded");
                const queriedAt = (state.dependencies.wallClockSeconds ?? (() => Math.floor(Date.now() / 1_000)))();
                const evidence = await (state.dependencies.fetchGraphEvidence ?? fetchGraphEvidence)(state.config.graph, queriedAt);
                state.graphEvidence = {
                    queriedAt: evidence.queriedAt,
                    observationCount: evidence.market.poolHourDatas.length,
                    marketDeployment: evidence.market._meta.deployment,
                    marketIndexedBlock: evidence.market._meta.block.number,
                    aaveDeployment: evidence.aave._meta.deployment,
                    aaveIndexedBlock: evidence.aave._meta.block.number,
                };
                return JSON.stringify(state.graphEvidence);
            },
        }),
        tool({
            name: "purchase_calibration",
            description: "Make exactly one x402-paid POST to the allow-listed local calibration service using the dedicated capped Hedera testnet payer.",
            parameters: noArguments,
            timeoutMs: 60_000,
            execute: async (_input, runContext) => {
                const state = requiredState(runContext);
                if (!state.policyStatus || state.refreshNeeded !== true || !state.graphEvidence) {
                    throw new Error("Policy status, refresh decision and Graph evidence are required before payment");
                }
                if (state.paymentAttempts !== 0)
                    throw new Error("The payment attempt limit for this run was reached");
                state.paymentAttempts = 1;
                if (state.policyStatus.latestPolicyVersion >= 0xffff_ffff)
                    throw new Error("Policy version space is exhausted");
                const request = parseCalibrationApiRequest({
                    requestId: randomUUID(),
                    maker: state.config.maker,
                    pair: CALIBRATION_PAIR,
                    horizon: CALIBRATION_HORIZON,
                    requestedProfile: CALIBRATION_PROFILE,
                    policyVersion: state.policyStatus.latestPolicyVersion + 1,
                    validForSeconds: state.config.policyValiditySeconds,
                });
                state.outgoingRequest = request;
                const requester = state.dependencies.paidRequester ?? createPaidCalibrationRequester({
                    agentAccountId: state.config.agentAccountId,
                    agentPrivateKey: state.config.agentPrivateKey,
                    serviceAccountId: state.config.serviceAccountId,
                    priceTinybar: state.config.priceTinybar,
                    calibrationServiceUrl: state.config.calibrationServiceUrl,
                });
                // From this call onward the network outcome can be unknown, including a
                // successful x402 settlement followed by a dropped HTTP response.
                state.paymentMayHaveBeenAttempted = true;
                const response = await requester(JSON.stringify(request), request.requestId);
                if (!response.ok)
                    throw new Error(`Paid calibration request failed with HTTP ${response.status}`);
                const paymentHeader = response.headers.get("payment-response");
                const replay = response.headers.get("x-marginmm-idempotent-replay") === "true";
                if (paymentHeader) {
                    state.paymentReceipt = validateHederaSettlement(decodePaymentResponseHeader(paymentHeader), state.config.priceTinybar);
                }
                else if (replay) {
                    state.paymentReceipt = {
                        transaction: "receipt-held-by-original-request",
                        network: HEDERA_TESTNET,
                        idempotentReplay: true,
                    };
                }
                else {
                    throw new Error("Successful calibration response has no Hedera payment receipt");
                }
                state.calibrationPayload = await readJsonWithLimit(response, 4_000_000);
                return JSON.stringify({
                    status: "paid",
                    transaction: state.paymentReceipt.transaction,
                    idempotentReplay: state.paymentReceipt.idempotentReplay,
                });
            },
        }),
        tool({
            name: "validate_calibration",
            description: "Deterministically validate response schema, EIP-712 signer, chain/registry/pair/version, shock bounds, TTL, and canonical evidence hash.",
            parameters: noArguments,
            execute: async (_input, runContext) => {
                const state = requiredState(runContext);
                if (!state.outgoingRequest || state.calibrationPayload === undefined || !state.paymentReceipt) {
                    throw new Error("A settled calibration response is required before validation");
                }
                const chainTimestamp = await (state.dependencies.chainTimestampSeconds
                    ?? (() => readLatestChainTimestamp(state.config.ethereumRpcUrl)))();
                state.validatedCalibration = validateCalibrationApiResponse(state.calibrationPayload, state.outgoingRequest, state.config, chainTimestamp);
                // The Maker-facing summary must describe the exact canonical evidence bound by the signature,
                // not the Agent's earlier pre-payment availability check.
                state.graphEvidence = signedGraphEvidenceSummary(state.validatedCalibration);
                const artifact = state.validatedCalibration.signedCalibration.artifact;
                return JSON.stringify({
                    valid: true,
                    policyVersion: artifact.policyVersion,
                    shockBps: artifact.shockBps,
                    validUntil: artifact.validUntil,
                    evidenceHash: artifact.evidenceHash,
                });
            },
        }),
        tool({
            name: "prepare_policy_proposal",
            description: "Prepare a read-only proposal for Maker browser approval. Cannot sign or submit an Ethereum transaction.",
            parameters: noArguments,
            execute: (_input, runContext) => {
                const state = requiredState(runContext);
                if (!state.validatedCalibration || !state.paymentReceipt) {
                    throw new Error("Only a deterministically validated paid calibration can become a proposal");
                }
                state.proposalPrepared = true;
                const artifact = state.validatedCalibration.signedCalibration.artifact;
                return JSON.stringify({
                    proposalReady: true,
                    policyVersion: artifact.policyVersion,
                    shockBps: artifact.shockBps,
                    makerFloorUnchanged: state.config.makerHardFloorStressHF,
                    approvalAuthority: "maker-browser-wallet-only",
                });
            },
        }),
    ];
}
async function readPolicyStatus(config) {
    const provider = new JsonRpcProvider(config.ethereumRpcUrl);
    const network = await provider.getNetwork();
    if (network.chainId !== 31337n)
        throw new Error("Risk Agent Ethereum reader is restricted to chain 31337");
    const block = await provider.getBlock("latest");
    if (!block)
        throw new Error("Local Ethereum chain returned no latest block");
    const contract = new Contract(config.policyRegistry, POLICY_ABI, provider);
    const makerSettings = contract.getFunction("makerSettings");
    const latestPolicy = contract.getFunction("latestPolicyVersion");
    const marketPolicy = contract.getFunction("marketPolicy");
    const [settings, latestRaw] = await Promise.all([
        makerSettings(config.maker, config.strategy),
        latestPolicy(config.pairId),
    ]);
    const latestPolicyVersion = uint32Number(latestRaw, "latest policy version");
    const activePolicyVersion = uint32Number(settings.policyVersion, "active policy version");
    const enabled = Boolean(settings.enabled);
    const revision = BigInt(settings.revision).toString();
    const hardFloorStressHF = BigInt(settings.hardFloorStressHF).toString();
    if (!enabled || activePolicyVersion === 0) {
        const hasEverBeenConfigured = activePolicyVersion !== 0 || revision !== "0";
        return {
            state: hasEverBeenConfigured ? "disabled" : "missing",
            chainTimestamp: block.timestamp,
            latestPolicyVersion,
            activePolicyVersion,
            revision,
            hardFloorStressHF,
            shockBps: 0,
            validUntil: 0,
            secondsRemaining: 0,
        };
    }
    if (String(settings.pairId).toLowerCase() !== config.pairId.toLowerCase()) {
        throw new Error("Maker settings pair does not match the configured MarginMM pair");
    }
    const policy = await marketPolicy(config.pairId, activePolicyVersion);
    const validUntil = safeNumber(policy.validUntil, "policy validUntil");
    const shockBps = uint32Number(policy.shockBps, "policy shock");
    const secondsRemaining = Math.max(0, validUntil - block.timestamp);
    const state = block.timestamp > validUntil
        ? "expired"
        : secondsRemaining <= config.refreshLeadSeconds ? "expiring" : "valid";
    return {
        state,
        chainTimestamp: block.timestamp,
        latestPolicyVersion,
        activePolicyVersion,
        revision,
        hardFloorStressHF,
        shockBps,
        validUntil,
        secondsRemaining,
    };
}
async function readJsonWithLimit(response, limit) {
    const declared = response.headers.get("content-length");
    if (declared && Number(declared) > limit)
        throw new Error("Calibration response exceeds the size limit");
    if (!response.body)
        throw new Error("Calibration response has no body");
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done)
            break;
        total += value.byteLength;
        if (total > limit) {
            await reader.cancel();
            throw new Error("Calibration response exceeds the size limit");
        }
        chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    try {
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    }
    catch {
        throw new Error("Calibration response is not valid UTF-8 JSON");
    }
}
function validateRiskAgentConfig(config) {
    const rpcUrl = new URL(config.ethereumRpcUrl);
    if (rpcUrl.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(rpcUrl.hostname)) {
        throw new Error("Risk Agent Ethereum RPC must be a loopback HTTP endpoint");
    }
    config.policyRegistry = getAddress(config.policyRegistry);
    config.maker = getAddress(config.maker);
    config.calibrationSignerAddress = getAddress(config.calibrationSignerAddress);
    if (!bytes32Pattern.test(config.pairId) || /^0x0{64}$/.test(config.pairId))
        throw new Error("Invalid pairId");
    if (!bytes32Pattern.test(config.strategy) || /^0x0{64}$/.test(config.strategy))
        throw new Error("Invalid strategy");
    const floor = BigInt(config.makerHardFloorStressHF);
    if (floor < 1010000000000000000n || floor > 3000000000000000000n) {
        throw new Error("Maker hard floor is outside contract bounds");
    }
    if (!Number.isSafeInteger(config.refreshLeadSeconds)
        || config.refreshLeadSeconds < 0
        || config.refreshLeadSeconds > MAX_POLICY_TTL)
        throw new Error("Invalid refresh lead time");
    if (!Number.isSafeInteger(config.policyValiditySeconds)
        || config.policyValiditySeconds < 1
        || config.policyValiditySeconds > MAX_POLICY_TTL)
        throw new Error("Invalid policy validity period");
    if (!config.modelApiKey.trim())
        throw new Error("Agent model API key is required");
    const modelBaseUrl = new URL(config.modelBaseUrl);
    if (modelBaseUrl.toString().replace(/\/$/, "") !== GROQ_OPENAI_BASE_URL) {
        throw new Error("Agent model base URL must be the pinned Groq OpenAI-compatible endpoint");
    }
    if (!config.model.trim())
        throw new Error("Agent model is required");
}
function requiredState(runContext) {
    if (!runContext)
        throw new Error("Risk Agent run context is missing");
    return runContext.context;
}
function safeNumber(value, field) {
    const result = Number(BigInt(value));
    if (!Number.isSafeInteger(result) || result < 0)
        throw new Error(`${field} is outside the supported range`);
    return result;
}
function uint32Number(value, field) {
    const result = safeNumber(value, field);
    if (result > 0xffff_ffff)
        throw new Error(`${field} is outside uint32`);
    return result;
}
