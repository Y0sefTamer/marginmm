import express, { type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { getAddress, JsonRpcProvider, keccak256, toUtf8Bytes } from "ethers";
import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  calibrate,
  canonicalJson,
  MAX_POLICY_TTL,
  type CalibrationResult,
} from "./calibration.js";
import {
  AAVE_V3_ETHEREUM_SUBGRAPH_ID,
  fetchGraphEvidence,
  UNISWAP_V3_ETHEREUM_SUBGRAPH_ID,
  type GraphEvidenceConfig,
} from "./graph.js";
import { signCalibrationArtifact, type SignedCalibration } from "./policy-artifact.js";
import { createCalibrationPaymentMiddleware } from "./x402.js";

export const CALIBRATION_PAIR = "aWETH/aUSDC";
export const CALIBRATION_HORIZON = "24h";
export const CALIBRATION_PROFILE = "marginmm-v1";
export const CALIBRATION_CHAIN_ID = 31337n;

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((value) => getAddress(value));
const bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((value) => value.toLowerCase());
const requestId = z.string().uuid();
const requestHash = z.string().regex(/^0x[0-9a-f]{64}$/);
const MAX_IDEMPOTENCY_JOURNAL_BYTES = 8 * 1024 * 1024;
const calibrationRequestSchema = z.object({
  requestId,
  maker: address,
  pair: z.literal(CALIBRATION_PAIR),
  horizon: z.literal(CALIBRATION_HORIZON),
  requestedProfile: z.literal(CALIBRATION_PROFILE),
  policyVersion: z.number().int().min(1).max(0xffff_ffff),
  validForSeconds: z.number().int().min(1).max(MAX_POLICY_TTL),
}).strict();

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
    artifact: Omit<SignedCalibration["artifact"], "chainId"> & { chainId: string };
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

type StoredCalibration = {
  requestHash: string;
  state: "pending" | "complete";
  response?: CalibrationApiResponse;
};

export class CalibrationIdempotencyStore {
  readonly #entries = new Map<string, StoredCalibration>();
  readonly #journalPath: string | undefined;

