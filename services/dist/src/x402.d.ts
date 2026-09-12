import { type PaymentPolicy } from "@x402/fetch";
import { type RoutesConfig } from "@x402/core/server";
import type { SupportedResponse } from "@x402/core/types";
export declare const HEDERA_TESTNET: "hedera:testnet";
export declare const HBAR_ASSET = "0.0.0";
export declare const BLOCKY_TESTNET_FACILITATOR_URL = "https://api.testnet.blocky402.com";
export declare const MAX_HBAR_PRICE_TINYBAR = 10000000n;
export interface HederaFacilitatorCapability {
    feePayer: string;
    signerPattern: "hedera:*";
}
export interface HbarPaymentConfig {
    serviceAccountId: string;
    priceTinybar: string;
}
export interface PaidCalibrationRequestConfig extends HbarPaymentConfig {
    agentAccountId: string;
    agentPrivateKey: string;
    calibrationServiceUrl: string;
}
export declare function parseHbarPriceTinybar(value: string): bigint;
export declare function assertHederaFacilitatorSupport(supported: SupportedResponse): HederaFacilitatorCapability;
export declare function buildCalibrationRoutes(config: HbarPaymentConfig): RoutesConfig;
export declare function createCalibrationPaymentMiddleware(config: HbarPaymentConfig): Promise<{
    capability: HederaFacilitatorCapability;
    middleware: (req: import("express").Request, res: import("express").Response, next: import("express").NextFunction) => Promise<void>;
}>;
export declare function buildStrictHbarPaymentPolicy(config: HbarPaymentConfig): PaymentPolicy;
export declare function createPaidCalibrationRequester(config: PaidCalibrationRequestConfig, baseFetch?: typeof globalThis.fetch): (body: string, idempotencyKey: string) => Promise<Response>;
