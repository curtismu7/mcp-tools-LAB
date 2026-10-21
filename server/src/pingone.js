// OPTIONAL, OFF BY DEFAULT (MCPTOOLS_PINGONE=1) and NOT TESTED against a real PingOne tenant in this repo.
// Adapted from AI-DEMO2 standalone/mcp-inspector server/lib/pingone.js (MIT). Local-loopback Authorization Code +
// PKCE (with a PAR push) against PingOne, then the token is used as the Bearer for PingOne's hosted MCP server, which
// is just another connection (transport 'pingone') with the same scan, call and confirm path.
// Changes from the source: no built-in environment or client id (you supply both), no axios, login start is a POST
// that returns the authorize URL (state-changing, so same-origin only), and the token stays in process memory and is
// never returned by any API.
import crypto from 'node:crypto';

export const CALLBACK_PATH = '/api/pingone/callback';
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function createPingone({ env = process.env, port }) {
  let token = null; // { accessToken, expiresAt }
  let pending = null; // { state, codeVerifier }
  const region = env.PINGONE_REGION || 'com';
  const environmentId = env.PINGONE_ENVIRONMENT_ID || '';
  const clientId = env.PINGONE_MCP_CLIENT_ID || '';
  const authBase = `https://auth.pingone.${region}/${environmentId}/as`;
  const mcpUrl = () => `https://mcp.pingone.${region}/admin/${environmentId}/mcp`;
  const redirectUri = () => `http://127.0.0.1:${port}${CALLBACK_PATH}`;
  const configured = () => Boolean(environmentId && clientId);
  const signedIn = () => Boolean(token && token.expiresAt > Date.now());

  async function form(url, params) {
    const res = await fetch(url, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15_000), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString() });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`PingOne ${new URL(url).pathname.split('/').pop()} failed (${res.status}): ${String(body.error_description || body.error || 'error').slice(0, 200)}`);
    return body;
  }

  return {
    CALLBACK_PATH, configured, signedIn, mcpUrl,
    status: () => ({ enabled: true, configured: configured(), signedIn: signedIn(), expiresAt: token?.expiresAt ?? null }),
    requireToken() {
      if (!signedIn()) throw Object.assign(new Error('Not signed in to PingOne.'), { code: 'pingone_login_required' });
      return token.accessToken;
    },
    secrets: () => (token ? [token.accessToken] : []),
    // Returns the URL the browser should open; the PAR push carries the resource indicator.
    async startLogin() {
      const state = crypto.randomBytes(16).toString('hex');
      const codeVerifier = b64url(crypto.randomBytes(32));
      pending = { state, codeVerifier };
      const par = await form(`${authBase}/par`, {
        response_type: 'code', client_id: clientId, redirect_uri: redirectUri(), scope: 'openid', state,
        code_challenge: b64url(crypto.createHash('sha256').update(codeVerifier).digest()), code_challenge_method: 'S256', resource: mcpUrl(),
      });
      if (!par.request_uri) throw new Error('PAR endpoint did not return request_uri');
      return `${authBase}/authorize?${new URLSearchParams({ client_id: clientId, request_uri: par.request_uri })}`;
    },
    // The IdP redirects the browser here; the state value (not Origin) is what ties it to our login start.
    async handleCallback({ code, state, error }) {
      const p = pending; pending = null;
      if (error) throw new Error(`PingOne sign-in failed: ${String(error).slice(0, 100)}`);
      if (!p || !state || state !== p.state) throw new Error('invalid_state');
      if (!code) throw new Error('missing_code');
      const body = await form(`${authBase}/token`, { grant_type: 'authorization_code', code, redirect_uri: redirectUri(), client_id: clientId, code_verifier: p.codeVerifier, resource: mcpUrl() });
      token = { accessToken: body.access_token, expiresAt: Date.now() + (body.expires_in || 3600) * 1000 };
    },
  };
}