  constructor(readonly maxEntries = 512, journalPath?: string) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) throw new Error("Invalid idempotency capacity");
    if (journalPath !== undefined && !journalPath.trim()) throw new Error("Idempotency journal path is invalid");
    this.#journalPath = journalPath;
  }

  static load(journalPath: string, maxEntries = 512): CalibrationIdempotencyStore {
    const store = new CalibrationIdempotencyStore(maxEntries, journalPath);
    const temporaryPath = `${journalPath}.tmp`;
    let raw: string;
    try {
      // A leftover atomic-write file can contain a newer reservation. Prefer it
      // over the prior snapshot so a crash remains fail-closed rather than paid twice.
      const path = readJournalCandidate(temporaryPath) ? temporaryPath : journalPath;
      raw = readFileSync(path, "utf8");
      if (Buffer.byteLength(raw, "utf8") > MAX_IDEMPOTENCY_JOURNAL_BYTES) {
        throw new Error("Calibration idempotency journal exceeds the size limit");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return store;
      throw new Error("Calibration idempotency journal is unreadable");
    }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch { throw new Error("Calibration idempotency journal is invalid"); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Calibration idempotency journal is invalid");
    }
    const entries = Object.entries(parsed as Record<string, unknown>);
    if (entries.length > maxEntries) throw new Error("Calibration idempotency journal exceeds capacity");
    for (const [id, entry] of entries) {
      const value = entry as Partial<StoredCalibration> | null;
      if (
        !requestId.safeParse(id).success || !value || typeof value !== "object" || Array.isArray(value)
          || !requestHash.safeParse(value.requestHash).success || !["pending", "complete"].includes(String(value.state))
          || (value.state === "pending" && Object.keys(value).length !== 2)
          || (value.state === "complete" && (Object.keys(value).length !== 3 || !value.response || typeof value.response !== "object"))
      ) throw new Error("Calibration idempotency journal is invalid");
      store.#entries.set(id, value as StoredCalibration);
    }
    return store;
  }

  inspect(requestId: string, requestHash: string): "missing" | "pending" | "conflict" | CalibrationApiResponse {
    const entry = this.#entries.get(requestId);
    if (!entry) return "missing";
    if (entry.requestHash !== requestHash) return "conflict";
    if (entry.state === "pending") return "pending";
    if (!entry.response) throw new Error("Invalid completed idempotency entry");
    return entry.response;
  }

  reserve(requestId: string, requestHash: string): "reserved" | "pending" | "conflict" | CalibrationApiResponse {
    const existing = this.inspect(requestId, requestHash);
    if (existing !== "missing") return existing;
    if (this.#entries.size >= this.maxEntries) throw new Error("Calibration idempotency capacity is exhausted");
    this.#entries.set(requestId, { requestHash, state: "pending" });
    try { this.#persist(); }
    catch (error) {
      this.#entries.delete(requestId);
      throw error;
    }
    return "reserved";
  }

  complete(requestId: string, requestHash: string, response: CalibrationApiResponse): void {
    const entry = this.#entries.get(requestId);
    if (!entry || entry.requestHash !== requestHash || entry.state !== "pending") {
      throw new Error("Cannot complete an unreserved calibration request");
    }
    this.#entries.set(requestId, { requestHash, state: "complete", response });
    try { this.#persist(); }
    catch (error) {
      this.#entries.set(requestId, entry);
      throw error;
    }
  }

  release(requestId: string, requestHash: string): void {
    const entry = this.#entries.get(requestId);
    if (entry?.state !== "pending" || entry.requestHash !== requestHash) return;
    this.#entries.delete(requestId);
    try { this.#persist(); }
    catch (error) {
      this.#entries.set(requestId, entry);
      throw error;
    }
  }

  #persist(): void {
    if (!this.#journalPath) return;
    const serialized = JSON.stringify(Object.fromEntries(this.#entries));
    if (Buffer.byteLength(serialized, "utf8") > MAX_IDEMPOTENCY_JOURNAL_BYTES) {
      throw new Error("Calibration idempotency journal exceeds the size limit");
    }
    const temporaryPath = `${this.#journalPath}.tmp`;
    writeFileSync(temporaryPath, serialized, { encoding: "utf8", mode: 0o600, flush: true });
    renameSync(temporaryPath, this.#journalPath);
  }
}

function readJournalCandidate(path: string): boolean {
  try {
    const size = statSync(path).size;
    if (size > MAX_IDEMPOTENCY_JOURNAL_BYTES) {
      throw new Error("Calibration idempotency journal exceeds the size limit");
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error("Calibration idempotency journal is unreadable");
  }
}

export function parseCalibrationApiRequest(value: unknown): CalibrationApiRequest {
  return calibrationRequestSchema.parse(value);
}

export function calibrationRequestHash(request: CalibrationApiRequest): string {
  return keccak256(toUtf8Bytes(canonicalJson(request)));
}

export async function issueCalibration(
  config: CalibrationServiceConfig,
  request: CalibrationApiRequest,
  dependencies: Pick<
    CalibrationServiceDependencies,
    "fetchImpl" | "wallClockSeconds" | "chainTimestampSeconds"
  > = {},
): Promise<CalibrationApiResponse> {
  const queriedAt = (dependencies.wallClockSeconds ?? (() => Math.floor(Date.now() / 1_000)))();
  if (!Number.isSafeInteger(queriedAt) || queriedAt <= 0) throw new Error("System clock is invalid");
  const evidence = await fetchGraphEvidence(
    config.graph,
    queriedAt,
    dependencies.fetchImpl ?? globalThis.fetch,
  );
  const issuedAt = await (dependencies.chainTimestampSeconds
    ?? (() => readLatestChainTimestamp(config.ethereumRpcUrl)))();
  if (!Number.isSafeInteger(issuedAt) || issuedAt <= 0) throw new Error("Chain timestamp is invalid");
  const calibrated = calibrate(evidence, {
    chainId: CALIBRATION_CHAIN_ID,
    policyRegistry: config.policyRegistry,
    pairId: config.pairId,
    policyVersion: request.policyVersion,
    issuedAt,
    validUntil: issuedAt + request.validForSeconds,
  });
  const signed = await signCalibrationArtifact(
    calibrated.artifact,
    config.calibrationSignerPrivateKey,
    config.calibrationSignerAddress,
    issuedAt,
  );
  return {
    schema: "marginmm-calibration-response-v1",
    request,
    signedCalibration: {
      ...signed,
      artifact: { ...signed.artifact, chainId: signed.artifact.chainId.toString() },
    },
    diagnostics: calibrated.diagnostics,
    canonicalEvidence: calibrated.canonicalEvidence,
  };
}

export async function createCalibrationApp(
  config: CalibrationServiceConfig,
  dependencies: CalibrationServiceDependencies = {},
) {
  validateServiceConfig(config);
  const store = CalibrationIdempotencyStore.load(config.idempotencyPath);
  const payment = dependencies.paymentMiddleware
    ? { middleware: dependencies.paymentMiddleware }
    : await createCalibrationPaymentMiddleware({
      serviceAccountId: config.hederaPayToAccountId,
      priceTinybar: config.priceTinybar,
    });
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "32kb", strict: true }));

  app.get("/health", (_request, response) => {
    response.json({ status: "ok", graph: "live-required", x402: "hedera:testnet" });
  });

  app.post("/calibrate", (request, response, next) => {
    try {
      const parsed = parseCalibrationApiRequest(request.body);
      const idempotencyKey = request.get("Idempotency-Key");
      if (idempotencyKey !== parsed.requestId) {
        response.status(400).json({ error: "Idempotency-Key must equal requestId" });
        return;
      }
      const requestHash = calibrationRequestHash(parsed);
      const existing = store.inspect(parsed.requestId, requestHash);
      if (existing === "conflict") {
        response.status(409).json({ error: "requestId was already used for a different request" });
        return;
      }
      if (existing === "pending") {
        response.setHeader("Retry-After", "1");
        response.status(409).json({ error: "Calibration request is already processing" });
        return;
      }
      if (existing !== "missing") {
        response.setHeader("X-MarginMM-Idempotent-Replay", "true");
        response.status(200).json(existing);
        return;
      }
      const reservation = store.reserve(parsed.requestId, requestHash);
      if (reservation !== "reserved") throw new Error("Calibration idempotency reservation changed unexpectedly");
      response.locals.calibrationRequest = parsed;
      response.locals.calibrationRequestHash = requestHash;
      response.once("finish", () => {
        // A 402 is emitted before the x402 middleware settles anything. Every
        // other non-success response remains pending for manual reconciliation.
        if (response.statusCode === 402) {
          try { store.release(parsed.requestId, requestHash); } catch { /* fail closed */ }
        }
      });
      next();
    } catch (error) {
      next(error);
    }
  });

  app.use(payment.middleware);

  app.post("/calibrate", async (_request, response, next) => {
    const parsed = response.locals.calibrationRequest as CalibrationApiRequest;
    const requestHash = response.locals.calibrationRequestHash as string;
    try {
      const result = await issueCalibration(config, parsed, dependencies);
      // Payment middleware only calls this handler after successful settlement.
      // Persist before responding so a dropped response replays without a second payment.
      store.complete(parsed.requestId, requestHash, result);
      response.status(200).json(result);
    } catch (error) {
      // Payment may already have settled. Keep the reservation pending rather
      // than risk charging the same idempotency key a second time.
      next(error);
    }
  });

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      response.status(400).json({ error: "Invalid calibration request" });
      return;
    }
    console.error("Calibration request failed", error instanceof Error ? error.message : "unknown error");
    response.status(502).json({ error: "Calibration unavailable" });
  });
  return app;
}

export function loadCalibrationServiceConfig(env: NodeJS.ProcessEnv = process.env): CalibrationServiceConfig {
  const chainId = required(env, "MARGINMM_CHAIN_ID");
  if (chainId !== CALIBRATION_CHAIN_ID.toString()) throw new Error("MARGINMM_CHAIN_ID must be 31337 for the MVP demo");
  const graphApiKey = required(env, "GRAPH_API_KEY");
  const ethereumRpcUrl = required(env, "MARGINMM_ETHEREUM_RPC_URL");
  validateLocalRpcUrl(ethereumRpcUrl);
  const port = Number(env.CALIBRATION_PORT ?? "4021");
  return {
    ethereumRpcUrl,
    policyRegistry: required(env, "MARGINMM_POLICY_REGISTRY"),
    pairId: required(env, "MARGINMM_PAIR_ID"),
    calibrationSignerAddress: required(env, "CALIBRATION_SIGNER_ADDRESS"),
    calibrationSignerPrivateKey: required(env, "CALIBRATION_SIGNER_PRIVATE_KEY"),
    graph: {
      market: {
        apiKey: graphApiKey,
        subgraphId: env.UNISWAP_SUBGRAPH_ID ?? UNISWAP_V3_ETHEREUM_SUBGRAPH_ID,
      },
      aave: {
        apiKey: graphApiKey,
        subgraphId: env.AAVE_SUBGRAPH_ID ?? AAVE_V3_ETHEREUM_SUBGRAPH_ID,
      },
      lookbackSeconds: 7 * 24 * 60 * 60,
      timeoutMs: 15_000,
    },
    hederaPayToAccountId: required(env, "HEDERA_PAYTO_ACCOUNT_ID"),
    priceTinybar: required(env, "X402_PRICE_TINYBAR"),
    idempotencyPath: required(env, "CALIBRATION_IDEMPOTENCY_PATH"),
    port,
  };
}

function validateServiceConfig(config: CalibrationServiceConfig): void {
  validateLocalRpcUrl(config.ethereumRpcUrl);
  config.policyRegistry = getAddress(config.policyRegistry);
  config.calibrationSignerAddress = getAddress(config.calibrationSignerAddress);
  config.pairId = bytes32.parse(config.pairId);
  if (!config.idempotencyPath.trim()) throw new Error("Calibration idempotency journal path is invalid");
  if (!Number.isSafeInteger(config.port) || config.port < 1_024 || config.port > 65_535) {
    throw new Error("Calibration port is invalid");
  }
}

export async function readLatestChainTimestamp(ethereumRpcUrl: string): Promise<number> {
  validateLocalRpcUrl(ethereumRpcUrl);
  const rpc = new JsonRpcProvider(ethereumRpcUrl, undefined, { cacheTimeout: -1, batchMaxCount: 1 });
  try {
    const network = await rpc.getNetwork();
    if (network.chainId !== CALIBRATION_CHAIN_ID) throw new Error("Calibration RPC must use chain 31337");
    const block = await rpc.getBlock("latest");
    if (!block || !Number.isSafeInteger(block.timestamp) || block.timestamp <= 0) {
      throw new Error("Calibration RPC returned an invalid latest block");
    }
    return block.timestamp;
  } finally {
    rpc.destroy();
  }
}

function validateLocalRpcUrl(value: string): void {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error("Calibration RPC URL is invalid"); }
  if (
    url.protocol !== "http:"
    || !["127.0.0.1", "localhost"].includes(url.hostname)
    || url.username
    || url.password
  ) throw new Error("Calibration RPC must be a loopback HTTP endpoint");
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const config = loadCalibrationServiceConfig();
  const app = await createCalibrationApp(config);
  const host = process.env.HOST || "0.0.0.0";
 const server = app.listen(config.port, host, () => {
 console.log(`MarginMM calibration service ready on http://${host}:${config.port}`);
 });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => server.close(() => process.exit(0)));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error("Calibration service startup failed", error instanceof Error ? error.message : "unknown error");
    process.exitCode = 1;
  });
}
