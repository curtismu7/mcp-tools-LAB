import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { startHttpServer } from '../src/index.js';
import { createStore } from '../src/store.js';

export function tmpDir(prefix = 'mcp-tools-test-') { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

// A real app on an ephemeral loopback port. `call` sends the Origin a browser page would, unless told not to.
export async function startApp({ env = {}, dir = tmpDir() } = {}) {
  const fullEnv = { ...env, DATA_DIR: dir };
  const app = createApp({ env: fullEnv, store: createStore({ dir }) });
  const srv = await startHttpServer({ port: 0, host: '127.0.0.1', app });
  const origin = `http://127.0.0.1:${srv.port}`;
  async function call(method, p, body, { headers = {}, origin: o = origin, raw = false } = {}) {
    const h = { ...headers };
    if (o && method !== 'GET') h.Origin = o;
    if (body !== undefined && !raw) h['Content-Type'] = 'application/json';
    const res = await fetch(`${origin}${p}`, { method, headers: h, body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, json, text, headers: res.headers };
  }
  return { ...srv, origin, dir, call, app };
}
