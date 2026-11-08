// One live client per connection id. The only place a client is built from a stored connection.
import { createMockClient } from '../mock.js';
import { createHttpClient } from './http.js';
import { parseChallenge } from '../oauth.js';
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
  // A 401 with a Bearer challenge from a server we reach over http with no credential: remember it so the page offers the
  // sign-in. Resolves true when the card will show; false (nothing remembered) for every other refusal.
  const noting = new Map(); // connection id -> { at, p }: the one note-and-check in flight (or finished <10 s ago)
  async function noteRefusal(id, err) {
    const conn = store.get(id);
    if (!(err?.httpStatus === 401 && conn?.transport === 'http' && !usesCredential(id, conn))) return false;
    const hit = noting.get(id);
    if (hit && Date.now() - hit.at < 10_000) return hit.p; // many refused calls (a proxied agent) cost one discovery, not one each
    const p = noteOnce(id, conn, err);
    noting.set(id, { at: Date.now(), p });
    return p;
  }
  async function noteOnce(id, conn, err) {
    if (!oauth?.noteChallenge(id, err.wwwAuthenticate)) return false;
    try { await oauth.discover(conn, { fresh: true }); } catch (e) {
      // A discovery problem the page can show (wrong resource, Ping host, no PKCE ...) still means "sign in needed"; one it cannot
      // show (unreachable) does not: report the original error instead of pointing at a card that will not appear.
      if (!(typeof e?.code === 'string' && e.code.startsWith('oauth_') && e.code !== 'oauth_unreachable')) { oauth.clearChallenge(id); return false; }
    }
    return true;
  }
  // The scopes a 403 says the call needs: RFC 6750 `error="insufficient_scope", scope="a b"` in the challenge, or a JSON-RPC error
  // whose data lists requiredScopes (the Banking MCP server). Only plain scope names pass (they go into a message).
  const plainScopes = (list) => [...new Set(list.filter((x) => typeof x === 'string' && /^[A-Za-z0-9:._\-/]{1,100}$/.test(x)))].slice(0, 10);
  function requiredScopes(err) {
    let list = [];
    const ch = parseChallenge(err?.wwwAuthenticate);
    if (ch.error === 'insufficient_scope' && ch.scope) list = ch.scope.split(/\s+/);
    if (!list.length) { try { const d = JSON.parse(err?.bodyText || '').error?.data?.requiredScopes; if (Array.isArray(d)) list = d; } catch { /* not JSON */ } }
    return plainScopes(list);
  }
  async function guarded(id, method, run) {
    try {
      const out = await run();
      // A call that went through with no credential at all proves the server does not need one for calls: forget the challenge.
      if (method === 'tools/call' && !usesCredential(id, store.get(id))) oauth?.clearChallenge(id);
      return out;
    } catch (err) {
      const conn = store.get(id);
      if (await noteRefusal(id, err)) {
        throw Object.assign(new Error('This server wants a sign-in. Use the OAuth sign-in on this page, then try again.'), { code: 'mcp_signin_needed', httpStatus: 401 });
      }
      // Signed in, but the call needs a scope the sign-in does not hold: say which, instead of a bare 403.
      const need = err?.httpStatus === 403 && conn?.transport === 'http' && oauth?.auth(id) ? requiredScopes(err) : [];
      if (need.length) {
        const have = plainScopes(String(oauth.status(id).scope || '').split(/\s+/)); // the AS chose this text: plain names only
        const missing = need.filter((x) => !have.includes(x));
        if (missing.length) {
          throw Object.assign(new Error(`This call needs the scope${missing.length > 1 ? 's' : ''} ${missing.join(' ')}, which this sign-in does not have (it has: ${have.join(' ') || 'none listed'}). It is requested at sign-in only if the server lists it and, for our PingOne, MCPTOOLS_P1_SCOPES allows it and the app is granted it. Trust this server first; then sign in again.`), { code: 'mcp_scope_needed', httpStatus: 403 });
        }
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
    noteRefusal,
    rpc: (id, method, params) => guarded(id, method, async () => { await oauth?.fresh(id); return client(id).rpc(method, params); }),
    test: (id) => guarded(id, 'test', async () => { await oauth?.fresh(id); const c = client(id); await c.ensure(); return c.info(); }),
    async remove(id) { const c = live.get(id); live.delete(id); await c?.close(); return store.remove(id); },
    async closeAll() { await Promise.all([...live.values()].map((c) => c.close())); live.clear(); },
  };
}
