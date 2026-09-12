import assert from "node:assert/strict";
import test from "node:test";
import { PrivateKey } from "@hiero-ledger/sdk";
import { assertHederaFacilitatorSupport, buildCalibrationRoutes, buildStrictHbarPaymentPolicy, createPaidCalibrationRequester, HBAR_ASSET, HEDERA_TESTNET, MAX_HBAR_PRICE_TINYBAR, parseHbarPriceTinybar, } from "../src/x402.js";
const SERVICE_ACCOUNT = "0.0.7001";
const AGENT_ACCOUNT = "0.0.7002";
const PRICE_TINYBAR = "100000";
const FEE_PAYER = "0.0.8001";
function supportedResponse(overrides = {}) {
    return {
        kinds: [{
                x402Version: 2,
                scheme: "exact",
                network: HEDERA_TESTNET,
                extra: { feePayer: FEE_PAYER },
            }],
        extensions: [],
        signers: { "hedera:*": [FEE_PAYER] },
        ...overrides,
    };
}
function requirement(overrides = {}) {
    return {
        scheme: "exact",
        network: HEDERA_TESTNET,
        asset: HBAR_ASSET,
        amount: PRICE_TINYBAR,
        payTo: SERVICE_ACCOUNT,
        maxTimeoutSeconds: 60,
        extra: { feePayer: FEE_PAYER },
        ...overrides,
    };
}
test("facilitator capability accepts a dynamic, self-consistent fee payer", () => {
    assert.deepEqual(assertHederaFacilitatorSupport(supportedResponse()), {
        feePayer: FEE_PAYER,
        signerPattern: "hedera:*",
    });
});
test("facilitator capability fails closed on mismatch or missing Hedera v2 support", () => {
    assert.throws(() => assertHederaFacilitatorSupport(supportedResponse({
        signers: { "hedera:*": ["0.0.9999"] },
    })), /not covered/);
    assert.throws(() => assertHederaFacilitatorSupport(supportedResponse({
        kinds: [],
    })), /does not advertise/);
});
test("HBAR price is an integer tinybar amount inside the safety envelope", () => {
    assert.equal(parseHbarPriceTinybar("1"), 1n);
    assert.equal(parseHbarPriceTinybar(MAX_HBAR_PRICE_TINYBAR.toString()), MAX_HBAR_PRICE_TINYBAR);
    for (const invalid of ["0", "-1", "1.5", "+1", "01", (MAX_HBAR_PRICE_TINYBAR + 1n).toString()]) {
        assert.throws(() => parseHbarPriceTinybar(invalid));
    }
});
test("server route declares only exact HBAR on Hedera testnet", () => {
    assert.deepEqual(buildCalibrationRoutes({
        serviceAccountId: SERVICE_ACCOUNT,
        priceTinybar: PRICE_TINYBAR,
    }), {
        "POST /calibrate": {
            accepts: {
                scheme: "exact",
                network: HEDERA_TESTNET,
                payTo: SERVICE_ACCOUNT,
                price: { asset: HBAR_ASSET, amount: PRICE_TINYBAR },
                maxTimeoutSeconds: 60,
            },
            description: "MarginMM deterministic market-risk calibration",
            mimeType: "application/json",
            serviceName: "MarginMM Calibration",
        },
    });
});
test("agent policy rejects every payment outside the exact service contract", () => {
    const policy = buildStrictHbarPaymentPolicy({
        serviceAccountId: SERVICE_ACCOUNT,
        priceTinybar: PRICE_TINYBAR,
    });
    assert.deepEqual(policy(2, [requirement()]), [requirement()]);
    assert.deepEqual(policy(1, [requirement()]), []);
    for (const changed of [
        requirement({ scheme: "upto" }),
        requirement({ network: "hedera:mainnet" }),
        requirement({ asset: "0.0.456858" }),
        requirement({ amount: "100001" }),
        requirement({ amount: "99999" }),
        requirement({ payTo: "0.0.9999" }),
    ]) {
        assert.deepEqual(policy(2, [changed]), []);
    }
});
test("paid requester is key-valid and locked to the local calibration endpoint", async () => {
    let captured;
    const requester = createPaidCalibrationRequester({
        agentAccountId: AGENT_ACCOUNT,
        agentPrivateKey: PrivateKey.generateECDSA().toString(),
        serviceAccountId: SERVICE_ACCOUNT,
        priceTinybar: PRICE_TINYBAR,
        calibrationServiceUrl: "http://127.0.0.1:4021/calibrate",
    }, async (input, init) => {
        captured = new Request(input, init);
        return new Response(null, { status: 204 });
    });
    assert.equal((await requester("{\"requestId\":\"test\"}", "test")).status, 204);
    assert.equal(captured?.url, "http://127.0.0.1:4021/calibrate");
    assert.equal(captured?.method, "POST");
    assert.equal(captured?.headers.get("idempotency-key"), "test");
    assert.throws(() => createPaidCalibrationRequester({
        agentAccountId: AGENT_ACCOUNT,
        agentPrivateKey: "not-a-key",
        serviceAccountId: SERVICE_ACCOUNT,
        priceTinybar: PRICE_TINYBAR,
        calibrationServiceUrl: "http://127.0.0.1:4021/calibrate",
    }), /valid Hedera ECDSA private key/);
    assert.throws(() => createPaidCalibrationRequester({
        agentAccountId: AGENT_ACCOUNT,
        agentPrivateKey: PrivateKey.generateECDSA().toString(),
        serviceAccountId: SERVICE_ACCOUNT,
        priceTinybar: PRICE_TINYBAR,
        calibrationServiceUrl: "https://attacker.example/calibrate",
    }), /plain loopback/);
    assert.throws(() => createPaidCalibrationRequester({
        agentAccountId: SERVICE_ACCOUNT,
        agentPrivateKey: PrivateKey.generateECDSA().toString(),
        serviceAccountId: SERVICE_ACCOUNT,
        priceTinybar: PRICE_TINYBAR,
        calibrationServiceUrl: "http://127.0.0.1:4021/calibrate",
    }), /must be different/);
});
