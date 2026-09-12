import { type RequestHandler } from "express";
import { z } from "zod";
import { type CalibrationResult } from "./calibration.js";
import { type GraphEvidenceConfig } from "./graph.js";
import { type SignedCalibration } from "./policy-artifact.js";
export declare const CALIBRATION_PAIR = "aWETH/aUSDC";
export declare const CALIBRATION_HORIZON = "24h";
export declare const CALIBRATION_PROFILE = "marginmm-v1";
export declare const CALIBRATION_CHAIN_ID = 31337n;
declare const calibrationRequestSchema: z.ZodObject<{
    requestId: z.ZodString;
    maker: z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>;
    pair: z.ZodLiteral<"aWETH/aUSDC">;
    horizon: z.ZodLiteral<"24h">;
    requestedProfile: z.ZodLiteral<"marginmm-v1">;
    policyVersion: z.ZodNumber;
    validForSeconds: z.ZodNumber;
}, z.core.$strict>;
export type CalibrationApiRequest = z.infer<typeof calibrationRequestSchema>;
export interface CalibrationServiceConfig {
    ethereumRpcUrl: string;
    policyRegistry: string;
    pairId: string;
    calibrationSignerAddress: string;
    calibrationSignerPrivateKey: string;
    graph: GraphEvidenceConfig;
    hederaPayToAccountId: string;
    priceTinybar: string;
    idempotencyPath: string;
    port: number;
}
export interface CalibrationApiResponse {
    schema: "marginmm-calibration-response-v1";
    request: CalibrationApiRequest;
    signedCalibration: Omit<SignedCalibration, "artifact"> & {
        artifact: Omit<SignedCalibration["artifact"], "chainId"> & {
            chainId: string;
        };
    };
    diagnostics: CalibrationResult["diagnostics"];
    canonicalEvidence: string;
}
export interface CalibrationServiceDependencies {
    fetchImpl?: typeof globalThis.fetch;
    wallClockSeconds?: () => number;
    chainTimestampSeconds?: () => number | Promise<number>;
    paymentMiddleware?: RequestHandler;
}
export declare class CalibrationIdempotencyStore {
    #private;
    readonly maxEntries: number;
    constructor(maxEntries?: number, journalPath?: string);
    static load(journalPath: string, maxEntries?: number): CalibrationIdempotencyStore;
    inspect(requestId: string, requestHash: string): "missing" | "pending" | "conflict" | CalibrationApiResponse;
    reserve(requestId: string, requestHash: string): "reserved" | "pending" | "conflict" | CalibrationApiResponse;
    complete(requestId: string, requestHash: string, response: CalibrationApiResponse): void;
    release(requestId: string, requestHash: string): void;
}
export declare function parseCalibrationApiRequest(value: unknown): CalibrationApiRequest;
export declare function calibrationRequestHash(request: CalibrationApiRequest): string;
export declare function issueCalibration(config: CalibrationServiceConfig, request: CalibrationApiRequest, dependencies?: Pick<CalibrationServiceDependencies, "fetchImpl" | "wallClockSeconds" | "chainTimestampSeconds">): Promise<CalibrationApiResponse>;
export declare function createCalibrationApp(config: CalibrationServiceConfig, dependencies?: CalibrationServiceDependencies): Promise<import("express-serve-static-core").Express>;
export declare function loadCalibrationServiceConfig(env?: NodeJS.ProcessEnv): CalibrationServiceConfig;
export declare function readLatestChainTimestamp(ethereumRpcUrl: string): Promise<number>;
export {};
