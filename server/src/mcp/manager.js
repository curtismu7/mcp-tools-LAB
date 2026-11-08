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
  // A server that answers initialize and tools/list anonymously but 401s a call (the Banking MCP server) never shows its need for
  // a token to the discovery probe. The 401 of a real call does: remember its Bearer challenge so the page offers the sign-in.
  // Stays an ordinary error when: a saved token or a live sign-in was refused (signing in again would not help), the 401 is not a
  // Bearer challenge, or the sign-in cannot be set up (its metadata is unreachable: the page would have nothing to show).
  const usesCredential = (id, conn) => Boolean(conn?.token || oauth?.auth(id));
  async function guarded(id, method, run) {
    try {
      const out = await run();
      // A call that went through with no credential at all proves the server does not need one for calls: forget the challenge.
      if (method === 'tools/call' && !usesCredential(id, store.get(id))) oauth?.clearChallenge(id);
      return out;
    } catch (err) {
      const conn = store.get(id);
      if (err?.httpStatus === 401 && conn?.transport === 'http' && !usesCredential(id, conn) && oauth?.noteChallenge(id, err.wwwAuthenticate)) {
        try { await oauth.discover(conn, { fresh: true }); } catch (e) {
          // A discovery problem the page can show (wrong resource, Ping host, no PKCE ...) still means "sign in needed"; one it cannot
          // show (unreachable) does not: report the original error instead of pointing at a card that will not appear.
          if (!(typeof e?.code === 'string' && e.code.startsWith('oauth_') && e.code !== 'oauth_unreachable')) { oauth.clearChallenge(id); throw err; }
        }
        throw Object.assign(new Error('This server wants a sign-in. Use the OAuth sign-in on this page, then try again.'), { code: 'mcp_signin_needed', httpStatus: 401 });
      }
      throw err;
    }
  }
  function client(id) {
    const conn = store.get(id);
    if (!conn) return null;
    if (!live.has(id)) live.set(id, build(conn));
    return live.get(id);
  }
  return {
    client,
    rpc: (id, method, params) => guarded(id, method, async () => { await oauth?.fresh(id); return client(id).rpc(method, params); }),
    test: (id) => guarded(id, 'test', async () => { await oauth?.fresh(id); const c = client(id); await c.ensure(); return c.info(); }),
    async remove(id) { const c = live.get(id); live.delete(id); await c?.close(); return store.remove(id); },
    async closeAll() { await Promise.all([...live.values()].map((c) => c.close())); live.clear(); },
  };
}
