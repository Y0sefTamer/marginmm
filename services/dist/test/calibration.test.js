import assert from "node:assert/strict";
import test from "node:test";
import { Wallet } from "ethers";
import { calibrate, canonicalJson, MAX_POLICY_TTL } from "../src/calibration.js";
import { issueCalibration } from "../src/calibration-service.js";
import { AAVE_V3_ETHEREUM_SUBGRAPH_ID, fetchGraphEvidence, UNISWAP_V3_ETHEREUM_SUBGRAPH_ID, USDC_ADDRESS, WETH_ADDRESS, WETH_USDC_005_POOL, } from "../src/graph.js";
import { signCalibrationArtifact, validateSignedCalibration, validateSignedCalibrationEvidence, } from "../src/policy-artifact.js";
const NOW = 1_800_000_000;
const PAIR_ID = `0x${"12".repeat(32)}`;
const POLICY_REGISTRY = "0x0000000000000000000000000000000000001234";
function marketData(prices = stressedPrices()) {
    return {
        _meta: {
            deployment: "QmMarketDeployment",
            hasIndexingErrors: false,
            block: { number: 22_000_100, hash: `0x${"ab".repeat(32)}` },
        },
        pool: {
            id: WETH_USDC_005_POOL,
            feeTier: "500",
            token0: { id: USDC_ADDRESS, symbol: "USDC", decimals: "6" },
            token1: { id: WETH_ADDRESS, symbol: "WETH", decimals: "18" },
        },
        poolHourDatas: prices.map((price, index) => {
            const previous = prices[Math.max(0, index - 1)];
            const high = String(Math.max(Number(previous), Number(price)));
            const low = String(Math.min(Number(previous), Number(price)));
            return {
                id: `${WETH_USDC_005_POOL}-${NOW - (prices.length - index) * 3600}`,
                periodStartUnix: NOW - (prices.length - index) * 3600,
                token0Price: price,
                token1Price: "0.000333333333333333",
                open: previous,
                high,
                low,
                close: price,
                volumeUSD: "1000000.00",
                tvlUSD: "250000000.00",
            };
        }),
        firstSwap: [{ transaction: { blockNumber: "21999000" } }],
        lastSwap: [{ transaction: { blockNumber: "22000000" } }],
    };
}
function aaveData() {
    const common = {
        id: "reserve",
        usageAsCollateralEnabled: true,
        borrowingEnabled: true,
        isActive: true,
        isFrozen: false,
        reserveLiquidationThreshold: "8000",
        totalLiquidity: "1000000000000",
        availableLiquidity: "400000000000",
        totalCurrentVariableDebt: "600000000000",
        variableBorrowRate: "30000000000000000000000000",
        liquidityRate: "10000000000000000000000000",
    };
    return {
        _meta: {
            deployment: "QmAaveDeployment",
            hasIndexingErrors: false,
            block: { number: 22_000_050, hash: `0x${"cd".repeat(32)}` },
        },
        reserves: [
            { ...common, id: "weth-reserve", underlyingAsset: WETH_ADDRESS, symbol: "WETH", decimals: 18, utilizationRate: "0.15" },
            { ...common, id: "usdc-reserve", underlyingAsset: USDC_ADDRESS, symbol: "USDC", decimals: 6, utilizationRate: "0.60" },
        ],
        liquidationCalls: [],
    };
}
function stressedPrices() {
    const prices = Array.from({ length: 30 }, () => "3000");
    prices[15] = "2628";
    return prices;
}
async function evidence(prices) {
    const requests = [];
    const fetchMock = async (input, init) => {
        const url = String(input);
        requests.push({ url, authorization: new Headers(init?.headers).get("authorization") });
        const data = url.includes(UNISWAP_V3_ETHEREUM_SUBGRAPH_ID) ? marketData(prices) : aaveData();
        return new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const result = await fetchGraphEvidence({
        market: { apiKey: "market-secret", subgraphId: UNISWAP_V3_ETHEREUM_SUBGRAPH_ID },
        aave: { apiKey: "aave-secret", subgraphId: AAVE_V3_ETHEREUM_SUBGRAPH_ID },
    }, NOW, fetchMock);
    return { result, requests };
}
test("Graph adapter keeps credentials in authorization headers and validates both live sources", async () => {
    const { result, requests } = await evidence();
    assert.equal(requests.length, 2);
    assert.deepEqual(new Set(requests.map((item) => item.authorization)), new Set(["Bearer market-secret", "Bearer aave-secret"]));
    assert.ok(requests.every((item) => !item.url.includes("secret")));
    assert.equal(result.market.poolHourDatas.length, 30);
    assert.equal(result.aave.reserves.length, 2);
});
test("deterministic calibration emits the exact 12.40% WETH shock and a stable evidence hash", async () => {
    const { result: graphEvidence } = await evidence();
    const request = {
        chainId: 31337n,
        policyRegistry: POLICY_REGISTRY,
        pairId: PAIR_ID,
        policyVersion: 2,
        issuedAt: NOW,
        validUntil: NOW + MAX_POLICY_TTL,
    };
    const first = calibrate(graphEvidence, request);
    const second = calibrate(graphEvidence, request);
    assert.equal(first.artifact.shockBps, 1240);
    assert.equal(first.artifact.marketRegime, 2);
    assert.equal(first.artifact.modelVersion, 1);
    assert.equal(first.artifact.evidenceBlockFrom, 21_999_000);
    assert.equal(first.artifact.evidenceBlockTo, 22_000_000);
    assert.match(first.artifact.evidenceHash, /^0x[0-9a-f]{64}$/);
    assert.equal(first.artifact.evidenceHash, second.artifact.evidenceHash);
    assert.equal(first.canonicalEvidence, second.canonicalEvidence);
});
test("shock security bounds reject instead of clamping", async () => {
    const { result: graphEvidence } = await evidence(Array.from({ length: 30 }, () => "3000"));
    assert.throws(() => calibrate(graphEvidence, {
        chainId: 31337n,
        policyRegistry: POLICY_REGISTRY,
        pairId: PAIR_ID,
        policyVersion: 1,
        issuedAt: NOW,
        validUntil: NOW + 3600,
    }), /outside the accepted security envelope/);
});
test("TTL is anchored to chain issuance and remains separate from Graph query time", async () => {
    const { result: graphEvidence } = await evidence();
    const chainIssuedAt = NOW - 5 * 24 * 60 * 60;
    const calibrated = calibrate(graphEvidence, {
        chainId: 31337n,
        policyRegistry: POLICY_REGISTRY,
        pairId: PAIR_ID,
        policyVersion: 1,
        issuedAt: chainIssuedAt,
        validUntil: chainIssuedAt + 3600,
    });
    assert.equal(calibrated.artifact.issuedAt, chainIssuedAt);
    assert.equal(JSON.parse(calibrated.canonicalEvidence).queriedAt, NOW);
    assert.throws(() => calibrate(graphEvidence, {
        chainId: 31337n,
        policyRegistry: POLICY_REGISTRY,
        pairId: PAIR_ID,
        policyVersion: 1,
        issuedAt: NOW,
        validUntil: NOW + MAX_POLICY_TTL + 1,
    }), /Invalid policy validity window/);
});
test("calibration service reads chain time after Graph evidence and before signing", async () => {
    const signer = Wallet.createRandom();
    const order = [];
    const queriedAt = NOW + 10_000;
    const fetchMock = async (input) => {
        order.push("graph");
        const data = String(input).includes(UNISWAP_V3_ETHEREUM_SUBGRAPH_ID) ? marketData() : aaveData();
        return new Response(JSON.stringify({ data }), {
            status: 200,
            headers: { "content-type": "application/json" },
        });
    };
    const response = await issueCalibration({
        ethereumRpcUrl: "http://127.0.0.1:8545",
        policyRegistry: POLICY_REGISTRY,
        pairId: PAIR_ID,
        calibrationSignerAddress: signer.address,
        calibrationSignerPrivateKey: signer.privateKey,
        graph: {
            market: { apiKey: "market-secret", subgraphId: UNISWAP_V3_ETHEREUM_SUBGRAPH_ID },
            aave: { apiKey: "aave-secret", subgraphId: AAVE_V3_ETHEREUM_SUBGRAPH_ID },
            lookbackSeconds: 24 * 60 * 60,
            timeoutMs: 15_000,
        },
        hederaPayToAccountId: "0.0.7001",
        priceTinybar: "100000",
        idempotencyPath: "/tmp/not-used-by-issue-calibration.json",
        port: 4021,
    }, {
        requestId: "f7a4ad4d-9d5b-4f39-8e24-086d48c73e30",
        maker: "0x0000000000000000000000000000000000001234",
        pair: "aWETH/aUSDC",
        horizon: "24h",
        requestedProfile: "marginmm-v1",
        policyVersion: 2,
        validForSeconds: 3_600,
    }, {
        wallClockSeconds: () => {
            order.push("wall");
            return queriedAt;
        },
        fetchImpl: fetchMock,
        chainTimestampSeconds: () => {
            order.push("chain");
            return NOW;
        },
    });
    assert.deepEqual(order, ["wall", "graph", "graph", "chain"]);
    assert.equal(response.signedCalibration.artifact.issuedAt, NOW);
    assert.equal(response.signedCalibration.artifact.validUntil, NOW + 3_600);
    assert.equal(JSON.parse(response.canonicalEvidence).queriedAt, queriedAt);
});
test("Graph errors and incomplete evidence fail closed", async () => {
    const failingFetch = async () => new Response(JSON.stringify({
        errors: [{ message: "indexer unavailable" }],
    }), { status: 200, headers: { "content-type": "application/json" } });
    await assert.rejects(fetchGraphEvidence({
        market: { apiKey: "key", subgraphId: UNISWAP_V3_ETHEREUM_SUBGRAPH_ID },
        aave: { apiKey: "key", subgraphId: AAVE_V3_ETHEREUM_SUBGRAPH_ID },
    }, NOW, failingFetch), /Graph query failed/);
    const incompleteFetch = async (input) => {
        const raw = String(input).includes(UNISWAP_V3_ETHEREUM_SUBGRAPH_ID) ? marketData().poolHourDatas.slice(0, 5) : undefined;
        const data = raw ? { ...marketData(), poolHourDatas: raw } : aaveData();
        return new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
    };
    await assert.rejects(fetchGraphEvidence({
        market: { apiKey: "key", subgraphId: UNISWAP_V3_ETHEREUM_SUBGRAPH_ID },
        aave: { apiKey: "key", subgraphId: AAVE_V3_ETHEREUM_SUBGRAPH_ID },
    }, NOW, incompleteFetch), /Insufficient hourly market observations/);
    const oversizedFetch = async () => new Response("{}", {
        status: 200,
        headers: { "content-length": "4000001" },
    });
    await assert.rejects(fetchGraphEvidence({
        market: { apiKey: "key", subgraphId: UNISWAP_V3_ETHEREUM_SUBGRAPH_ID },
        aave: { apiKey: "key", subgraphId: AAVE_V3_ETHEREUM_SUBGRAPH_ID },
    }, NOW, oversizedFetch), /Graph response exceeds the size limit/);
});
test("canonical evidence encoding is independent of object insertion order", () => {
    assert.equal(canonicalJson({ z: 1, a: { y: 2, x: 3 } }), canonicalJson({ a: { x: 3, y: 2 }, z: 1 }));
});
test("dedicated calibrator EIP-712 signature is independently verified against its full context", async () => {
    const signer = Wallet.createRandom();
    const { result: graphEvidence } = await evidence();
    const calibrated = calibrate(graphEvidence, {
        chainId: 31337n,
        policyRegistry: POLICY_REGISTRY,
        pairId: PAIR_ID,
        policyVersion: 7,
        issuedAt: NOW,
        validUntil: NOW + 3600,
    });
    const signed = await signCalibrationArtifact(calibrated.artifact, signer.privateKey, signer.address, NOW);
    validateSignedCalibration(signed, {
        now: NOW,
        chainId: 31337n,
        policyRegistry: POLICY_REGISTRY,
        pairId: PAIR_ID,
        policyVersion: 7,
        calibrationSigner: signer.address,
    });
    assert.match(signed.signature, /^0x[0-9a-f]{130}$/);
    assert.match(signed.digest, /^0x[0-9a-f]{64}$/);
    validateSignedCalibrationEvidence(signed, calibrated.canonicalEvidence, {
        now: NOW,
        chainId: 31337n,
        policyRegistry: POLICY_REGISTRY,
        pairId: PAIR_ID,
        policyVersion: 7,
        calibrationSigner: signer.address,
    });
    assert.throws(() => validateSignedCalibrationEvidence(signed, `${calibrated.canonicalEvidence} `, {
        now: NOW,
        chainId: 31337n,
        policyRegistry: POLICY_REGISTRY,
        pairId: PAIR_ID,
        policyVersion: 7,
        calibrationSigner: signer.address,
    }), /does not match/);
    assert.throws(() => validateSignedCalibration(signed, {
        now: NOW,
        chainId: 1n,
        policyRegistry: POLICY_REGISTRY,
        pairId: PAIR_ID,
        policyVersion: 7,
        calibrationSigner: signer.address,
    }), /does not match the requested policy context/);
    assert.throws(() => validateSignedCalibration({ ...signed, digest: `0x${"ff".repeat(32)}` }, {
        now: NOW,
        chainId: 31337n,
        policyRegistry: POLICY_REGISTRY,
        pairId: PAIR_ID,
        policyVersion: 7,
        calibrationSigner: signer.address,
    }), /digest mismatch/);
    assert.throws(() => validateSignedCalibration(signed, {
        now: NOW + 3601,
        chainId: 31337n,
        policyRegistry: POLICY_REGISTRY,
        pairId: PAIR_ID,
        policyVersion: 7,
        calibrationSigner: signer.address,
    }), /invalid or expired/);
});
