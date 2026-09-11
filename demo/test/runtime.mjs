import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Contract, JsonRpcProvider, keccak256, parseUnits, toUtf8Bytes, Wallet } from 'ethers';
import { signCalibrationArtifact } from '../../services/dist/src/policy-artifact.js';
import { artifact, RUNTIME } from '../chain.mjs';

const BASE = process.env.DEMO_BASE_URL ?? 'http://127.0.0.1:3001';
const RPC = process.env.DEMO_RPC_URL ?? 'http://127.0.0.1:8545';
const calibrationPrivateKey = process.env.TEST_CALIBRATION_SIGNER_PRIVATE_KEY;
if (!calibrationPrivateKey) throw new Error('TEST_CALIBRATION_SIGNER_PRIVATE_KEY is required.');

async function request(path, body, expected = 200) {
  const response = await fetch(`${BASE}/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : {
      'Content-Type': 'application/json', Origin: BASE, 'Sec-Fetch-Site': 'same-origin',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  assert.equal(response.status, expected, `${path}: ${JSON.stringify(data)}`);
  return data;
}

function hf(value) {
  assert.equal(typeof value, 'string');
  return parseUnits(value, 18);
}

const rpc = new JsonRpcProvider(RPC, undefined, { cacheTimeout: -1, batchMaxCount: 1 });
const config = JSON.parse(await readFile(`${RUNTIME}deployment.json`, 'utf8'));
const maker = await rpc.getSigner(config.maker);
const policyArtifact = await artifact('MarginMMPolicy');
const policy = new Contract(config.policy, policyArtifact.abi, maker);

async function makerAction(action) {
  assert.equal(action.chainId, '31337');
  assert.equal(action.from.toLowerCase(), config.maker.toLowerCase());
  assert.equal(action.value, '0');
  const tx = await maker.sendTransaction({ to: action.to, data: action.data, value: 0n });
  const receipt = await tx.wait(1, 60_000);
  assert.equal(receipt?.status, 1);
  return receipt.hash;
}

try {
  let state = await request('state');
  assert.equal(state.chain.id, '31337');
  assert.equal(state.chain.fork, true);
  assert.equal(typeof state.chain.timestamp, 'number');
  assert.equal(state.strategy.state, 'missing');
  assert.equal(state.policy.state, 'missing');
  assert.equal(state.policy.marketRegime, 0);
  assert.equal(state.policy.modelVersion, 0);
  assert.equal(state.policy.evidenceBlockFrom, 0);
  assert.equal(state.policy.evidenceBlockTo, 0);
  assert.equal(state.ready, false);

  state = await request('strategy', { minPrice: '1500', maxPrice: '6000' });
  assert.equal(state.strategy.state, 'unshipped');
  assert.deepEqual(state.strategy.priceBounds, { minUsdcPerWeth: '1500', maxUsdcPerWeth: '6000' });

  const setupActionIds = [];
  while (state.strategy.nextAction) {
    setupActionIds.push(state.strategy.nextAction.id);
    await makerAction(state.strategy.nextAction);
    state = await request('state');
  }
  assert.deepEqual(setupActionIds, ['approve-aweth', 'approve-ausdc', 'ship-strategy']);
  assert.equal(state.strategy.state, 'active');
  assert.match(state.strategy.hash, /^0x[0-9a-f]{64}$/i);
  assert.equal(state.policy.state, 'missing');

  const block = await rpc.getBlock('latest');
  assert.ok(block);
  const artifactValue = {
    chainId: 31337n,
    policyRegistry: config.policy,
    pairId: config.pairId,
    shockBps: 1_240,
    marketRegime: 1,
    policyVersion: 1,
    modelVersion: 1,
    issuedAt: block.timestamp,
    validUntil: block.timestamp + 21_600,
    evidenceBlockFrom: block.number,
    evidenceBlockTo: block.number,
    evidenceHash: keccak256(toUtf8Bytes('runtime-test-evidence-only')),
  };
  const calibrationWallet = new Wallet(calibrationPrivateKey);
  assert.equal(calibrationWallet.address.toLowerCase(), config.calibrationSigner.toLowerCase());
  const signed = await signCalibrationArtifact(
    artifactValue, calibrationPrivateKey, config.calibrationSigner, block.timestamp,
  );
  const approve = await policy.approveMarketPolicy(
    state.strategy.hash, parseUnits('1.23', 18), artifactValue, signed.signature,
  );
  assert.equal((await approve.wait(1, 60_000))?.status, 1);

  state = await request('state');
  assert.equal(state.policy.state, 'valid');
  assert.equal(state.policy.shockBps, 1240);
  assert.equal(state.policy.marketRegime, artifactValue.marketRegime);
  assert.equal(state.policy.modelVersion, artifactValue.modelVersion);
  assert.equal(state.policy.evidenceBlockFrom, artifactValue.evidenceBlockFrom);
  assert.equal(state.policy.evidenceBlockTo, artifactValue.evidenceBlockTo);
  assert.equal(state.policy.hardFloorStressHF, '1.23');
  assert.equal(state.ready, true);
  assert.ok(hf(state.currentHF) > parseUnits('1', 18));
  assert.ok(hf(state.stressHF) >= hf(state.policy.hardFloorStressHF));
  await request('checkpoint', {});

  const partial = await request('quote', {
    direction: 'weth-in', maxAmountIn: '20', minAmountOut: '1',
  });
  assert.equal(partial.status, 'ready');
  assert.equal(partial.partialFill, true);
  assert.equal(partial.riskClass, 1);
  assert.ok(parseUnits(partial.actualAmountIn, 18) < parseUnits(partial.requestedAmountIn, 18));
  assert.ok(parseUnits(partial.finalAmountOut, 6) < parseUnits(partial.baseAmountOut, 6));
  assert.equal(partial.finalAmountOut, partial.qMax);
  assert.ok(hf(partial.stressHFAfter) >= hf(partial.hardFloorStressHF));

  const fill = await request('fill', { quoteId: partial.quoteId });
  assert.equal(fill.status, 'filled');
  assert.ok(parseUnits(fill.actualAmountIn, 18) > 0n);
  assert.ok(parseUnits(fill.actualAmountIn, 18) <= parseUnits(partial.requestedAmountIn, 18));
  assert.ok(parseUnits(fill.finalAmountOut, 6) >= parseUnits('1', 6));
  assert.equal(fill.finalAmountOut, fill.qMax);
  assert.ok(hf(fill.stressHFAfter) >= hf(partial.hardFloorStressHF));
  assert.equal(fill.policyVersion, partial.policyVersion);
  assert.match(fill.transactionHash, /^0x[0-9a-f]{64}$/i);
  const duplicate = await request('fill', { quoteId: partial.quoteId }, 409);
  assert.equal(duplicate.error.code, 'QUOTE_USED');
  state = await request('state');
  assert.ok(hf(state.currentHF) > parseUnits('1', 18));
  assert.ok(hf(state.stressHF) >= hf(state.policy.hardFloorStressHF));

  state = await request('scenario', { action: 'restore' });
  assert.equal(state.ready, true);
  const reverse = await request('quote', {
    direction: 'usdc-in', maxAmountIn: '1000', minAmountOut: '0.000001',
  });
  assert.equal(reverse.status, 'ready');
  const reverseFill = await request('fill', { quoteId: reverse.quoteId });
  assert.equal(reverseFill.status, 'filled');

  state = await request('scenario', { action: 'restore' });
  const staleQuote = await request('quote', {
    direction: 'weth-in', maxAmountIn: '0.01', minAmountOut: '1',
  });
  const floorAction = await request('policy-action', { hardFloor: '1.20' });
  await makerAction(floorAction);
  const stale = await request('fill', { quoteId: staleQuote.quoteId }, 409);
  assert.equal(stale.error.code, 'STALE_QUOTE');

  state = await request('scenario', { action: 'restore' });
  const scenario = await request('scenario', { action: 'withdraw-usdc' });
  assert.equal(scenario.alreadyApplied, false);
  await makerAction(scenario.action);
  const stressed = await request('state');
  assert.ok(hf(stressed.currentHF) > parseUnits('1', 18));
  assert.ok(hf(stressed.stressHF) < hf(stressed.policy.hardFloorStressHF));
  const rejected = await request('quote', {
    direction: 'weth-in', maxAmountIn: '1', minAmountOut: '1',
  });
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.finalAmountOut, '0.0');

  state = await request('scenario', { action: 'restore' });
  await rpc.send('evm_setNextBlockTimestamp', [state.policy.validUntil + 1]);
  await rpc.send('evm_mine', []);
  const expired = await request('state');
  assert.equal(expired.policy.state, 'expired');
  assert.equal(expired.ready, false);
  const expiredQuote = await request('quote', {
    direction: 'weth-in', maxAmountIn: '0.01', minAmountOut: '1',
  }, 409);
  assert.equal(expiredQuote.error.code, 'POLICY_REJECTED');

  console.log('Runtime MVP passed: browser-equivalent Maker setup, Exact-In full/reverse and qMax partial fills, replay/stale/expiry/drift fail-closed checks.');
} finally {
  rpc.destroy();
}
