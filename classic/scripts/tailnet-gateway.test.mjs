import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { createTailnetGateway } from './tailnet-gateway.mjs';

test('tailnet transport preserves auth, streaming and origin protections; excludes MCP', async () => {
  const origin = 'https://opencut.example.ts.net:8444';
  const backend = createServer((req, res) => {
    res.setHeader('Set-Cookie', 'opencut-account=test; HttpOnly; SameSite=Strict; Path=/');
    res.end(JSON.stringify({ host: req.headers.host, origin: req.headers.origin,
      cookie: req.headers.cookie, forwarded: req.headers['x-forwarded-host'], path: req.url }));
  }).listen(0, '127.0.0.1');
  await once(backend, 'listening');
  const backendOrigin = `http://127.0.0.1:${backend.address().port}`;
  const gateway = createTailnetGateway({ publicOrigin: origin, backendOrigin }).listen(0, '127.0.0.1');
  await once(gateway, 'listening');
  const call = (path, headers = {}, method = 'GET', body = '') => new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: gateway.address().port, path, method,
      headers: { host: new URL(origin).host, ...headers } }, res => {
      let body = ''; res.on('data', data => { body += data; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(body) }));
    }); req.on('error', error => reject(new Error(`${method} ${path} (${body.length} bytes): ${error.message}`))); req.end(body);
  });
  try {
    const valid = await call('/api/local-drive', { origin, cookie: 'opencut-account=token',
      'sec-fetch-site': 'same-origin', 'x-forwarded-host': 'evil.test' }, 'POST');
    assert.equal(valid.status, 200);
    assert.equal(valid.body.host, new URL(backendOrigin).host);
    assert.equal(valid.body.origin, backendOrigin);
    assert.equal(valid.body.cookie, 'opencut-account=token');
    assert.equal(valid.body.forwarded, undefined);
    assert.match(valid.headers['set-cookie'][0], /; Secure$/);
    for (const path of ['/api/mcp-bridge/status', '/api/mcp-bridge%2fstatus',
      '/api/%6dcp-bridge/status', '/api/unknown', '/api/ai/oauth/start', '/api/ai/oauth/complete', '/api/ai/oauth/callback', '/api/x/../mcp-bridge/status'])
      assert.equal((await call(path)).status, 403, path);
    for (const path of ['/api/ai/chat', '/api/ai/models', '/api/ai/oauth/status', '/api/ai/oauth/device', '/api/ai/oauth/logout']) {
      assert.equal((await call(path, { origin, cookie: 'opencut-account=token', 'x-opencut-account': 'alice' }, 'POST')).status, 200);
      assert.equal((await call(path, { origin: 'https://evil.test' }, 'POST')).status, 403);
      assert.equal((await call(path, {}, 'POST')).status, 403);
    }
    assert.equal((await call('/api/ai/oauth/device', { origin }, 'POST', 'x'.repeat(1001))).status, 413);
    assert.equal((await call('/api/ai/chat', { origin, 'content-length': '1000001' }, 'POST')).status, 413);
    assert.equal((await call('/api/accounts', { origin: 'https://evil.test' }, 'POST')).status, 403);
    assert.equal((await call('/api/accounts', {}, 'POST')).status, 403);
    assert.equal((await call('/api/accounts', { host: 'evil.test' })).status, 403);
    assert.equal((await call('/api/accounts', { 'sec-fetch-site': 'same-site' })).status, 403);
    assert.equal((await call('/api/local-drive/media?projectId=x&id=y', { cookie: 'opencut-account=token' })).status, 200);
  } finally { gateway.closeAllConnections(); backend.closeAllConnections(); gateway.close(); backend.close(); }
});
