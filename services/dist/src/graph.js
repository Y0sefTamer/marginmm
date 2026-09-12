import { z } from "zod";
export const AAVE_V3_ETHEREUM_SUBGRAPH_ID = "Cd2gEDVeqnjBn1hSeqFMitw8Q1iiyV9FYUZkLNRcL87g";
export const UNISWAP_V3_ETHEREUM_SUBGRAPH_ID = "5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV";
export const WETH_ADDRESS = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
export const USDC_ADDRESS = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
export const WETH_USDC_005_POOL = "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640";
const identifier = z.string().regex(/^[A-Za-z0-9_-]{20,100}$/);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((value) => value.toLowerCase());
const unsignedInteger = z.string().regex(/^\d+$/);
const decimal = z.string().regex(/^\d+(?:\.\d+)?$/);
const MAX_GRAPH_RESPONSE_BYTES = 4_000_000;
const meta = z.object({
    deployment: z.string().min(1),
    hasIndexingErrors: z.boolean(),
    block: z.object({ number: z.number().int().nonnegative(), hash: z.string().nullable() }),
});
const marketResponse = z.object({
    _meta: meta,
    pool: z.object({
        id: address,
        feeTier: unsignedInteger,
        token0: z.object({ id: address, symbol: z.string(), decimals: unsignedInteger }),
        token1: z.object({ id: address, symbol: z.string(), decimals: unsignedInteger }),
    }).nullable(),
    poolHourDatas: z.array(z.object({
        id: z.string().min(1),
        periodStartUnix: z.number().int().nonnegative(),
        token0Price: decimal,
        token1Price: decimal,
        open: decimal,
        high: decimal,
        low: decimal,
        close: decimal,
        volumeUSD: decimal,
        tvlUSD: decimal,
    })),
    firstSwap: z.array(z.object({ transaction: z.object({ blockNumber: unsignedInteger }) })).max(1),
    lastSwap: z.array(z.object({ transaction: z.object({ blockNumber: unsignedInteger }) })).max(1),
});
const reserve = z.object({
    id: z.string().min(1),
    underlyingAsset: address,
    symbol: z.string(),
    decimals: z.number().int().nonnegative(),
    usageAsCollateralEnabled: z.boolean(),
    borrowingEnabled: z.boolean(),
    isActive: z.boolean(),
    isFrozen: z.boolean(),
    reserveLiquidationThreshold: unsignedInteger,
    utilizationRate: decimal,
    totalLiquidity: unsignedInteger,
    availableLiquidity: unsignedInteger,
    totalCurrentVariableDebt: unsignedInteger,
    variableBorrowRate: unsignedInteger,
    liquidityRate: unsignedInteger,
});
const aaveResponse = z.object({
    _meta: meta,
    reserves: z.array(reserve),
    liquidationCalls: z.array(z.object({
        id: z.string().min(1),
        txHash: z.string().min(1),
        timestamp: z.number().int().nonnegative(),
        collateralAmount: unsignedInteger,
        principalAmount: unsignedInteger,
        collateralReserve: z.object({ underlyingAsset: address, symbol: z.string() }),
        principalReserve: z.object({ underlyingAsset: address, symbol: z.string() }),
    })),
});
const MARKET_QUERY = `
  query MarginMMMarketEvidence($pool: ID!, $from: Int!) {
    _meta { deployment hasIndexingErrors block { number hash } }
    pool(id: $pool) {
      id feeTier
      token0 { id symbol decimals }
      token1 { id symbol decimals }
    }
    poolHourDatas(
      first: 1000
      orderBy: periodStartUnix
      orderDirection: asc
      where: { pool: $pool, periodStartUnix_gte: $from }
    ) {
      id periodStartUnix token0Price token1Price open high low close volumeUSD tvlUSD
    }
    firstSwap: swaps(
      first: 1
      orderBy: timestamp
      orderDirection: asc
      where: { pool: $pool, timestamp_gte: $from }
    ) { transaction { blockNumber } }
    lastSwap: swaps(
      first: 1
      orderBy: timestamp
      orderDirection: desc
      where: { pool: $pool, timestamp_gte: $from }
    ) { transaction { blockNumber } }
  }
`;
const AAVE_QUERY = `
  query MarginMMAaveEvidence($assets: [Bytes!]!, $from: Int!) {
    _meta { deployment hasIndexingErrors block { number hash } }
    reserves(where: { underlyingAsset_in: $assets }) {
      id underlyingAsset symbol decimals usageAsCollateralEnabled borrowingEnabled
      isActive isFrozen reserveLiquidationThreshold utilizationRate totalLiquidity
      availableLiquidity totalCurrentVariableDebt variableBorrowRate liquidityRate
    }
    liquidationCalls(
      first: 1000
      orderBy: timestamp
      orderDirection: desc
      where: { timestamp_gte: $from }
    ) {
      id txHash timestamp collateralAmount principalAmount
      collateralReserve { underlyingAsset symbol }
      principalReserve { underlyingAsset symbol }
    }
  }
`;
export async function fetchGraphEvidence(config, nowSeconds, fetchImpl = globalThis.fetch) {
    if (!Number.isSafeInteger(nowSeconds) || nowSeconds <= 0)
        throw new Error("Invalid evidence timestamp");
    const lookbackSeconds = config.lookbackSeconds ?? 7 * 24 * 60 * 60;
    const timeoutMs = config.timeoutMs ?? 15_000;
    if (!Number.isSafeInteger(lookbackSeconds) || lookbackSeconds < 24 * 60 * 60 || lookbackSeconds > 30 * 24 * 60 * 60) {
        throw new Error("Graph lookback must be between one and thirty days");
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) {
        throw new Error("Graph timeout is outside the supported range");
    }
    const fromTimestamp = nowSeconds - lookbackSeconds;
    const marketPool = address.parse(config.marketPool ?? WETH_USDC_005_POOL);
    const [marketRaw, aaveRaw] = await Promise.all([
        queryGraph(config.market, MARKET_QUERY, { pool: marketPool, from: fromTimestamp }, timeoutMs, fetchImpl),
        queryGraph(config.aave, AAVE_QUERY, { assets: [WETH_ADDRESS, USDC_ADDRESS], from: fromTimestamp }, timeoutMs, fetchImpl),
    ]);
    const market = marketResponse.parse(marketRaw);
    const aave = aaveResponse.parse(aaveRaw);
    validateMarketEvidence(market, marketPool);
    validateAaveEvidence(aave);
    return { queriedAt: nowSeconds, fromTimestamp, market, aave };
}
function endpoint(source) {
    if (!source.apiKey.trim())
        throw new Error("Graph API key is required");
    const id = identifier.parse(source.deploymentId ?? source.subgraphId);
    const kind = source.deploymentId ? "deployments" : "subgraphs";
    return `https://gateway.thegraph.com/api/${kind}/id/${id}`;
}
async function queryGraph(source, query, variables, timeoutMs, fetchImpl) {
    const response = await fetchImpl(endpoint(source), {
        method: "POST",
        headers: {
            "authorization": `Bearer ${source.apiKey}`,
            "content-type": "application/json",
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok)
        throw new Error(`Graph gateway request failed with HTTP ${response.status}`);
    const payload = await readJsonWithLimit(response, MAX_GRAPH_RESPONSE_BYTES);
    const envelope = z.object({
        data: z.unknown().optional(),
        errors: z.array(z.object({ message: z.string() })).optional(),
    }).parse(payload);
    if (envelope.errors?.length)
        throw new Error(`Graph query failed: ${envelope.errors[0]?.message ?? "unknown error"}`);
    if (envelope.data === undefined)
        throw new Error("Graph query returned no data");
    return envelope.data;
}
async function readJsonWithLimit(response, limit) {
    const declared = response.headers.get("content-length");
    if (declared && Number(declared) > limit)
        throw new Error("Graph response exceeds the size limit");
    if (!response.body)
        throw new Error("Graph response has no body");
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
            throw new Error("Graph response exceeds the size limit");
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
        throw new Error("Graph response is not valid UTF-8 JSON");
    }
}
function validateMarketEvidence(evidence, expectedPool) {
    if (evidence._meta.hasIndexingErrors)
        throw new Error("Market subgraph reports indexing errors");
    if (!evidence.pool || evidence.pool.id !== expectedPool)
        throw new Error("Configured market pool was not indexed");
    const tokens = new Set([evidence.pool.token0.id, evidence.pool.token1.id]);
    if (!tokens.has(WETH_ADDRESS) || !tokens.has(USDC_ADDRESS))
        throw new Error("Market pool is not WETH/USDC");
    if (evidence.poolHourDatas.length < 25)
        throw new Error("Insufficient hourly market observations");
    if (evidence.poolHourDatas.length === 1000)
        throw new Error("Market evidence is truncated");
    if (evidence.firstSwap.length !== 1 || evidence.lastSwap.length !== 1) {
        throw new Error("Market evidence has no block range");
    }
    for (let index = 1; index < evidence.poolHourDatas.length; index += 1) {
        const previous = evidence.poolHourDatas[index - 1];
        const current = evidence.poolHourDatas[index];
        if (!previous || !current || current.periodStartUnix <= previous.periodStartUnix) {
            throw new Error("Market observations are not strictly chronological");
        }
    }
}
function validateAaveEvidence(evidence) {
    if (evidence._meta.hasIndexingErrors)
        throw new Error("Aave subgraph reports indexing errors");
    if (evidence.liquidationCalls.length === 1000)
        throw new Error("Aave liquidation evidence is truncated");
    const byAsset = new Map(evidence.reserves.map((item) => [item.underlyingAsset, item]));
    if (byAsset.size !== 2 || !byAsset.has(WETH_ADDRESS) || !byAsset.has(USDC_ADDRESS)) {
        throw new Error("Aave evidence must contain exactly the WETH and USDC reserves");
    }
    const weth = byAsset.get(WETH_ADDRESS);
    const usdc = byAsset.get(USDC_ADDRESS);
    if (!weth.isActive || !usdc.isActive || !weth.usageAsCollateralEnabled || !usdc.usageAsCollateralEnabled) {
        throw new Error("Aave collateral reserve configuration is unsupported");
    }
    if (!usdc.borrowingEnabled || BigInt(usdc.totalCurrentVariableDebt) === 0n) {
        throw new Error("Aave USDC variable-debt evidence is unavailable");
    }
    if (BigInt(weth.totalLiquidity) === 0n || BigInt(usdc.totalLiquidity) === 0n) {
        throw new Error("Aave reserve liquidity evidence is unavailable");
    }
}
