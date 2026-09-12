import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CalibrationIdempotencyStore, calibrationRequestHash, createCalibrationApp, loadCalibrationServiceConfig, parseCalibrationApiRequest, } from "../src/calibration-service.js";
const REQUEST = {
    requestId: "f7a4ad4d-9d5b-4f39-8e24-086d48c73e30",
    maker: "0x0000000000000000000000000000000000001234",
    pair: "aWETH/aUSDC",
    horizon: "24h",
    requestedProfile: "marginmm-v1",
    policyVersion: 2,
    validForSeconds: 3600,
};
test("calibration API request is strict, canonical and bounded", () => {
    const parsed = parseCalibrationApiRequest(REQUEST);
    assert.match(calibrationRequestHash(parsed), /^0x[0-9a-f]{64}$/);
    assert.throws(() => parseCalibrationApiRequest({ ...REQUEST, extra: true }), /unrecognized/i);
    assert.throws(() => parseCalibrationApiRequest({ ...REQUEST, validForSeconds: 21601 }));
    assert.throws(() => parseCalibrationApiRequest({ ...REQUEST, policyVersion: 0 }));
});
test("idempotency store rejects concurrent and conflicting reuse without losing a completed response", () => {
    const store = new CalibrationIdempotencyStore(1);
    const request = parseCalibrationApiRequest(REQUEST);
    const hash = calibrationRequestHash(request);
    const response = { schema: "marginmm-calibration-response-v1" };
    assert.equal(store.reserve(request.requestId, hash), "reserved");
    assert.equal(store.reserve(request.requestId, hash), "pending");
    assert.equal(store.inspect(request.requestId, `0x${"ff".repeat(32)}`), "conflict");
    store.complete(request.requestId, hash, response);
    assert.equal(store.inspect(request.requestId, hash), response);
    assert.throws(() => store.reserve("new-id", hash), /capacity/);
});
test("a reservation is released only when the caller proves no payment occurred", () => {
    const store = new CalibrationIdempotencyStore();
    const request = parseCalibrationApiRequest(REQUEST);
    const hash = calibrationRequestHash(request);
    assert.equal(store.reserve(request.requestId, hash), "reserved");
    store.release(request.requestId, hash);
    assert.equal(store.inspect(request.requestId, hash), "missing");
});
test("durable journal keeps pending work fail-closed and replays completed work after restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "marginmm-calibration-"));
    const journalPath = join(directory, "idempotency.json");
    const request = parseCalibrationApiRequest(REQUEST);
    const hash = calibrationRequestHash(request);
    const response = { schema: "marginmm-calibration-response-v1" };
    try {
        const first = CalibrationIdempotencyStore.load(journalPath, 1);
        assert.equal(first.reserve(request.requestId, hash), "reserved");
        assert.equal(CalibrationIdempotencyStore.load(journalPath, 1).inspect(request.requestId, hash), "pending");
        first.complete(request.requestId, hash, response);
        assert.deepEqual(CalibrationIdempotencyStore.load(journalPath, 1).inspect(request.requestId, hash), response);
    }
    finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
test("concurrent calibration reuse is rejected before payment middleware", async () => {
    const directory = mkdtempSync(join(tmpdir(), "marginmm-calibration-"));
    const journalPath = join(directory, "idempotency.json");
    let paymentCalls = 0;
    let paymentStarted;
    let releasePayment;
    const started = new Promise((resolve) => { paymentStarted = resolve; });
    const release = new Promise((resolve) => { releasePayment = resolve; });
    const app = await createCalibrationApp({
        ethereumRpcUrl: "http://127.0.0.1:8545",
        policyRegistry: "0x0000000000000000000000000000000000001234",
        pairId: `0x${"12".repeat(32)}`,
        calibrationSignerAddress: "0x0000000000000000000000000000000000002345",
        calibrationSignerPrivateKey: "local-only",
        graph: { market: { apiKey: "local-only", subgraphId: "5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV" }, aave: { apiKey: "local-only", subgraphId: "Cd2gEDVeqnjBn1hSeqFMitw8Q1iiyV9FYUZkLNRcL87g" } },
        hederaPayToAccountId: "0.0.7001",
        priceTinybar: "100000",
        idempotencyPath: journalPath,
        port: 4021,
    }, {
        paymentMiddleware: async (_request, response) => {
            paymentCalls += 1;
            paymentStarted();
            await release;
            response.status(402).end();
        },
    });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}/calibrate`;
    const init = {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": REQUEST.requestId },
        body: JSON.stringify(REQUEST),
    };
    try {
        const first = fetch(url, init);
        await started;
        const second = await fetch(url, init);
        assert.equal(second.status, 409);
        assert.equal(paymentCalls, 1);
        releasePayment();
        assert.equal((await first).status, 402);
        assert.equal(CalibrationIdempotencyStore.load(journalPath).inspect(REQUEST.requestId, calibrationRequestHash(parseCalibrationApiRequest(REQUEST))), "missing");
    }
    finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        rmSync(directory, { recursive: true, force: true });
    }
});
test("service environment is locked to chain 31337 and seven-day live Graph evidence", () => {
    const env = {
        MARGINMM_CHAIN_ID: "31337",
        MARGINMM_ETHEREUM_RPC_URL: "http://127.0.0.1:8545",
        MARGINMM_POLICY_REGISTRY: "0x0000000000000000000000000000000000001234",
        MARGINMM_PAIR_ID: `0x${"12".repeat(32)}`,
        CALIBRATION_SIGNER_ADDRESS: "0x0000000000000000000000000000000000002345",
        CALIBRATION_SIGNER_PRIVATE_KEY: "local-only",
        GRAPH_API_KEY: "local-only",
        HEDERA_PAYTO_ACCOUNT_ID: "0.0.7001",
        X402_PRICE_TINYBAR: "100000",
        CALIBRATION_IDEMPOTENCY_PATH: "/tmp/marginmm-calibration-idempotency.json",
    };
    const config = loadCalibrationServiceConfig(env);
    assert.equal(config.graph.lookbackSeconds, 7 * 24 * 60 * 60);
    assert.equal(config.ethereumRpcUrl, "http://127.0.0.1:8545");
    assert.equal(config.port, 4021);
    assert.throws(() => loadCalibrationServiceConfig({ ...env, MARGINMM_CHAIN_ID: "1" }), /must be 31337/);
    assert.throws(() => loadCalibrationServiceConfig({ ...env, MARGINMM_ETHEREUM_RPC_URL: "https://example.com" }), /loopback/);
});
