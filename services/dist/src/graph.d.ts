import { z } from "zod";
export declare const AAVE_V3_ETHEREUM_SUBGRAPH_ID = "Cd2gEDVeqnjBn1hSeqFMitw8Q1iiyV9FYUZkLNRcL87g";
export declare const UNISWAP_V3_ETHEREUM_SUBGRAPH_ID = "5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV";
export declare const WETH_ADDRESS = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
export declare const USDC_ADDRESS = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
export declare const WETH_USDC_005_POOL = "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640";
declare const marketResponse: z.ZodObject<{
    _meta: z.ZodObject<{
        deployment: z.ZodString;
        hasIndexingErrors: z.ZodBoolean;
        block: z.ZodObject<{
            number: z.ZodNumber;
            hash: z.ZodNullable<z.ZodString>;
        }, z.core.$strip>;
    }, z.core.$strip>;
    pool: z.ZodNullable<z.ZodObject<{
        id: z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>;
        feeTier: z.ZodString;
        token0: z.ZodObject<{
            id: z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>;
            symbol: z.ZodString;
            decimals: z.ZodString;
        }, z.core.$strip>;
        token1: z.ZodObject<{
            id: z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>;
            symbol: z.ZodString;
            decimals: z.ZodString;
        }, z.core.$strip>;
    }, z.core.$strip>>;
    poolHourDatas: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        periodStartUnix: z.ZodNumber;
        token0Price: z.ZodString;
        token1Price: z.ZodString;
        open: z.ZodString;
        high: z.ZodString;
        low: z.ZodString;
        close: z.ZodString;
        volumeUSD: z.ZodString;
        tvlUSD: z.ZodString;
    }, z.core.$strip>>;
    firstSwap: z.ZodArray<z.ZodObject<{
        transaction: z.ZodObject<{
            blockNumber: z.ZodString;
        }, z.core.$strip>;
    }, z.core.$strip>>;
    lastSwap: z.ZodArray<z.ZodObject<{
        transaction: z.ZodObject<{
            blockNumber: z.ZodString;
        }, z.core.$strip>;
    }, z.core.$strip>>;
}, z.core.$strip>;
declare const aaveResponse: z.ZodObject<{
    _meta: z.ZodObject<{
        deployment: z.ZodString;
        hasIndexingErrors: z.ZodBoolean;
        block: z.ZodObject<{
            number: z.ZodNumber;
            hash: z.ZodNullable<z.ZodString>;
        }, z.core.$strip>;
    }, z.core.$strip>;
    reserves: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        underlyingAsset: z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>;
        symbol: z.ZodString;
        decimals: z.ZodNumber;
        usageAsCollateralEnabled: z.ZodBoolean;
        borrowingEnabled: z.ZodBoolean;
        isActive: z.ZodBoolean;
        isFrozen: z.ZodBoolean;
        reserveLiquidationThreshold: z.ZodString;
        utilizationRate: z.ZodString;
        totalLiquidity: z.ZodString;
        availableLiquidity: z.ZodString;
        totalCurrentVariableDebt: z.ZodString;
        variableBorrowRate: z.ZodString;
        liquidityRate: z.ZodString;
    }, z.core.$strip>>;
    liquidationCalls: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        txHash: z.ZodString;
        timestamp: z.ZodNumber;
        collateralAmount: z.ZodString;
        principalAmount: z.ZodString;
        collateralReserve: z.ZodObject<{
            underlyingAsset: z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>;
            symbol: z.ZodString;
        }, z.core.$strip>;
        principalReserve: z.ZodObject<{
            underlyingAsset: z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>;
            symbol: z.ZodString;
        }, z.core.$strip>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type MarketEvidence = z.infer<typeof marketResponse>;
export type AaveEvidence = z.infer<typeof aaveResponse>;
export interface GraphSource {
    apiKey: string;
    subgraphId: string;
    deploymentId?: string;
}
export interface GraphEvidenceConfig {
    market: GraphSource;
    aave: GraphSource;
    marketPool?: string;
    lookbackSeconds?: number;
    timeoutMs?: number;
}
export interface GraphEvidence {
    queriedAt: number;
    fromTimestamp: number;
    market: MarketEvidence;
    aave: AaveEvidence;
}
type Fetch = typeof globalThis.fetch;
export declare function fetchGraphEvidence(config: GraphEvidenceConfig, nowSeconds: number, fetchImpl?: Fetch): Promise<GraphEvidence>;
export {};
