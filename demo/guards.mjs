import { parseUnits } from 'ethers';

export class ApiError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
export function exactObject(body, keys) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== keys.length || keys.some(key => !Object.hasOwn(body, key))) {
    throw new ApiError('INVALID_INPUT');
  }
}
export function decimal(value, decimals, maximum, allowZero = false) {
  if (typeof value !== 'string' || value.length > 64
    || !/^(0|[1-9]\d*)(\.\d+)?$/.test(value)
    || (value.split('.')[1]?.length ?? 0) > decimals) throw new ApiError('INVALID_INPUT');
  const parsed = parseUnits(value, decimals);
  if (parsed > maximum || parsed < 0n || (!allowZero && parsed === 0n)) throw new ApiError('INVALID_INPUT');
  return parsed;
}
export function localRpcUrl(raw) {
  const url = new URL(raw);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('RPC must be an HTTP loopback URL without credentials or a path.');
  }
  return url.href;
}
export function checkRequest(req, port = 3001) {
  const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`, '127.0.0.1:5173', 'localhost:5173']);
  const host = req.headers.host;
  if (!allowed.has(host)) throw new ApiError('INVALID_HOST', 403);
  if (req.method === 'POST') {
    if (req.headers.origin !== `http://${host}`
      || (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin')) {
      throw new ApiError('INVALID_ORIGIN', 403);
    }
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) {
      throw new ApiError('INVALID_INPUT', 415);
    }
  }
}
export async function readBody(req) {
  if (Number(req.headers['content-length'] ?? 0) > 2048) throw new ApiError('INVALID_INPUT', 413);
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2048) throw new ApiError('INVALID_INPUT', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ApiError('INVALID_INPUT'); }
}
// Every quote, read and mutation shares this queue so snapshots cannot race local writes.
export class SerialQueue {
  tail = Promise.resolve();
  pending = 0;
  run(work) {
    if (this.pending >= 32) return Promise.reject(new ApiError('BUSY', 429));
    this.pending++;
    const result = this.tail.then(work);
    this.tail = result.catch(() => {}).finally(() => { this.pending--; });
    return result;
  }
}
