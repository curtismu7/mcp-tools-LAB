import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { startHttpServer } from '../src/index.js';
import { createStore } from '../src/store.js';

export function tmpDir(prefix = 'mcp-tools-test-') { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

// Test servers listen on 4760-4769 only (the range set aside for this repo's tests); a busy port is skipped, never freed.
export const TEST_PORTS = [4760, 4761, 4762, 4763, 4764, 4765, 4766, 4767, 4768, 4769];
async function listenInRange(app) {
  let last;
  for (const port of TEST_PORTS) {
    try { return await startHttpServer({ port, host: '127.0.0.1', app }); } catch (err) { if (err?.code !== 'EADDRINUSE') throw err; last = err; }
  }
  throw last;
}

// A real app on a loopback port from that range. `call` sends the Origin a browser page would, unless told not to.
export async function startApp({ env = {}, dir = tmpDir() } = {}) {
  const fullEnv = { ...env, DATA_DIR: dir };
  const app = createApp({ env: fullEnv, store: createStore({ dir }) });
  const srv = await listenInRange(app);
  const origin = `http://127.0.0.1:${srv.port}`;
  async function call(method, p, body, { headers = {}, origin: o = origin, raw = false } = {}) {
    const h = { Connection: 'close', ...headers }; // tests reuse a few fixed ports, so never reuse a pooled socket to a closed server
    if (o && method !== 'GET') h.Origin = o;
    if (body !== undefined && !raw) h['Content-Type'] = 'application/json';
    const res = await fetch(`${origin}${p}`, { redirect: 'error', method, headers: h, body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, json, text, headers: res.headers };
  }
  return { ...srv, origin, dir, call, app };
}
