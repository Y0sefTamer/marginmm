import http from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ApiError, checkRequest, readBody, SerialQueue } from './guards.mjs';
import { provider, ROOT, RUNTIME } from './chain.mjs';
import { createService } from './service.mjs';

const HEADERS = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};
function json(res, status, value) {
  res.writeHead(status, { ...HEADERS, 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}
export function createServer(service, { port = 3001, staticRoot = `${ROOT}frontend/dist` } = {}) {
  const queue = new SerialQueue();
  const server = http.createServer({ maxHeaderSize: 8192 }, async (req, res) => {
    try {
      checkRequest(req, port);
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      if (url.search || req.url.length > 1024) throw new ApiError('INVALID_INPUT');
      if (url.pathname.startsWith('/api/')) {
        const route = url.pathname.slice(5);
        if (req.method === 'GET' && route === 'state') {
          return json(res, 200, await queue.run(() => service.state()));
        }
        const postRoutes = {
          strategy: 'createStrategy', agent: 'runAgent', 'policy-action': 'policyAction',
          quote: 'quote', fill: 'fill', scenario: 'scenario', checkpoint: 'checkpoint',
        };
        if (req.method === 'POST' && Object.hasOwn(postRoutes, route)) {
          const body = await readBody(req);
          return json(res, 200, await queue.run(() => service[postRoutes[route]](body)));
        }
        throw new ApiError('NOT_FOUND', 404);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new ApiError('NOT_FOUND', 404);
      let pathname;
      try { pathname = decodeURIComponent(url.pathname); } catch { throw new ApiError('NOT_FOUND', 404); }
      if (pathname.includes('\\') || pathname.split('/').some(part => part.startsWith('.'))) throw new ApiError('NOT_FOUND', 404);
      const root = await realpath(staticRoot).catch(() => null);
      if (!root) throw new ApiError('FRONTEND_NOT_BUILT', 503);
      const candidate = path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
      const actual = await realpath(candidate).catch(() => null);
      if (!actual || !actual.startsWith(`${root}${path.sep}`) || !(await stat(actual)).isFile()) throw new ApiError('NOT_FOUND', 404);
      const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
      const type = types[path.extname(actual)];
      if (!type) throw new ApiError('NOT_FOUND', 404);
      res.writeHead(200, { ...HEADERS, 'Content-Type': type });
      res.end(req.method === 'HEAD' ? undefined : await readFile(actual));
    } catch (error) {
      if (res.headersSent || res.destroyed) return;
      const known = error instanceof ApiError;
      if (!known) console.error('Local API failure:', error instanceof Error ? error.message : 'unknown error');
      json(res, known ? error.status : 503, { error: { code: known ? error.code : 'FORK_UNAVAILABLE' } });
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 3_000;
  server.maxRequestsPerSocket = 100;
  return server;
}
export async function startServer() {
  const rpc = provider();
  try {
    const port = Number(process.env.DEMO_PORT ?? '3001');
    if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid DEMO_PORT.');
    const config = JSON.parse(await readFile(`${RUNTIME}deployment.json`, 'utf8'));
    const service = await createService(rpc, config);
    const server = createServer(service, { port });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
    console.log(`MarginMM local demo: http://127.0.0.1:${port} (chain 31337)`);
    return { server, rpc };
  } catch (error) { rpc.destroy(); throw error; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer().then(({ server, rpc }) => {
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => { rpc.destroy(); process.exit(0); }));
  }).catch(() => { console.error('Local backend startup failed. Verify fresh fork, bootstrap and no uncertain pending mutation.'); process.exitCode = 1; });
}
