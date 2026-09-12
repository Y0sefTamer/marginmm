import assert from "node:assert/strict";
import test from "node:test";
import { assistantMessage, functionCall, ScriptedModel } from "@openai/agents/testing";
import { encodePaymentResponseHeader } from "@x402/core/http";
import { Wallet, keccak256, toUtf8Bytes } from "ethers";
import { assessRefreshNeed, RiskAgentWorkflowError, runRiskAgent, validateCalibrationApiResponse, validateHederaSettlement, } from "../src/agent.js";
import { parseCalibrationApiRequest, } from "../src/calibration-service.js";
import { canonicalJson } from "../src/calibration.js";
import { signCalibrationArtifact } from "../src/policy-artifact.js";
const NOW = 1_800_000_000;
const POLICY_REGISTRY = "0x0000000000000000000000000000000000001234";
const MAKER = "0x0000000000000000000000000000000000002345";
const PAIR_ID = `0x${"12".repeat(32)}`;
const STRATEGY = `0x${"34".repeat(32)}`;
function policyStatus(state = "valid") {
    return {
        state,
        chainTimestamp: NOW,
        latestPolicyVersion: 1,
        activePolicyVersion: 1,
        revision: "1",
        hardFloorStressHF: "1100000000000000000",
        shockBps: 1240,
        validUntil: NOW + 3600,
        secondsRemaining: 3600,
    };
}
function agentConfig() {
    return {
        ethereumRpcUrl: "http://127.0.0.1:8545",
        policyRegistry: POLICY_REGISTRY,
        pairId: PAIR_ID,
        maker: MAKER,
        strategy: STRATEGY,
        makerHardFloorStressHF: "1100000000000000000",
        calibrationSignerAddress: "0x0000000000000000000000000000000000003456",
        calibrationServiceUrl: "http://127.0.0.1:4021/calibrate",
        agentAccountId: "0.0.7002",
        agentPrivateKey: "unused-in-no-refresh-test",
        serviceAccountId: "0.0.7001",
        priceTinybar: "100000",
        graph: {
            market: { apiKey: "unused", subgraphId: "12345678901234567890" },
            aave: { apiKey: "unused", subgraphId: "12345678901234567891" },
        },
        refreshLeadSeconds: 1800,
        policyValiditySeconds: 3600,
        forceRefresh: false,
        modelApiKey: "test-only",
        modelBaseUrl: "https://api.groq.com/openai/v1",
        model: "test-model",
    };
}
test("refresh decision is deterministic and force remains explicit", () => {
    assert.equal(assessRefreshNeed(policyStatus("valid"), false), false);
    assert.equal(assessRefreshNeed(policyStatus("expired"), false), true);
    assert.equal(assessRefreshNeed(policyStatus("valid"), true), true);
});
test("Hedera receipt must be successful, testnet and amount-consistent", () => {
    const receipt = validateHederaSettlement({
        success: true,
        transaction: "0.0.7002@1800000000.000000001",
        network: "hedera:testnet",
        payer: "0.0.7002",
        amount: "100000",
    }, "100000");
    assert.equal(receipt.network, "hedera:testnet");
    assert.throws(() => validateHederaSettlement({
        success: true,
        transaction: "tx",
        network: "hedera:mainnet",
    }, "100000"), /invalid/);
    assert.throws(() => validateHederaSettlement({
        success: true,
        transaction: "tx",
        network: "hedera:testnet",
        amount: "100001",
    }, "100000"), /does not match/);
});
test("full calibration response validation binds signature, request and canonical evidence metadata", async () => {
    const signer = Wallet.createRandom();
    const request = parseCalibrationApiRequest({
        requestId: "f7a4ad4d-9d5b-4f39-8e24-086d48c73e30",
        maker: MAKER,
        pair: "aWETH/aUSDC",
        horizon: "24h",
        requestedProfile: "marginmm-v1",
        policyVersion: 2,
        validForSeconds: 3600,
    });
    const evidence = {
        schema: "marginmm-evidence-v1",
        model: {
            version: 1,
            method: "deterministic-test",
            shockTarget: "WETH",
            usdcMultiplierBps: 10000,
        },
        queriedAt: NOW + 10_000,
        sources: {
            market: {
                subgraphDeployment: "market-deployment",
                indexedBlock: { number: 100 },
                firstSwapBlock: 90,
                lastSwapBlock: 110,
            },
            aave: {
                subgraphDeployment: "aave-deployment",
                indexedBlock: { number: 105 },
            },
        },
        diagnostics: { shockBps: 1240 },
    };
    const canonicalEvidence = canonicalJson(evidence);
    const signed = await signCalibrationArtifact({
        chainId: 31337n,
        policyRegistry: POLICY_REGISTRY,
        pairId: PAIR_ID,
        shockBps: 1240,
        marketRegime: 2,
        policyVersion: 2,
        modelVersion: 1,
        issuedAt: NOW,
        validUntil: NOW + 3600,
        evidenceBlockFrom: 90,
        evidenceBlockTo: 100,
        evidenceHash: keccak256(toUtf8Bytes(canonicalEvidence)),
    }, signer.privateKey, signer.address, NOW);
    const response = {
        schema: "marginmm-calibration-response-v1",
        request,
        signedCalibration: {
            ...signed,
            artifact: { ...signed.artifact, chainId: "31337" },
        },
        diagnostics: {
            observationCount: 25,
            q99DownsideBps: 1240,
            twoSigmaDownsideBps: 500,
            maxDrawdownBps: 1240,
            shockBps: 1240,
            aaveUtilization: { weth: "0.1", usdc: "0.5" },
            marketDeployment: "market-deployment",
            aaveDeployment: "aave-deployment",
        },
        canonicalEvidence,
    };
    assert.equal(validateCalibrationApiResponse(response, request, {
        policyRegistry: POLICY_REGISTRY,
        pairId: PAIR_ID,
        calibrationSignerAddress: signer.address,
    }, NOW).signedCalibration.artifact.shockBps, 1240);
    assert.throws(() => validateCalibrationApiResponse({
        ...response,
        diagnostics: { ...response.diagnostics, shockBps: 1241 },
    }, request, {
        policyRegistry: POLICY_REGISTRY,
        pairId: PAIR_ID,
        calibrationSignerAddress: signer.address,
    }, NOW), /metadata is inconsistent/);
});
test("OpenAI Agents SDK no-refresh run cannot fabricate a policy proposal", async () => {
    const scripted = new ScriptedModel([
        [functionCall("get_policy_status", {}, { callId: "call-1" })],
        [functionCall("assess_refresh_need", {}, { callId: "call-2" })],
        [assistantMessage(JSON.stringify({
                decision: "no_refresh",
                headline: "Current policy remains valid.",
                rationale: ["The deterministic policy status is valid and no forced refresh was requested."],
            }))],
    ]);
    const proposal = await runRiskAgent(agentConfig(), {
        model: scripted,
        readPolicyStatus: async () => policyStatus("valid"),
    });
    assert.equal(proposal.decision, "no_refresh");
    assert.equal(proposal.calibration, undefined);
    assert.equal(proposal.paymentReceipt, undefined);
    assert.equal(scripted.calls.length, 3);
    scripted.assertComplete();
});
test("a failure before the paid request is explicitly safe to retry", async () => {
    const scripted = new ScriptedModel([
        [functionCall("get_policy_status", {}, { callId: "call-1" })],
        [functionCall("assess_refresh_need", {}, { callId: "call-2" })],
        [functionCall("get_graph_evidence", {}, { callId: "call-3" })],
        [assistantMessage(JSON.stringify({
                decision: "no_refresh",
                headline: "No proposal.",
                rationale: ["The evidence source failed."],
            }))],
    ]);
    await assert.rejects(runRiskAgent({ ...agentConfig(), forceRefresh: true }, {
        model: scripted,
        readPolicyStatus: async () => policyStatus("valid"),
        fetchGraphEvidence: async () => { throw new Error("Live Graph unavailable"); },
    }), (error) => {
        assert.ok(error instanceof RiskAgentWorkflowError);
        assert.equal(error.paymentMayHaveBeenAttempted, false);
        return true;
    });
    scripted.assertComplete();
});
test("an unknown response after starting x402 remains fail-closed", async () => {
    const scripted = new ScriptedModel([
        [functionCall("get_policy_status", {}, { callId: "call-1" })],
        [functionCall("assess_refresh_need", {}, { callId: "call-2" })],
        [functionCall("get_graph_evidence", {}, { callId: "call-3" })],
        [functionCall("purchase_calibration", {}, { callId: "call-4" })],
        [assistantMessage(JSON.stringify({
                decision: "no_refresh",
                headline: "No proposal.",
                rationale: ["The payment response was unavailable."],
            }))],
    ]);
    await assert.rejects(runRiskAgent({ ...agentConfig(), forceRefresh: true }, {
        model: scripted,
        readPolicyStatus: async () => policyStatus("valid"),
        fetchGraphEvidence: async () => ({
            queriedAt: NOW,
            market: { _meta: { deployment: "market", block: { number: 1 } }, poolHourDatas: Array.from({ length: 25 }, () => ({})) },
            aave: { _meta: { deployment: "aave", block: { number: 1 } } },
        }),
        paidRequester: async () => { throw new Error("Payment response unavailable"); },
    }), (error) => {
        assert.ok(error instanceof RiskAgentWorkflowError);
        assert.equal(error.paymentMayHaveBeenAttempted, true);
        return true;
    });
    scripted.assertComplete();
});
test("paid Agent workflow is ordered and exposes only the signed Graph evidence", async () => {
    const signer = Wallet.createRandom();
    const config = {
        ...agentConfig(),
        calibrationSignerAddress: signer.address,
    };
    const scripted = new ScriptedModel([
        [functionCall("get_policy_status", {}, { callId: "call-1" })],
        [functionCall("assess_refresh_need", {}, { callId: "call-2" })],
        [functionCall("get_graph_evidence", {}, { callId: "call-3" })],
        [functionCall("purchase_calibration", {}, { callId: "call-4" })],
        [functionCall("validate_calibration", {}, { callId: "call-5" })],
        [functionCall("prepare_policy_proposal", {}, { callId: "call-6" })],
        [assistantMessage(JSON.stringify({
                decision: "proposal_ready",
                headline: "Signed calibration is ready for Maker review.",
                rationale: ["The missing policy requires a deterministic refresh."],
            }))],
    ]);
    let paymentAttempts = 0;
    const proposal = await runRiskAgent(config, {
        model: scripted,
        wallClockSeconds: () => NOW + 10_000,
        chainTimestampSeconds: () => NOW,
        readPolicyStatus: async () => ({
            ...policyStatus("missing"), latestPolicyVersion: 1, activePolicyVersion: 0,
            revision: "0", hardFloorStressHF: "0", shockBps: 0, validUntil: 0, secondsRemaining: 0,
        }),
        fetchGraphEvidence: async () => ({
            queriedAt: NOW + 10_000,
            fromTimestamp: NOW - 86_400,
            market: {
                _meta: { deployment: "pre-payment-market", hasIndexingErrors: false, block: { number: 90, hash: null } },
                pool: null,
                poolHourDatas: Array.from({ length: 25 }, (_, index) => ({ id: String(index) })),
                firstSwap: [], lastSwap: [],
            },
            aave: {
                _meta: { deployment: "pre-payment-aave", hasIndexingErrors: false, block: { number: 91, hash: null } },
                reserves: [], liquidationCalls: [],
            },
        }),
        paidRequester: async (body, idempotencyKey) => {
            paymentAttempts += 1;
            const request = parseCalibrationApiRequest(JSON.parse(body));
            assert.equal(request.requestId, idempotencyKey);
            const evidence = {
                schema: "marginmm-evidence-v1",
                model: {
                    version: 1, method: "deterministic-test", shockTarget: "WETH", usdcMultiplierBps: 10000,
                },
                queriedAt: NOW + 10_000,
                sources: {
                    market: {
                        subgraphDeployment: "signed-market-deployment",
                        indexedBlock: { number: 100 }, firstSwapBlock: 90, lastSwapBlock: 110,
                    },
                    aave: { subgraphDeployment: "signed-aave-deployment", indexedBlock: { number: 105 } },
                },
                diagnostics: { shockBps: 1240 },
            };
            const canonicalEvidence = canonicalJson(evidence);
            const signed = await signCalibrationArtifact({
                chainId: 31337n,
                policyRegistry: POLICY_REGISTRY,
                pairId: PAIR_ID,
                shockBps: 1240,
                marketRegime: 2,
                policyVersion: request.policyVersion,
                modelVersion: 1,
                issuedAt: NOW,
                validUntil: NOW + request.validForSeconds,
                evidenceBlockFrom: 90,
                evidenceBlockTo: 100,
                evidenceHash: keccak256(toUtf8Bytes(canonicalEvidence)),
            }, signer.privateKey, signer.address, NOW);
            const response = {
                schema: "marginmm-calibration-response-v1",
                request,
                signedCalibration: { ...signed, artifact: { ...signed.artifact, chainId: "31337" } },
                diagnostics: {
                    observationCount: 31,
                    q99DownsideBps: 1240,
                    twoSigmaDownsideBps: 500,
                    maxDrawdownBps: 1240,
                    shockBps: 1240,
                    aaveUtilization: { weth: "0.1", usdc: "0.5" },
                    marketDeployment: "signed-market-deployment",
                    aaveDeployment: "signed-aave-deployment",
                },
                canonicalEvidence,
            };
            return new Response(JSON.stringify(response), {
                status: 200,
                headers: {
                    "content-type": "application/json",
                    "payment-response": encodePaymentResponseHeader({
                        success: true,
                        transaction: "0.0.7002@1800000000.000000001",
                        network: "hedera:testnet",
                        payer: "0.0.7002",
                        amount: "100000",
                    }),
                },
            });
        },
    });
    assert.equal(paymentAttempts, 1);
    assert.equal(proposal.decision, "proposal_ready");
    assert.equal(proposal.graphEvidence?.marketDeployment, "signed-market-deployment");
    assert.equal(proposal.graphEvidence?.aaveDeployment, "signed-aave-deployment");
    assert.equal(proposal.graphEvidence?.observationCount, 31);
    assert.equal(proposal.calibration?.signedCalibration.artifact.shockBps, 1240);
    assert.equal(proposal.paymentReceipt?.transaction, "0.0.7002@1800000000.000000001");
    assert.equal(scripted.calls.length, 7);
    scripted.assertComplete();
});
