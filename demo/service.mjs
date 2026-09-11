import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import {
  AbiCoder, MaxUint256, formatUnits, keccak256, toUtf8Bytes,
} from 'ethers';
import { ApiError, decimal, exactObject } from './guards.mjs';
import { RUNTIME, assertFork, contracts } from './chain.mjs';

const DEMO_DEADLINE_SECONDS = 60;
const MAX_PRICE = 100_000n * 10n ** 6n;
const MIN_PRICE = 100n * 10n ** 6n;
const MAX_INPUT = 1_000_000n;
const AGENT_REQUESTS_PATH = `${RUNTIME}agent-requests.json`;
const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const hf = value => value === MaxUint256 ? null : formatUnits(value, 18);
const plainOrder = order => [order[0], order[1].toString(), order[2]];

export async function saveConfig(config) {
  await writeFile(`${RUNTIME}deployment.tmp`, JSON.stringify(config, null, 2), { mode: 0o600 });
  await rename(`${RUNTIME}deployment.tmp`, `${RUNTIME}deployment.json`);
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new ApiError('AGENT_NOT_CONFIGURED', 503);
  return value;
}

function integerEnv(name, minimum, maximum) {
  const value = Number(requiredEnv(name));
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ApiError('AGENT_NOT_CONFIGURED', 503);
  }
  return value;
}

function integerSquareRoot(value) {
  if (value < 0n) throw new ApiError('INVALID_INPUT');
  if (value < 2n) return value;
  let left = 1n;
  let right = 1n << (BigInt(value.toString(2).length) / 2n + 1n);
  while (left + 1n < right) {
    const middle = (left + right) / 2n;
    if (middle * middle <= value) left = middle;
    else right = middle;
  }
  return left;
}

function contractFailure(error) {
  const name = error?.revert?.name ?? error?.errorName ?? '';
  if (name === 'StalePolicy') return new ApiError('STALE_QUOTE', 409);
  if (name === 'DeadlineExpired') return new ApiError('QUOTE_EXPIRED', 409);
  return new ApiError('POLICY_REJECTED', 409);
}

