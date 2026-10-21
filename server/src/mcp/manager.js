// One live client per connection id. The only place a client is built from a stored connection.
import { createHttpClient } from './http.js';
import { createStdioClient } from './stdio.js';

export function createManager({ store, pingone = null }) {
  const live = new Map();

  function build(conn) {
    if (conn.transport === 'stdio') return createStdioClient(conn);
    if (conn.transport === 'pingone') return createHttpClient({ url: pingone.mcpUrl(), getAuth: () => ['Authorization', `Bearer ${pingone.requireToken()}`] });
    return createHttpClient({ url: conn.url, getAuth: () => (conn.token ? [conn.authHeader || 'Authorization', conn.token] : null) });
  }
  function client(id) {
    const conn = store.get(id);
    if (!conn) return null;
    if (!live.has(id)) live.set(id, build(conn));
    return live.get(id);
  }
  return {
    client,
    rpc: (id, method, params) => client(id).rpc(method, params),
    async test(id) { const c = client(id); await c.ensure(); return c.info(); },
    async remove(id) { const c = live.get(id); live.delete(id); await c?.close(); return store.remove(id); },
    async closeAll() { await Promise.all([...live.values()].map((c) => c.close())); live.clear(); },
  };
}
