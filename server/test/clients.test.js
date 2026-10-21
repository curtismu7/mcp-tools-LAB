import assert from 'node:assert/strict';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createHttpClient, sseMessages } from '../src/mcp/http.js';
import { createStdioClient } from '../src/mcp/stdio.js';
import { collectFromClient } from '../src/scanner/live.js';
import { startFakeMcp } from './fixtures/fakeMcp.js';

const STDIO = fileURLToPath(new URL('./fixtures/stdioServer.mjs', import.meta.url));

test('http: handshake, session id, tools/list and tools/call (JSON replies)', async () => {
  const srv = await startFakeMcp();
  const c = createHttpClient({ url: srv.url });
  assert.equal((await c.rpc('tools/list')).tools[0].name, 'get_time');
  assert.equal(c.info().serverInfo.name, 'fake');
  assert.match((await c.rpc('tools/call', { name: 'get_time', arguments: { tz: 'UTC' } })).content[0].text, /UTC/);
  assert.deepEqual(srv.seen.methods.slice(0, 2), ['initialize', 'notifications/initialized']);
  await c.close();
  assert.equal(srv.sessions.size, 0, 'close ends the session');
  await srv.close();
});

test('http: SSE-framed replies work', async () => {
  const srv = await startFakeMcp({ sse: true });
  const c = createHttpClient({ url: srv.url });
  assert.equal((await c.rpc('tools/list')).tools.length, 1);
  await srv.close();
  assert.deepEqual(sseMessages('event: message\ndata: {"id":1}\n\ndata: {"id":2}\n\n').map((m) => m.id), [1, 2]);
});

test('http: an expired session (404) re-initialises once and retries', async () => {
  const srv = await startFakeMcp();
  const c = createHttpClient({ url: srv.url });
  await c.rpc('tools/list');
  srv.sessions.clear();
  assert.equal((await c.rpc('tools/list')).tools.length, 1);
  await srv.close();
});

test('http: auth header is sent, a 401 is an error, unreachable is normalised', async () => {
  const srv = await startFakeMcp({ token: 'Bearer good' });
  const ok = createHttpClient({ url: srv.url, getAuth: () => ['Authorization', 'Bearer good'] });
  await ok.rpc('tools/list');
  assert.ok(srv.seen.auth.every((a) => a === 'Bearer good'));
  const bad = createHttpClient({ url: srv.url, getAuth: () => ['Authorization', 'Bearer nope'] });
  await assert.rejects(bad.rpc('tools/list'), (e) => e.code === 'mcp_http_error' && e.httpStatus === 401);
  await srv.close();
  const probe = http.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const freePort = probe.address().port;
  await new Promise((r) => probe.close(r));
  await assert.rejects(createHttpClient({ url: `http://127.0.0.1:${freePort}/` }).rpc('tools/list'), (e) => e.code === 'mcp_unreachable' && /ECONNREFUSED/.test(e.message));
});

test('http: a redirect is not followed (an auth header must not travel)', async () => {
  const redirector = http.createServer((_req, res) => res.writeHead(302, { location: 'http://127.0.0.1:1/steal' }).end());
  await new Promise((r) => redirector.listen(0, '127.0.0.1', r));
  const c = createHttpClient({ url: `http://127.0.0.1:${redirector.address().port}/`, getAuth: () => ['Authorization', 'Bearer t0ken-xyz'] });
  await assert.rejects(c.rpc('tools/list'), (e) => e.httpStatus === 302 && /not followed/.test(e.message));
  redirector.close();
});

test('collectFromClient pages tools, reads resources and prompts, and never calls a tool', async () => {
  const tools = Array.from({ length: 5 }, (_, i) => ({ name: `t${i}`, description: 'x', inputSchema: { type: 'object' } }));
  const srv = await startFakeMcp({ tools, pageSize: 2, resources: [{ uri: 'mcp://x/r', name: 'r', contents: [{ text: 'hello' }] }], prompts: [{ name: 'p', arguments: [{ name: 'a' }], messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }] }] });
  const got = await collectFromClient(createHttpClient({ url: srv.url }));
  assert.equal(got.tools.length, 5);
  assert.equal(got.resources[0].contents[0].text, 'hello');
  assert.equal(got.prompts[0].messages[0].content.text, 'hi');
  assert.ok(!srv.seen.methods.includes('tools/call'));
  await srv.close();
});

test('stdio: no shell, minimal environment plus the typed env, and a call round-trips', async () => {
  process.env.MCPTOOLS_LEAK_CHECK = 'must-not-reach-child';
  const c = createStdioClient({ command: process.execPath, args: [STDIO], env: { STDIO_TEST_SECRET: 'typed-secret' } });
  assert.equal((await c.rpc('tools/list')).tools[0].name, 'echo');
  const keys = c.info().serverInfo.envKeys;
  assert.ok(keys.includes('STDIO_TEST_SECRET') && keys.includes('PATH'));
  assert.ok(!keys.includes('MCPTOOLS_LEAK_CHECK'), 'the parent environment is not inherited');
  assert.match((await c.rpc('tools/call', { name: 'echo', arguments: { text: 'hi' } })).content[0].text, /echo hi/);
  await c.close();
});

test('stdio: a shell metacharacter in the command is a literal file name, not a shell', async () => {
  const c = createStdioClient({ command: 'echo hi; touch /tmp/mcp-tools-shell-proof', args: [] });
  await assert.rejects(c.rpc('tools/list'), (e) => e.code === 'mcp_spawn_failed');
});

test('stdio: a missing command and an early exit are reported', async () => {
  await assert.rejects(createStdioClient({ command: '/nonexistent/cmd' }).rpc('tools/list'), (e) => e.code === 'mcp_spawn_failed');
  await assert.rejects(createStdioClient({ command: process.execPath, args: ['-e', 'process.exit(3)'] }).rpc('tools/list'), (e) => e.code === 'mcp_exited');
});
