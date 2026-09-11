import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import { ApiError, SerialQueue, checkRequest, decimal, exactObject, localRpcUrl, readBody } from '../guards.mjs';
import { agentRequestHash, loadAgentRuns, persistAgentRuns, releaseAgentRunBeforePayment } from '../service.mjs';

const execFileAsync = promisify(execFile);

test('decimal accepts canonical fixed-point strings without floating point', () => {
  assert.equal(decimal('1.000001', 6, 2_000_000n), 1_000_001n);
  for (const value of [1, '01', '+1', '-1', '1e2', '.1', '1.', '1.0000001', '']) {
    assert.throws(() => decimal(value, 6, 2_000_000n), ApiError);
  }
  assert.throws(() => decimal('0', 6, 2_000_000n), ApiError);
  assert.equal(decimal('0', 18, 3n * 10n ** 18n, true), 0n);
});

test('exactObject rejects missing, extra and inherited fields', () => {
  const keys = ['direction', 'maxAmountIn', 'minAmountOut'];
  const valid = { direction: 'weth-in', maxAmountIn: '1', minAmountOut: '1' };
  assert.doesNotThrow(() => exactObject(valid, keys));
  assert.throws(() => exactObject({ direction: 'weth-in' }, keys), ApiError);
  assert.throws(() => exactObject({ ...valid, extra: true }, keys), ApiError);
  assert.throws(() => exactObject(Object.create(valid), keys), ApiError);
});

test('RPC URL is restricted to credential-free loopback HTTP', () => {
  assert.equal(localRpcUrl('http://127.0.0.1:8545'), 'http://127.0.0.1:8545/');
  assert.equal(localRpcUrl('http://localhost:8545'), 'http://localhost:8545/');
  for (const value of ['https://localhost:8545', 'http://0.0.0.0:8545', 'http://user:pass@localhost:8545', 'http://localhost:8545/path']) {
    assert.throws(() => localRpcUrl(value));
  }
});

test('isolated runtime path never shares the interactive demo runtime directory', async () => {
  const runtimeDirectory = join(tmpdir(), 'marginmm-isolated-runtime-check');
  const demoDirectory = fileURLToPath(new URL('../', import.meta.url));
  const { stdout } = await execFileAsync(process.execPath, [
    '--input-type=module', '--eval', 'console.log((await import("./chain.mjs")).RUNTIME)',
  ], {
    cwd: demoDirectory,
    env: { ...process.env, DEMO_RUNTIME_DIR: runtimeDirectory },
  });
  assert.equal(stdout.trim(), `${resolve(runtimeDirectory)}${sep}`);
});

test('POST requests require exact same origin and JSON content type', () => {
  const valid = { method: 'POST', headers: { host: '127.0.0.1:3001', origin: 'http://127.0.0.1:3001', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' } };
  assert.doesNotThrow(() => checkRequest(valid));
  assert.throws(() => checkRequest({ ...valid, headers: { ...valid.headers, origin: 'http://evil.test' } }), ApiError);
  assert.throws(() => checkRequest({ ...valid, headers: { ...valid.headers, host: 'evil.test' } }), ApiError);
  assert.throws(() => checkRequest({ ...valid, headers: { ...valid.headers, 'content-type': 'text/plain' } }), ApiError);
});

test('body parser rejects malformed and oversized JSON', async () => {
  const request = Readable.from([Buffer.from('{"ok":true}')]);
  request.headers = { 'content-length': '11' };
  assert.deepEqual(await readBody(request), { ok: true });

  const malformed = Readable.from([Buffer.from('{')]);
  malformed.headers = {};
  await assert.rejects(() => readBody(malformed), ApiError);

  const oversized = Readable.from([Buffer.alloc(2049)]);
  oversized.headers = {};
  await assert.rejects(() => readBody(oversized), ApiError);
});

test('serial queue prevents races and keeps processing after rejection', async () => {
  const queue = new SerialQueue();
  const order = [];
  const first = queue.run(async () => { order.push('first:start'); await new Promise(resolve => setTimeout(resolve, 5)); order.push('first:end'); });
  const second = queue.run(async () => { order.push('second'); throw new Error('expected'); });
  const third = queue.run(async () => { order.push('third'); return 3; });
  await first;
  await assert.rejects(second, /expected/);
  assert.equal(await third, 3);
  assert.deepEqual(order, ['first:start', 'first:end', 'second', 'third']);
});

test('Agent request journal survives restart and rejects malformed replay state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'marginmm-agent-journal-'));
  const path = join(directory, 'requests.json');
  try {
    const requestId = '123e4567-e89b-42d3-a456-426614174000';
    const requestHash = agentRequestHash({
      hardFloor: '1100000000000000000', forceRefresh: false,
      strategy: `0x${'11'.repeat(32)}`, instanceId: `0x${'22'.repeat(32)}`,
    });
    const runs = new Map([[requestId, { requestHash, state: 'pending' }]]);
    await persistAgentRuns(runs, path);
    assert.deepEqual(Object.fromEntries(await loadAgentRuns(path)), Object.fromEntries(runs));

    runs.set(requestId, { requestHash, state: 'complete', response: { decision: 'no_refresh' } });
    await persistAgentRuns(runs, path);
    assert.deepEqual(Object.fromEntries(await loadAgentRuns(path)), Object.fromEntries(runs));

    await writeFile(path, JSON.stringify({ 'not-a-uuid--------------------------': {
      requestHash, state: 'pending', response: {},
    } }));
    await assert.rejects(loadAgentRuns(path), /journal is invalid/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('only a known pre-payment Agent failure releases its pending journal entry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'marginmm-agent-release-'));
  const path = join(directory, 'requests.json');
  const requestId = '987e6543-e21b-42d3-a456-426614174000';
  const requestHash = agentRequestHash({
    hardFloor: '1100000000000000000', forceRefresh: true,
    strategy: `0x${'33'.repeat(32)}`, instanceId: `0x${'44'.repeat(32)}`,
  });
  const runs = new Map([[requestId, { requestHash, state: 'pending' }]]);
  try {
    await persistAgentRuns(runs, path);
    await assert.rejects(
      releaseAgentRunBeforePayment(runs, requestId, `0x${'00'.repeat(32)}`, path),
      /Cannot release/,
    );
    assert.equal(runs.get(requestId)?.state, 'pending');

    await releaseAgentRunBeforePayment(runs, requestId, requestHash, path);
    assert.equal(runs.size, 0);
    assert.equal((await loadAgentRuns(path)).size, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