export async function createService(rpc, config, dependencies = {}) {
  await assertFork(rpc, config.instanceId);
  try {
    await readFile(`${RUNTIME}pending.json`);
    throw new Error('An earlier mutation has an uncertain outcome. Restart the complete local demo on a fresh fork.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }

  const c = await contracts(rpc, config);
  if ((await c.policy.calibrationSigner()).toLowerCase() !== config.calibrationSigner.toLowerCase()) {
    throw new Error('Calibration signer does not match the deployed policy registry.');
  }
  const quotes = new Map();
  const agentRuns = await loadAgentRuns();
  let halted = false;

  async function guard() {
    if (halted) throw new ApiError('FORK_UNAVAILABLE', 503);
    try { await assertFork(rpc, config.instanceId); }
    catch { throw new ApiError('FORK_UNAVAILABLE', 503); }
  }

  async function transaction(kind, send) {
    await guard();
    await writeFile(`${RUNTIME}pending.json`, JSON.stringify({ kind, at: new Date().toISOString() }),
      { flag: 'wx', mode: 0o600, flush: true });
    halted = true;
    try {
      const tx = await send();
      await writeFile(`${RUNTIME}pending.json`, JSON.stringify({ kind, transactionHash: tx.hash }),
        { mode: 0o600, flush: true });
      const mined = await tx.wait(1, 60_000);
      if (!mined) throw new Error('No receipt');
      await unlink(`${RUNTIME}pending.json`);
      halted = false;
      if (mined.status !== 1) throw new ApiError('POLICY_REJECTED', 409);
      return mined;
    } catch (error) {
      if (error.receipt?.status === 0) {
        await unlink(`${RUNTIME}pending.json`);
        halted = false;
        throw contractFailure(error);
      }
      if (error instanceof ApiError) throw error;
      throw new ApiError('FORK_UNAVAILABLE', 503);
    }
  }

  function pair(direction) {
    if (!['weth-in', 'usdc-in'].includes(direction)) throw new ApiError('INVALID_INPUT');
    return direction === 'weth-in'
      ? { tokenIn: config.aWETH, tokenOut: config.aUSDC, inDecimals: 18, outDecimals: 6 }
      : { tokenIn: config.aUSDC, tokenOut: config.aWETH, inDecimals: 6, outDecimals: 18 };
  }

  async function policyStatus(block, options) {
    if (!config.strategyHash) {
      return {
        state: 'missing', enabled: false, hardFloorStressHF: '0', policyVersion: 0,
        revision: '0', shockBps: 0, marketRegime: 0, modelVersion: 0,
        issuedAt: 0, validUntil: 0, secondsRemaining: 0,
        evidenceBlockFrom: 0, evidenceBlockTo: 0, evidenceHash: null,
      };
    }
    const settings = await c.policy.makerSettings(config.maker, config.strategyHash, options);
    const version = Number(settings.policyVersion);
    const revision = settings.revision.toString();
    if (!settings.enabled || version === 0) {
      return {
        state: version !== 0 || revision !== '0' ? 'disabled' : 'missing', enabled: false,
        hardFloorStressHF: formatUnits(settings.hardFloorStressHF, 18), policyVersion: version,
        revision, shockBps: 0, marketRegime: 0, modelVersion: 0,
        issuedAt: 0, validUntil: 0, secondsRemaining: 0,
        evidenceBlockFrom: 0, evidenceBlockTo: 0, evidenceHash: null,
      };
    }
    if (settings.pairId.toLowerCase() !== config.pairId.toLowerCase()) {
      throw new Error('Maker policy pair does not match the configured strategy pair.');
    }
    const artifact = await c.policy.marketPolicy(config.pairId, version, options);
    const validUntil = Number(artifact.validUntil);
    const remaining = Math.max(0, validUntil - Number(block.timestamp));
    return {
      state: Number(block.timestamp) > validUntil ? 'expired' : remaining <= 900 ? 'expiring' : 'valid',
      enabled: true,
      hardFloorStressHF: formatUnits(settings.hardFloorStressHF, 18),
      policyVersion: version,
      revision,
      shockBps: Number(artifact.shockBps),
      marketRegime: Number(artifact.marketRegime),
      modelVersion: Number(artifact.modelVersion),
      issuedAt: Number(artifact.issuedAt),
      validUntil,
      secondsRemaining: remaining,
      evidenceBlockFrom: Number(artifact.evidenceBlockFrom),
      evidenceBlockTo: Number(artifact.evidenceBlockTo),
      evidenceHash: artifact.evidenceHash,
    };
  }

  async function strategyStatus(options) {
    if (!config.order || !config.strategyHash || !config.strategyBytes) {
      return { state: 'missing', balances: { weth: '0', usdc: '0' }, nextAction: null };
    }
    const [wethRaw, usdcRaw, makerWeth, makerUsdc, wethAllowance, usdcAllowance] = await Promise.all([
      c.aqua.rawBalances(config.maker, config.router, config.strategyHash, config.aWETH, options),
      c.aqua.rawBalances(config.maker, config.router, config.strategyHash, config.aUSDC, options),
      c.aWETH.balanceOf(config.maker, options),
      c.aUSDC.balanceOf(config.maker, options),
      c.aWETH.allowance(config.maker, config.aqua, options),
      c.aUSDC.allowance(config.maker, config.aqua, options),
    ]);
    const wethCount = Number(wethRaw.tokensCount);
    const usdcCount = Number(usdcRaw.tokensCount);
    if (wethCount !== usdcCount || ![0, 2, 255].includes(wethCount)) {
      throw new Error('Aqua strategy token state is inconsistent.');
    }
    const state = wethCount === 2 ? 'active' : wethCount === 255 ? 'docked' : 'unshipped';
    let nextAction = null;
    if (state === 'unshipped' && wethAllowance < makerWeth) {
      nextAction = makerAction('approve-aweth', config.aWETH,
        c.aWETH.interface.encodeFunctionData('approve', [config.aqua, MaxUint256]),
        'Approve Aqua to pull aWETH within shipped strategy balances');
    } else if (state === 'unshipped' && usdcAllowance < makerUsdc) {
      nextAction = makerAction('approve-ausdc', config.aUSDC,
        c.aUSDC.interface.encodeFunctionData('approve', [config.aqua, MaxUint256]),
        'Approve Aqua to pull aUSDC within shipped strategy balances');
    } else if (state === 'unshipped') {
      nextAction = makerAction('ship-strategy', config.aqua,
        c.aqua.interface.encodeFunctionData('ship', [
          config.router, config.strategyBytes, [config.aWETH, config.aUSDC], [makerWeth, makerUsdc],
        ]), 'Ship the immutable XYC strategy to Aqua');
    }
    return {
      state,
      balances: { weth: formatUnits(wethRaw.balance, 18), usdc: formatUnits(usdcRaw.balance, 6) },
      nextAction,
    };
  }

  function makerAction(id, to, data, label) {
    return { id, chainId: '31337', from: config.maker, to, data, value: '0', label };
  }

  async function state() {
    await guard();
    const block = await rpc.send('eth_getBlockByNumber', ['latest', false]);
    const options = { blockTag: block.number };
    const [snapshot, strategy, policy] = await Promise.all([
      c.engine.snapshot(config.maker, options), strategyStatus(options), policyStatus(block, options),
    ]);
    const stress = policy.shockBps > 0
      ? await c.engine.stressHF(Array.from(snapshot), policy.shockBps, options)
      : null;
    return {
      makerAddress: config.maker,
      demoScenarioReceiver: config.scenarioReceiver,
      chain: {
        id: '31337', name: 'Ethereum mainnet fork (local Anvil)', fork: true,
        forkBlock: String(config.forkBlock), timestamp: Number(block.timestamp),
      },
      blockNumber: BigInt(block.number).toString(),
      contracts: {
        aqua: config.aqua, router: config.router, policy: config.policy,
        aWETH: config.aWETH, aUSDC: config.aUSDC,
      },
      pairId: config.pairId,
      strategy: {
        state: strategy.state,
        hash: config.strategyHash,
        priceBounds: config.xycPriceBounds,
        aquaBalances: strategy.balances,
        nextAction: strategy.nextAction,
      },
      collateral: { weth: formatUnits(snapshot.wethAmount, 18), usdc: formatUnits(snapshot.usdcAmount, 6) },
      debt: { usdc: formatUnits(snapshot.usdcDebt, 6) },
      currentHF: hf(snapshot.aaveHF), stressHF: stress === null ? null : hf(stress),
      policy,
      ready: strategy.state === 'active' && ['valid', 'expiring'].includes(policy.state),
    };
  }

  async function createStrategy(body) {
    exactObject(body, ['minPrice', 'maxPrice']);
    const minPrice = decimal(body.minPrice, 6, MAX_PRICE);
    const maxPrice = decimal(body.maxPrice, 6, MAX_PRICE);
    if (minPrice < MIN_PRICE || maxPrice <= minPrice) throw new ApiError('INVALID_INPUT');
    await guard();
    const current = await strategyStatus({});
    if (current.state === 'active' || current.state === 'unshipped') throw new ApiError('STRATEGY_EXISTS', 409);
    const nonce = Number(config.strategyNonce ?? 0) + 1;
    const salt = keccak256(toUtf8Bytes([
      'MarginMM local demo strategy', config.instanceId, config.maker,
      minPrice.toString(), maxPrice.toString(), String(nonce),
    ].join(':')));
    const sqrtPriceMin = integerSquareRoot(minPrice * 10n ** 18n);
    const sqrtPriceMax = integerSquareRoot(maxPrice * 10n ** 18n);
    const built = await c.router.buildOrder(config.maker, sqrtPriceMin, sqrtPriceMax, salt);
    const order = plainOrder(built);
    const strategyBytes = AbiCoder.defaultAbiCoder().encode(
      ['tuple(address maker,uint256 traits,bytes data)'], [order],
    );
    const strategyHash = await c.router.hash(order);
    if (strategyHash !== keccak256(strategyBytes)) throw new Error('Aqua strategy encoding mismatch.');
    Object.assign(config, {
      order, strategyBytes, strategyHash, strategyNonce: nonce,
      xycPriceBounds: { minUsdcPerWeth: body.minPrice, maxUsdcPerWeth: body.maxPrice },
    });
    quotes.clear();
    await saveConfig(config);
    return state();
  }

  async function runAgent(body) {
    exactObject(body, ['requestId', 'hardFloor', 'forceRefresh']);
    if (typeof body.requestId !== 'string' || !REQUEST_ID_PATTERN.test(body.requestId)) {
      throw new ApiError('INVALID_INPUT');
    }
    if (typeof body.forceRefresh !== 'boolean') throw new ApiError('INVALID_INPUT');
    const floor = decimal(body.hardFloor, 18, 3n * 10n ** 18n);
    if (floor < 101n * 10n ** 16n) throw new ApiError('INVALID_INPUT');
    await guard();
    if (!config.strategyHash || (await strategyStatus({})).state !== 'active') {
      throw new ApiError('STRATEGY_NOT_READY', 409);
    }
    const [{ runRiskAgent, RiskAgentWorkflowError }, graphModule] = await Promise.all([
      dependencies.agentModule ? Promise.resolve(dependencies.agentModule) : import('../services/dist/src/agent.js'),
      dependencies.graphModule ? Promise.resolve(dependencies.graphModule) : import('../services/dist/src/graph.js'),
    ]);
    const graphApiKey = requiredEnv('GRAPH_API_KEY');
    const requestHash = agentRequestHash({
      hardFloor: floor.toString(), forceRefresh: body.forceRefresh,
      strategy: config.strategyHash, instanceId: config.instanceId,
    });
    const existing = agentRuns.get(body.requestId);
    if (existing) {
      if (existing.requestHash !== requestHash) throw new ApiError('AGENT_REQUEST_CONFLICT', 409);
      if (existing.state === 'pending') throw new ApiError('AGENT_OUTCOME_UNCERTAIN', 409);
      return existing.response;
    }
    if (agentRuns.size >= 64) throw new ApiError('BUSY', 429);
    // Validate every local prerequisite before journaling an uncertain paid
    // workflow. Missing configuration cannot have initiated x402 settlement.
    const agentConfig = {
      ethereumRpcUrl: process.env.DEMO_RPC_URL ?? 'http://127.0.0.1:8545',
      policyRegistry: config.policy,
      maker: config.maker,
      strategy: config.strategyHash,
      pairId: config.pairId,
      makerHardFloorStressHF: floor.toString(),
      calibrationSignerAddress: config.calibrationSigner,
      calibrationServiceUrl: process.env.CALIBRATION_SERVICE_URL ?? 'http://127.0.0.1:4021/calibrate',
      agentAccountId: requiredEnv('HEDERA_AGENT_ACCOUNT_ID'),
      agentPrivateKey: requiredEnv('HEDERA_AGENT_PRIVATE_KEY'),
      serviceAccountId: requiredEnv('HEDERA_PAYTO_ACCOUNT_ID'),
      priceTinybar: requiredEnv('X402_PRICE_TINYBAR'),
      graph: {
        market: { apiKey: graphApiKey, subgraphId: process.env.UNISWAP_SUBGRAPH_ID ?? graphModule.UNISWAP_V3_ETHEREUM_SUBGRAPH_ID },
        aave: { apiKey: graphApiKey, subgraphId: process.env.AAVE_SUBGRAPH_ID ?? graphModule.AAVE_V3_ETHEREUM_SUBGRAPH_ID },
        lookbackSeconds: 7 * 24 * 60 * 60,
        timeoutMs: 15_000,
      },
      refreshLeadSeconds: integerEnv('POLICY_REFRESH_LEAD_SECONDS', 0, 21_600),
      policyValiditySeconds: integerEnv('POLICY_VALIDITY_SECONDS', 1, 21_600),
      forceRefresh: body.forceRefresh,
      modelApiKey: requiredEnv('GROQ_API_KEY'),
      modelBaseUrl: process.env.GROQ_BASE_URL ?? 'https://api.groq.com/openai/v1',
      model: requiredEnv('GROQ_MODEL'),
    };
    agentRuns.set(body.requestId, { requestHash, state: 'pending' });
    await persistAgentRuns(agentRuns);
    let proposal;
    try {
      proposal = await runRiskAgent(agentConfig, dependencies.agentDependencies ?? {});
    } catch (error) {
      if (RiskAgentWorkflowError && error instanceof RiskAgentWorkflowError) {
        if (!error.paymentMayHaveBeenAttempted) {
          await releaseAgentRunBeforePayment(agentRuns, body.requestId, requestHash);
          throw new ApiError('AGENT_UNAVAILABLE', 503);
        }
        throw new ApiError('AGENT_OUTCOME_UNCERTAIN', 409);
      }
      throw error;
    }
    let response;
    if (proposal.decision !== 'proposal_ready' || !proposal.calibration) {
      response = {
        decision: 'no_refresh', headline: proposal.headline,
        rationale: proposal.rationale, policyStatus: proposal.policyStatus,
      };
    } else {
      const signed = proposal.calibration.signedCalibration;
      const approval = makerAction('approve-market-policy', config.policy,
        c.policy.interface.encodeFunctionData('approveMarketPolicy', [
          config.strategyHash, floor, signed.artifact, signed.signature,
        ]), 'Approve the signed MarketPolicy and Maker StressHF floor');
      response = {
        decision: 'proposal_ready', headline: proposal.headline, rationale: proposal.rationale,
        policyStatus: proposal.policyStatus,
        graphEvidence: proposal.graphEvidence,
        paymentReceipt: proposal.paymentReceipt,
        calibration: {
          shockBps: signed.artifact.shockBps,
          marketRegime: signed.artifact.marketRegime,
          policyVersion: signed.artifact.policyVersion,
          modelVersion: signed.artifact.modelVersion,
          issuedAt: signed.artifact.issuedAt,
          validUntil: signed.artifact.validUntil,
          evidenceBlockFrom: signed.artifact.evidenceBlockFrom,
          evidenceBlockTo: signed.artifact.evidenceBlockTo,
          evidenceHash: signed.artifact.evidenceHash,
          signer: signed.signer,
        },
        approval,
      };
    }
    agentRuns.set(body.requestId, { requestHash, state: 'complete', response });
    await persistAgentRuns(agentRuns);
    return response;
  }

  async function policyAction(body) {
    exactObject(body, ['hardFloor']);
    const floor = decimal(body.hardFloor, 18, 3n * 10n ** 18n);
    if (floor < 101n * 10n ** 16n || !config.strategyHash) throw new ApiError('INVALID_INPUT');
    await guard();
    const block = await rpc.send('eth_getBlockByNumber', ['latest', false]);
    const active = await policyStatus(block, {});
    if (!['valid', 'expiring'].includes(active.state)) throw new ApiError('POLICY_REJECTED', 409);
    return makerAction('update-maker-floor', config.policy,
      c.policy.interface.encodeFunctionData('setMakerSettings', [
        config.strategyHash, config.pairId, floor, active.policyVersion,
      ]), 'Update the Maker StressHF floor without changing the signed market shock');
  }

  async function quote(body) {
    exactObject(body, ['direction', 'maxAmountIn', 'minAmountOut']);
    const p = pair(body.direction);
    const requested = decimal(body.maxAmountIn, p.inDecimals, MAX_INPUT * 10n ** BigInt(p.inDecimals));
    const minimumOut = decimal(body.minAmountOut, p.outDecimals, MAX_INPUT * 10n ** BigInt(p.outDecimals));
    await guard();
    if (!config.order || !config.strategyHash) throw new ApiError('STRATEGY_NOT_READY', 409);
    const now = Date.now();
    for (const [id, saved] of quotes) if (saved.expires <= now) quotes.delete(id);
    if (quotes.size >= 256) throw new ApiError('BUSY', 429);
    const block = await rpc.send('eth_getBlockByNumber', ['latest', false]);
    const options = { blockTag: block.number };
    const order = config.order;
    let capacity;
    try { capacity = await c.router.capacity(order, p.tokenIn, p.tokenOut, requested, options); }
    catch (error) { throw contractFailure(error); }
    const expires = now + DEMO_DEADLINE_SECONDS * 1_000;
    const result = {
      quoteId: randomUUID(), status: 'rejected', direction: body.direction,
      requestedAmountIn: formatUnits(requested, p.inDecimals),
      actualAmountIn: formatUnits(capacity.actualAmountIn, p.inDecimals),
      baseAmountOut: formatUnits(capacity.baseAmountOut, p.outDecimals),
      finalAmountOut: formatUnits(capacity.finalAmountOut, p.outDecimals),
      qMax: formatUnits(capacity.qMax, p.outDecimals),
      partialFill: Boolean(capacity.partialFill),
      riskClass: Number(capacity.riskClass),
      stressHFBefore: hf(capacity.stressBefore), stressHFAfter: hf(capacity.stressAfter),
      hardFloorStressHF: formatUnits(capacity.riskFloor, 18),
      shockBps: Number(capacity.shockBps), policyVersion: Number(capacity.policyVersion),
      policyRevision: capacity.policyRevision.toString(), policyValidUntil: Number(capacity.validUntil),
      expiresAt: new Date(expires).toISOString(), reason: null,
    };
    if (capacity.finalAmountOut === 0n || capacity.actualAmountIn === 0n) {
      result.reason = 'No capacity under the active stress policy.';
      return result;
    }
    if (capacity.finalAmountOut < minimumOut) {
      result.reason = 'The risk-capped output is below the taker minimum.';
      return result;
    }
    const deadline = BigInt(block.timestamp) + BigInt(DEMO_DEADLINE_SECONDS);
    const data = await c.router.buildTakerData(
      minimumOut, deadline, capacity.policyVersion, capacity.policyRevision, options,
    );
    let quoted;
    try {
      quoted = await c.router.quote.staticCall(order, p.tokenIn, p.tokenOut, requested, data, options);
    } catch (error) { throw contractFailure(error); }
    if (quoted.amountIn !== capacity.actualAmountIn || quoted.amountOut !== capacity.finalAmountOut
      || quoted.orderHash !== config.strategyHash) throw new ApiError('STALE_QUOTE', 409);
    result.status = 'ready';
    quotes.set(result.quoteId, { result, p, requested, data, expires, used: false });
    return result;
  }

  async function fill(body) {
    exactObject(body, ['quoteId']);
    if (typeof body.quoteId !== 'string' || !/^[0-9a-f-]{36}$/.test(body.quoteId)) throw new ApiError('INVALID_INPUT');
    const saved = quotes.get(body.quoteId);
    if (!saved) throw new ApiError('QUOTE_EXPIRED', 409);
    if (saved.used) throw new ApiError('QUOTE_USED', 409);
    saved.used = true;
    if (Date.now() >= saved.expires) throw new ApiError('QUOTE_EXPIRED', 409);
    await guard();
    const args = [config.order, saved.p.tokenIn, saved.p.tokenOut, saved.requested, saved.data];
    let gas;
    try {
      await c.router.swap.staticCall(...args);
      gas = await c.router.swap.estimateGas(...args);
    } catch (error) { throw contractFailure(error); }
    const mined = await transaction(`fill:${body.quoteId}`,
      () => c.router.swap(...args, { gasLimit: gas * 12n / 10n }));
    const parsed = mined.logs
      .filter(log => log.address.toLowerCase() === config.router.toLowerCase())
      .map(log => { try { return c.router.interface.parseLog(log); } catch { return null; } });
    const risk = parsed.find(log => log?.name === 'MarginRiskEvaluated');
    const swapped = parsed.find(log => log?.name === 'Swapped');
    if (!risk || !swapped || risk.args.orderHash !== config.strategyHash || swapped.args.orderHash !== config.strategyHash) {
      halted = true;
      throw new ApiError('FORK_UNAVAILABLE', 503);
    }
    return {
      quoteId: body.quoteId, status: 'filled', direction: saved.result.direction,
      requestedAmountIn: formatUnits(risk.args.requestedAmountIn, saved.p.inDecimals),
      actualAmountIn: formatUnits(risk.args.actualAmountIn, saved.p.inDecimals),
      baseAmountOut: formatUnits(risk.args.baseAmountOut, saved.p.outDecimals),
      finalAmountOut: formatUnits(risk.args.finalAmountOut, saved.p.outDecimals),
      qMax: formatUnits(risk.args.maxSafeAmountOut, saved.p.outDecimals),
      stressHFBefore: hf(risk.args.stressHFBefore), stressHFAfter: hf(risk.args.stressHFAfter),
      shockBps: Number(risk.args.shockBps), policyVersion: Number(risk.args.policyVersion),
      riskClass: Number(risk.args.riskClass), transactionHash: mined.hash, chainId: '31337',
    };
  }

  async function scenario(body) {
    exactObject(body, ['action']);
    if (!['withdraw-usdc', 'restore'].includes(body.action)) throw new ApiError('INVALID_INPUT');
    await guard();
    if (body.action === 'withdraw-usdc') {
      const receiverBalance = await c.aUSDC.balanceOf(config.scenarioReceiver);
      if (receiverBalance > BigInt(config.receiverBaseline)) return { alreadyApplied: true, action: null };
      return {
        alreadyApplied: false,
        action: makerAction('withdraw-usdc-scenario', config.aUSDC,
          c.aUSDC.interface.encodeFunctionData('transfer', [config.scenarioReceiver, 5_000n * 10n ** 6n]),
          'Demo only: transfer 5,000 aUSDC collateral from the Maker'),
      };
    }
    quotes.clear();
    await writeFile(`${RUNTIME}pending.json`, JSON.stringify({ kind: 'restore' }),
      { flag: 'wx', mode: 0o600, flush: true });
    halted = true;
    if (!await rpc.send('evm_revert', [config.snapshotId])) throw new ApiError('FORK_UNAVAILABLE', 503);
    config.snapshotId = await rpc.send('evm_snapshot', []);
    await saveConfig(config);
    await unlink(`${RUNTIME}pending.json`);
    halted = false;
    return state();
  }

  async function checkpoint(body) {
    exactObject(body, []);
    const current = await state();
    if (!current.ready) throw new ApiError('STRATEGY_NOT_READY', 409);
    config.snapshotId = await rpc.send('evm_snapshot', []);
    config.receiverBaseline = (await c.aUSDC.balanceOf(config.scenarioReceiver)).toString();
    await saveConfig(config);
    return { snapshotId: config.snapshotId };
  }

  return { state, createStrategy, runAgent, policyAction, quote, fill, scenario, checkpoint };
}

export function agentRequestHash({ hardFloor, forceRefresh, strategy, instanceId }) {
  return keccak256(toUtf8Bytes(JSON.stringify({ hardFloor, forceRefresh, strategy, instanceId })));
}

export async function persistAgentRuns(agentRuns, path = AGENT_REQUESTS_PATH) {
  await writeFile(`${path}.tmp`, JSON.stringify(Object.fromEntries(agentRuns), null, 2), { mode: 0o600 });
  await rename(`${path}.tmp`, path);
}

/**
 * A known pre-payment failure is safe to retry. Unknown/post-payment outcomes
 * intentionally retain their pending journal entry and remain fail-closed.
 */
export async function releaseAgentRunBeforePayment(agentRuns, requestId, requestHash, path = AGENT_REQUESTS_PATH) {
  const entry = agentRuns.get(requestId);
  if (!entry || entry.state !== 'pending' || entry.requestHash !== requestHash) {
    throw new Error('Cannot release a non-pending Agent request.');
  }
  agentRuns.delete(requestId);
  try {
    await persistAgentRuns(agentRuns, path);
  } catch (error) {
    agentRuns.set(requestId, entry);
    throw error;
  }
}

export async function loadAgentRuns(path = AGENT_REQUESTS_PATH) {
  let parsed;
  try { parsed = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return new Map();
    throw new Error('Agent request journal is unreadable.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).length > 64) {
    throw new Error('Agent request journal is invalid.');
  }
  const entries = Object.entries(parsed);
  for (const [requestId, entry] of entries) {
    const keys = entry && typeof entry === 'object' && !Array.isArray(entry) ? Object.keys(entry) : [];
    if (!REQUEST_ID_PATTERN.test(requestId) || !entry || typeof entry !== 'object' || Array.isArray(entry)
      || !/^0x[0-9a-f]{64}$/i.test(entry.requestHash)
      || !['pending', 'complete'].includes(entry.state)
      || (entry.state === 'pending' && (keys.length !== 2 || Object.hasOwn(entry, 'response')))
      || (entry.state === 'complete' && (keys.length !== 3 || !entry.response || typeof entry.response !== 'object'))) {
      throw new Error('Agent request journal is invalid.');
    }
  }
  return new Map(entries);
}
