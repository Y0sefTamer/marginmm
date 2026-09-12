import { PrivateKey } from "@hiero-ledger/sdk";
import { x402Client, type PaymentPolicy } from "@x402/fetch";
import { wrapFetchWithPayment } from "@x402/fetch";
import { HTTPFacilitatorClient, x402ResourceServer, type RoutesConfig } from "@x402/core/server";
import type { PaymentRequirements, SupportedResponse } from "@x402/core/types";
import { createClientHederaSigner } from "@x402/hedera";
import { ExactHederaScheme as ExactHederaClientScheme } from "@x402/hedera/exact/client";
import { ExactHederaScheme as ExactHederaServerScheme } from "@x402/hedera/exact/server";
import { paymentMiddleware } from "@x402/express";

export const HEDERA_TESTNET = "hedera:testnet" as const;
export const HBAR_ASSET = "0.0.0";
export const BLOCKY_TESTNET_FACILITATOR_URL = "https://api.testnet.blocky402.com";
export const MAX_HBAR_PRICE_TINYBAR = 10_000_000n;

const HEDERA_ACCOUNT_ID = /^0\.0\.(?:0|[1-9][0-9]*)$/;
const POSITIVE_ATOMIC_AMOUNT = /^[1-9][0-9]*$/;

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

class ValidatingBlockyFacilitatorClient extends HTTPFacilitatorClient {
  capability: HederaFacilitatorCapability | undefined;

  override async getSupported(): Promise<SupportedResponse> {
    const supported = await super.getSupported();
    this.capability = assertHederaFacilitatorSupport(supported);
    return supported;
  }
}

function assertHederaAccountId(value: string, field: string): void {
  if (!HEDERA_ACCOUNT_ID.test(value)) {
    throw new Error(`${field} must be a canonical Hedera account id`);
  }
}

export function parseHbarPriceTinybar(value: string): bigint {
  if (!POSITIVE_ATOMIC_AMOUNT.test(value)) {
    throw new Error("HBAR price must be a positive integer tinybar amount");
  }
  const amount = BigInt(value);
  if (amount > MAX_HBAR_PRICE_TINYBAR) {
    throw new Error("HBAR price exceeds the MVP safety envelope");
  }
  return amount;
}

export function assertHederaFacilitatorSupport(
  supported: SupportedResponse,
): HederaFacilitatorCapability {
  const kind = supported.kinds.find((candidate) => (
    candidate.x402Version === 2
    && candidate.scheme === "exact"
    && candidate.network === HEDERA_TESTNET
  ));
  if (!kind) {
    throw new Error("Facilitator does not advertise exact x402 v2 on Hedera testnet");
  }

  const feePayer = kind.extra?.feePayer;
  if (typeof feePayer !== "string" || !HEDERA_ACCOUNT_ID.test(feePayer)) {
    throw new Error("Facilitator returned an invalid Hedera fee payer");
  }
  const wildcardSigners = supported.signers["hedera:*"];
  if (!Array.isArray(wildcardSigners) || !wildcardSigners.includes(feePayer)) {
    throw new Error("Facilitator fee payer is not covered by its advertised signer set");
  }
  return { feePayer, signerPattern: "hedera:*" };
}

export function buildCalibrationRoutes(config: HbarPaymentConfig): RoutesConfig {
  assertHederaAccountId(config.serviceAccountId, "serviceAccountId");
  parseHbarPriceTinybar(config.priceTinybar);
  return {
    "POST /calibrate": {
      accepts: {
        scheme: "exact",
        network: HEDERA_TESTNET,
        payTo: config.serviceAccountId,
        price: { asset: HBAR_ASSET, amount: config.priceTinybar },
        maxTimeoutSeconds: 60,
      },
      description: "MarginMM deterministic market-risk calibration",
      mimeType: "application/json",
      serviceName: "MarginMM Calibration",
    },
  };
}

export async function createCalibrationPaymentMiddleware(config: HbarPaymentConfig) {
  const facilitator = new ValidatingBlockyFacilitatorClient({
    url: BLOCKY_TESTNET_FACILITATOR_URL,
    timeoutMs: 15_000,
  });
  const resourceServer = new x402ResourceServer(facilitator).register(
    HEDERA_TESTNET,
    new ExactHederaServerScheme({}),
  );
  await resourceServer.initialize();
  if (!facilitator.capability) throw new Error("Facilitator capability validation did not run");
  return {
    capability: facilitator.capability,
    middleware: paymentMiddleware(buildCalibrationRoutes(config), resourceServer, undefined, undefined, false),
  };
}

export function buildStrictHbarPaymentPolicy(config: HbarPaymentConfig): PaymentPolicy {
  assertHederaAccountId(config.serviceAccountId, "serviceAccountId");
  parseHbarPriceTinybar(config.priceTinybar);
  return (x402Version: number, requirements: PaymentRequirements[]) => {
    if (x402Version !== 2) return [];
    return requirements.filter((requirement) => (
      requirement.scheme === "exact"
      && requirement.network === HEDERA_TESTNET
      && requirement.asset === HBAR_ASSET
      && requirement.payTo === config.serviceAccountId
      && requirement.amount === config.priceTinybar
    ));
  };
}

export function createPaidCalibrationRequester(
  config: PaidCalibrationRequestConfig,
  baseFetch: typeof globalThis.fetch = globalThis.fetch,
): (body: string, idempotencyKey: string) => Promise<Response> {
  assertHederaAccountId(config.agentAccountId, "agentAccountId");
  assertHederaAccountId(config.serviceAccountId, "serviceAccountId");
  if (config.agentAccountId === config.serviceAccountId) {
    throw new Error("Hedera payer and calibration receiver accounts must be different");
  }
  parseHbarPriceTinybar(config.priceTinybar);
  const serviceUrl = new URL(config.calibrationServiceUrl);
  if (
 !["http:", "https:"].includes(serviceUrl.protocol)
 || serviceUrl.pathname !== "/calibrate"
 || serviceUrl.search !== ""
 || serviceUrl.hash !== ""
 || serviceUrl.username !== ""
 || serviceUrl.password !== ""
 ) {
 throw new Error("calibrationServiceUrl must be a valid HTTP/HTTPS /calibrate endpoint");
 }

  let privateKey: PrivateKey;
  try {
    privateKey = PrivateKey.fromStringECDSA(config.agentPrivateKey);
  } catch {
    throw new Error("agentPrivateKey must be a valid Hedera ECDSA private key");
  }

  const signer = createClientHederaSigner(config.agentAccountId, privateKey, {
    network: HEDERA_TESTNET,
  });
  const client = new x402Client()
    .register(HEDERA_TESTNET, new ExactHederaClientScheme(signer))
    .setSpendControls({
      maxAmountPerPayment: false,
      allowedAssets: [{
        network: HEDERA_TESTNET,
        asset: HBAR_ASSET,
        maxAmountPerPayment: config.priceTinybar,
      }],
    })
    .registerPolicy(buildStrictHbarPaymentPolicy(config));

  const paidFetch = wrapFetchWithPayment(baseFetch, client);
  return (body: string, idempotencyKey: string) => {
    if (!body || !idempotencyKey) throw new Error("Calibration body and idempotency key are required");
    return paidFetch(serviceUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body,
    });
  };
}
