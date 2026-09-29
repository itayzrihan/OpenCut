// Platform transport adapter. Account authorization remains in the app.
import { createServer, request as httpRequest } from 'node:http';
import { pathToFileURL } from 'node:url';

const apiPaths = new Set([
  '/api/health', '/api/accounts', '/api/accounts/storage',
  '/api/accounts/migration', '/api/accounts/browser-archive',
  '/api/local-drive', '/api/local-drive/media', '/api/local-drive/font',
  '/api/local-drive/shared-file', '/api/local-drive/project-thumbnail',
  '/api/project-fonts', '/api/shared-library', '/api/batch-edit',
  '/api/sounds/search',
  '/api/local-subject-framing', '/api/transcription/whisper-cpp',
  '/api/ai/chat', '/api/ai/models', '/api/ai/oauth/status',
  '/api/ai/oauth/device', '/api/ai/oauth/logout',
]);
const hopHeaders = ['connection', 'keep-alive', 'proxy-authenticate',
  'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];
function stripHopHeaders(headers) {
  for (const key of String(headers.connection || '').split(',')) delete headers[key.trim().toLowerCase()];
  for (const key of hopHeaders) delete headers[key];
}

export function createTailnetGateway({ publicOrigin, backendOrigin }) {
  const external = new URL(publicOrigin), backend = new URL(backendOrigin);
  if (external.protocol !== 'https:' || !external.hostname.endsWith('.ts.net') ||
      external.origin !== publicOrigin || external.username || external.password)
    throw new Error('Configure an exact HTTPS Tailscale origin');
  if (backend.protocol !== 'http:' || backend.hostname !== '127.0.0.1' ||
      backend.origin !== backendOrigin || backend.username || backend.password)
    throw new Error('The app backend must be an exact IPv4 loopback origin');
  return createServer((req, res) => {
    const reject = (status, error) => {
      // Do not reuse connections with a rejected, possibly unread request body.
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Connection: 'close' });
      res.end(JSON.stringify({ error }));
    };
    if (req.headers.host !== external.host) return reject(403, 'Unexpected host');
    const origin = req.headers.origin;
    if (origin && origin !== publicOrigin) return reject(403, 'Cross-origin request rejected');
    const read = ['GET', 'HEAD'].includes(req.method);
    if (!read && origin !== publicOrigin) return reject(403, 'Same-origin request required');
    if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site']))
      return reject(403, 'Cross-site request rejected');
    let target;
    let bodyLimit = Infinity;
    try {
      if (!req.url.startsWith('/') || req.url.startsWith('//') || /[\\\x00-\x20]/.test(req.url)) throw Error();
      target = new URL(req.url, backend);
      const path = decodeURIComponent(target.pathname);
      if (/[\\%]/.test(path) || path.split('/').some(part => part === '.' || part === '..')) throw Error();
      if (/^\/api(?:\/|$)/i.test(path) && !apiPaths.has(path) && !path.startsWith('/api/account-assets/'))
        return reject(403, 'This endpoint is available only on the local computer');
      if (path.startsWith('/api/ai/')) bodyLimit = path === '/api/ai/oauth/device' ? 1000 : 1_000_000;
      if (Number(req.headers['content-length']) > bodyLimit) return reject(413, 'AI request is too large');
    } catch { return reject(400, 'Invalid request path'); }
    const headers = { ...req.headers };
    stripHopHeaders(headers);
    for (const key of Object.keys(headers))
      if (key === 'forwarded' || key.startsWith('x-forwarded-') || key.startsWith('tailscale-')) delete headers[key];
    headers.host = backend.host;
    if (origin) headers.origin = backend.origin;
    // Only after validating the external Host and Origin do we translate the
    // transport to the existing loopback host. MCP and local OAuth callbacks
    // stay blocked; browser device login has a narrow authenticated endpoint.
    const upstream = httpRequest(target, { method: req.method, headers }, response => {
      const outgoing = { ...response.headers };
      stripHopHeaders(outgoing);
      if (outgoing['set-cookie']) outgoing['set-cookie'] = outgoing['set-cookie'].map(cookie =>
        /;\s*secure(?:;|$)/i.test(cookie) ? cookie : `${cookie}; Secure`);
      if (outgoing.location?.startsWith(backend.origin + '/'))
        outgoing.location = publicOrigin + outgoing.location.slice(backend.origin.length);
      res.writeHead(response.statusCode || 502, outgoing);
      response.pipe(res);
      response.on('error', () => res.destroy());
    });
    upstream.on('error', () => { if (oversized) return; if (!res.headersSent) reject(502, 'OpenCut is starting. Try again shortly.'); else res.destroy(); });
    req.on('aborted', () => upstream.destroy());
    res.on('close', () => upstream.destroy());
    let received = 0, oversized = false;
    req.on('data', chunk => {
      received += chunk.length;
      if (!oversized && received > bodyLimit) {
        oversized = true;
        req.unpipe(upstream);
        upstream.destroy();
        if (!res.headersSent) reject(413, 'AI request is too large');
        else res.destroy();
      }
    });
    req.pipe(upstream);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.OPENCUT_GATEWAY_PORT || 3111);
  const server = createTailnetGateway({ publicOrigin: process.env.OPENCUT_PUBLIC_ORIGIN,
    backendOrigin: process.env.OPENCUT_BACKEND_ORIGIN || 'http://127.0.0.1:3110' });
  server.listen(port, '127.0.0.1', () => console.log(`OpenCut tailnet gateway listening on 127.0.0.1:${port}`));
}
