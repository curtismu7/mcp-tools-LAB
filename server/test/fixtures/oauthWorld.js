import crypto from 'node:crypto';
import http from 'node:http';

// A fake authorization server and a protected MCP server on loopback, shared by the OAuth tests. `opts` bends them:
// wrongIssuer, noRegistration, asOverride, iss/noIss/issParameter, authEndpoint, lax (codes reusable), expiresIn, echo (the MCP server
// echoes the Bearer it got in tools/call).
export const servers = [];
export const listen = (handler) => new Promise((r) => { const s = http.createServer(handler); servers.push(s); s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${s.address().port}`)); });
export const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => r(b)); });
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// A fake authorization server + protected MCP server. `opts` bends them for the negative tests.
export async function world(opts = {}) {
  const st = { codes: new Map(), tokens: new Set(), registered: [], tokenCalls: [], mcpAuth: [], expiresIn: opts.expiresIn ?? 3600 };
  let mcpUrl;
  const as = await listen(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const json = (code, o) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(o));
    if (u.pathname === '/.well-known/oauth-authorization-server') return json(200, { issuer: opts.wrongIssuer ? 'http://127.0.0.1:1' : as, authorization_endpoint: opts.authEndpoint || `${as}/authorize`, ...(opts.issParameter ? { authorization_response_iss_parameter_supported: true } : {}), token_endpoint: `${as}/token`, ...(opts.noRegistration ? {} : { registration_endpoint: `${as}/register` }), code_challenge_methods_supported: ['S256'] });
    if (u.pathname === '/register') { const body = JSON.parse(await readBody(req)); st.registered.push(body); return json(201, { client_id: 'dyn-client-1' }); }
    if (u.pathname === '/authorize') {
      const p = Object.fromEntries(u.searchParams);
      st.lastAuthorize = p;
      const code = `code-${crypto.randomUUID()}`;
      st.codes.set(code, p);
      const back = new URL(p.redirect_uri);
      back.search = new URLSearchParams({ code, state: p.state, ...(opts.noIss ? {} : opts.iss !== undefined ? { iss: opts.iss } : { iss: as }) }).toString();
      return res.writeHead(302, { location: back.toString() }).end();
    }
    if (u.pathname === '/token') {
      const p = Object.fromEntries(new URLSearchParams(await readBody(req)));
      st.tokenCalls.push(p);
      if (p.grant_type === 'authorization_code') {
        const a = st.codes.get(p.code); if (!opts.lax) st.codes.delete(p.code);
        if (!a || b64url(crypto.createHash('sha256').update(p.code_verifier || '').digest()) !== a.code_challenge || p.redirect_uri !== a.redirect_uri || p.resource !== a.resource) return json(400, { error: 'invalid_grant' });
      } else if (p.grant_type !== 'refresh_token' || p.refresh_token !== 'refresh-secret-1') return json(400, { error: 'invalid_grant' });
      const t = `access-secret-${crypto.randomUUID()}`; st.tokens.add(t);
      return json(200, { access_token: t, token_type: 'Bearer', expires_in: st.expiresIn, refresh_token: 'refresh-secret-1' });
    }
    res.writeHead(404).end();
  });
  mcpUrl = await listen(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/.well-known/oauth-protected-resource') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ resource: `${mcpUrl}/mcp`, authorization_servers: [opts.asOverride || as], scopes_supported: ['tools:read'] }));
    const body = await readBody(req);
    const auth = req.headers.authorization || '';
    st.mcpAuth.push(auth);
    if (!st.tokens.has(auth.replace(/^Bearer /, ''))) return res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${mcpUrl}/.well-known/oauth-protected-resource", scope="tools:read"` }).end();
    const msg = JSON.parse(body || '{}');
    if (msg.id === undefined) return res.writeHead(202).end();
    const result = msg.method === 'initialize' ? { protocolVersion: '2025-06-18', serverInfo: { name: 'protected', version: '1' }, capabilities: { tools: {} } } : msg.method === 'tools/list' ? { tools: [{ name: 'whoami', description: 'w', inputSchema: { type: 'object' } }] } : { content: [{ type: 'text', text: `echo ${auth}` }] };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
  });
  return { as, mcp: `${mcpUrl}/mcp`, st, mcpBase: mcpUrl };
}
export async function signIn(app, id, body = {}) {
  const start = await app.call('POST', `/api/connections/${id}/oauth/start`, body);
  if (start.status !== 200) return { start };
  const toAs = await fetch(start.json.authorizeUrl, { redirect: 'manual' }); // the browser goes to the AS ...
  const back = toAs.headers.get('location');
  const cb = await fetch(back, { redirect: 'manual', headers: { Connection: 'close' } }); // ... and back to this tool
  return { start, cb, text: await cb.text() };
}


export const closeAll = () => Promise.all(servers.splice(0).map((s) => new Promise((r) => { s.closeAllConnections?.(); s.close(r); })));
