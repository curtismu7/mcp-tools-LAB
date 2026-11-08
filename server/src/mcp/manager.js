// One live client per connection id. The only place a client is built from a stored connection.
import { createMockClient } from '../mock.js';
import { createHttpClient } from './http.js';
import { createStdioClient } from './stdio.js';

export function createManager({ store, pingone = null, mock = false, oauth = null }) {
  const live = new Map();

  function build(conn) {
    if (mock) { // mock-only: the single place a client is built, and it can only be an in-process fixture
      if (conn.transport !== 'mock') throw Object.assign(new Error('Disabled in the hosted mock.'), { code: 'mock_only' });
      return createMockClient(conn.fixture);
    }
    if (conn.transport === 'mock') return createMockClient(conn.fixture); // an in-process sample server: no socket, no process
    if (conn.transport === 'stdio') return createStdioClient(conn);
    if (conn.transport === 'pingone') return createHttpClient({ url: pingone.mcpUrl(), getAuth: () => ['Authorization', `Bearer ${pingone.requireToken()}`] });
    // A third-party OAuth sign-in (oauth.js) wins over a saved token while it is valid.
    return createHttpClient({ url: conn.url, getAuth: () => oauth?.auth(conn.id) || (conn.token ? [conn.authHeader || 'Authorization', conn.token] : null) });
  }
  function client(id) {
    const conn = store.get(id);
    if (!conn) return null;
    if (!live.has(id)) live.set(id, build(conn));
    return live.get(id);
  }
  return {
    client,
    async rpc(id, method, params) { await oauth?.fresh(id); return client(id).rpc(method, params); },
    async test(id) { await oauth?.fresh(id); const c = client(id); await c.ensure(); return c.info(); },
    async remove(id) { const c = live.get(id); live.delete(id); await c?.close(); return store.remove(id); },
    async closeAll() { await Promise.all([...live.values()].map((c) => c.close())); live.clear(); },
  };
}
