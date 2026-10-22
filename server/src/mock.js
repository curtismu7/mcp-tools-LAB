// MOCK_ONLY=1: a hosted, shared copy that can never reach out. Spec shared with the sibling demo apps.
//  - The only "servers" are the two built-in fixtures below. They are answered in this process: no socket, no fetch, no
//    child process, so there is no URL to resolve and nothing for a redirect or DNS-rebinding trick to aim at.
//  - A connection is { transport: 'mock', fixture } and nothing else. A url, token, command or env value is refused
//    with 403 {error:'mock_only'} by mockGuard (one place, server side), and the manager refuses to build any other client.
//  - Connections are virtual (fixed ids, nothing stored), so nothing is written to disk and nothing leaks between visitors.
import fs from 'node:fs';

export const MOCK_REFUSAL = { error: 'mock_only', message: 'Disabled in the hosted mock.' };
export const mockOnly = (env = process.env) => ['1', 'true'].includes(String(env.MOCK_ONLY || '').trim().toLowerCase());

const hostile = JSON.parse(fs.readFileSync(new URL('./mock/hostile.json', import.meta.url), 'utf8'));

const SAMPLE = {
  label: 'Sample server (clean)',
  serverInfo: { name: 'sample-fixture', version: '1.0' },
  capabilities: { tools: {} },
  tools: [
    { name: 'get_time', description: 'Get the current time.', inputSchema: { type: 'object', properties: { tz: { type: 'string', description: 'Time zone' } } } },
    { name: 'add', description: 'Add two numbers.', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } },
  ],
};
const HOSTILE = {
  label: 'Hostile sample server (poisoned tools)',
  serverInfo: { name: 'hostile-fixture', version: '1.0' },
  capabilities: { tools: {}, resources: {}, prompts: {} },
  tools: hostile.toolsList1.tools,
  resources: hostile.resourcesList.resources,
  resourceContents: hostile.resourcesRead,
  prompts: hostile.promptsList.prompts,
  promptMessages: hostile.promptsGet,
};
export const FIXTURES = { sample: SAMPLE, hostile: HOSTILE };

const rec = (fixture) => ({ id: `mock-${fixture}`, label: FIXTURES[fixture].label, transport: 'mock', fixture, createdAt: '2026-01-01T00:00:00.000Z' });

// Same surface as the real clients (ensure, rpc, info, close), answered from memory.
export function createMockClient(fixture) {
  const f = FIXTURES[fixture];
  if (!f) throw Object.assign(new Error('unknown fixture'), { code: 'mock_only' });
  const info = { protocolVersion: '2025-06-18', serverInfo: f.serverInfo, capabilities: f.capabilities };
  return {
    ensure: async () => {},
    info: () => info,
    close: async () => {},
    async rpc(method, params = {}) {
      switch (method) {
        case 'tools/list': return { tools: structuredClone(f.tools) };
        case 'resources/list': return { resources: (f.resources || []).map(({ contents, ...r }) => structuredClone(r)) };
        case 'resources/read': return { contents: structuredClone(f.resourceContents?.[params.uri]?.contents || []) };
        case 'prompts/list': return { prompts: (f.prompts || []).map(({ messages, ...p }) => structuredClone(p)) };
        case 'prompts/get': return structuredClone(f.promptMessages?.[params.name] || { messages: [] });
        case 'tools/call': return { content: [{ type: 'text', text: `mock result for ${String(params.name).slice(0, 80)} (nothing was run)` }] };
        case 'logging/setLevel': return {};
        default: throw Object.assign(new Error(`no method ${String(method).slice(0, 80)} in the mock`), { code: 'mcp_rpc_error' });
      }
    },
  };
}

// Read-only store with the same interface as store.js: fixed virtual connections, never written anywhere.
export function createMockStore() {
  const all = Object.keys(FIXTURES).map(rec);
  return {
    file: null,
    create(body) {
      if (body?.transport !== 'mock' || !FIXTURES[body.fixture]) throw Object.assign(new Error('unknown fixture'), { code: 'mock_only' });
      return rec(body.fixture);
    },
    get: (id) => all.find((c) => c.id === id) || null,
    list: () => all,
    remove: (id) => all.some((c) => c.id === id),
    publicView: (r) => ({ ...r, token: null }),
    secretsOf: () => [],
  };
}

// The one choke point for everything that is not a connection body. Mounted first on /api in mock-only mode.
export function mockGuard() {
  return (req, res, next) => (/^\/pingone(\/|$)/.test(req.path) ? res.status(403).json(MOCK_REFUSAL) : next());
}

// Applied to the parsed POST /connections body: only {transport:'mock', fixture} (+ label) is allowed.
export function mockBodyAllowed(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  if (body.transport !== 'mock' || !FIXTURES[body.fixture]) return false;
  return Object.keys(body).every((k) => ['transport', 'fixture', 'label'].includes(k));
}
