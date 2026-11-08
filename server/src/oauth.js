// OAuth sign-in for MCP servers. Two methods, chosen by who the authorization server is:
//  - OUR PingOne environment (p1config.js, from ~/Development/.env): pi.flow, the standard Sign in modal, no redirect
//    (rule 16), through piflow.js;
//  - a THIRD-PARTY server: authorization code in the browser, a rule-16 exception (owner, 2026-11-07;
//    docs/rule-16-waiver.md).
// Any other Ping host is refused (a host-name heuristic, stated as such): Ping sign-ins are pi.flow only.
//
// Flow (MCP authorization spec, 2025-06-18): the server's 401 names its protected-resource metadata (RFC 9728), which
// names the authorization server; its metadata (RFC 8414 / OIDC discovery) gives the endpoints. The tool registers
// itself (dynamic client registration, RFC 7591) when the server offers it, else the operator types a client id.
// Authorization code + PKCE S256 in the operator's browser, `resource` = the MCP server (RFC 8707), a single-use
// state that expires, and the `iss` callback parameter checked when the server sends it (RFC 9207).
//
// Safety: tokens, refresh tokens and any client secret stay in this process's memory only. They are never returned
// by an API, never logged and never written to disk; a restart forgets them. Every metadata URL a server hands us
// must be https unless it is a loopback host, redirects are not followed, replies are size- and time-capped.
import crypto from 'node:crypto';
import { p1Config, sameIssuer } from './p1config.js';
import { createPiFlow } from './piflow.js';
import { isLoopbackHost } from './security.js';
import { identityFrom } from './fill.js';

const TIMEOUT_MS = 10_000;
const MAX_BYTES = 64 * 1024;
const STATE_TTL_MS = 10 * 60 * 1000;
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export class OAuthError extends Error { constructor(message, code = 'oauth_error') { super(message); this.code = code; } }

// Ping-hosted authorization servers must use pi.flow (rule 16), so the redirect flow refuses them. Host names only.
export function isPingHost(host) {
  const h = String(host || '').toLowerCase().replace(/\.+$/, ''); // a trailing dot is the same host
  return /(^|\.)(pingone\.[a-z.]+|pingidentity\.com|ping-devops\.com|pingone\.com)$/.test(h) || /(^|[.-])pingone([.-]|$)|pingfederate/.test(h);
}

// Our PingOne does not honour an unknown `resource`: it issues a token for its own API audience instead (measured
// 2026-11-08). A token is kept and sent only if EVERY audience in it is the server it is about to be sent to: a list that
// also names another API (PingOne's own) is just as usable there, so it is refused too. Only the payload is read (the
// server never sees this token, so no signature is checked); an opaque token cannot be checked and is refused.
function trimSlashes(str) { let e = str.length; while (e > 0 && str.charCodeAt(e - 1) === 47) e -= 1; return str.slice(0, e); } // no regex: a long run of slashes stays linear
// For messages only: no query string or fragment (connection URLs may carry secrets there), printable ASCII only.
function shown(raw, max) {
  let t = String(raw);
  try { const u = new URL(t); t = u.origin + u.pathname; } catch { /* not a URL: show it clipped */ }
  return t.slice(0, max).replace(/[^\x20-\x7e]/g, '?');
}
export function checkAudience(accessToken, resource) {
  const norm = (str) => trimSlashes(String(str));
  let aud;
  try { aud = JSON.parse(Buffer.from(String(accessToken).split('.')[1] || '', 'base64url').toString('utf8')).aud; } catch { aud = undefined; }
  const list = Array.isArray(aud) ? aud : [aud];
  const auds = list.filter((a) => typeof a === 'string');
  if (auds.length === 0 || auds.length !== list.length || !auds.every((a) => norm(a) === norm(resource))) {
    const seen = auds.length ? auds.slice(0, 5).map((a) => shown(a, 80)).join(', ') : 'none readable';
    throw new OAuthError(`our PingOne issued a token for a different audience (${seen}), not only for this server (${shown(resource, 120)}), so it was not kept or sent. Define this server's URL as a resource in the PingOne environment, then sign in again.`, 'oauth_audience_mismatch');
  }
}

// MCPTOOLS_P1_RESOURCES: "<server URL>=<audience>" pairs (comma or space separated). A server that signs in with our
// PingOne and names <audience> (not its own URL) in its metadata is asked for a token for <audience>, but ONLY when it is
// the connection with exactly that URL: a server cannot pick an audience, the operator maps one URL to one audience.
// An audience on a Ping API host is ignored (that is the token this tool exists to keep away from other servers).
export function parseResourceMap(raw) {
  const map = new Map();
  for (const item of String(raw || '').split(/[\s,]+/).filter(Boolean)) {
    const cut = item.lastIndexOf('=');
    if (cut < 1) continue;
    let url; try { url = new URL(item.slice(0, cut)); } catch { continue; }
    const aud = item.slice(cut + 1);
    if (!/^https?:$/.test(url.protocol) || !aud || aud.length > 200) continue;
    let host = aud; try { host = new URL(aud).hostname; } catch { /* a bare name such as mcp-invest.ping.demo */ }
    if (isPingHost(host) || /pingone|pingfederate/i.test(aud)) continue; // the raw text too: 'api.pingone.com:443' parses as a scheme with no hostname
    map.set(trimSlashes(url.toString()), aud);
  }
  return map;
}

function checkedUrl(raw, what) {
  let u;
  try { u = new URL(String(raw)); } catch { throw new OAuthError(`${what} is not a valid URL`); }
  if (u.username || u.password) throw new OAuthError(`${what} carries credentials`);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopbackHost(u.hostname))) throw new OAuthError(`${what} must be https (http only for a loopback host): ${u.origin}`);
  return u;
}

async function getJson(url, { method = 'GET', body, headers = {} } = {}) {
  let res;
  try {
    res = await fetch(url, { method, body, headers: { Accept: 'application/json', ...headers }, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) { throw new OAuthError(`${new URL(url).origin} unreachable (${err?.cause?.code || err?.name || 'network error'})`, 'oauth_unreachable'); }
  // Read at most MAX_BYTES: a server that sends more is cut off, never buffered whole.
  let text = '';
  if (res.body) {
    const reader = res.body.getReader(); const dec = new TextDecoder(); let n = 0;
    try { for (;;) { const { done, value } = await reader.read(); if (done) break; n += value.length; text += dec.decode(value, { stream: true }); if (n >= MAX_BYTES) break; } } finally { reader.cancel().catch(() => {}); }
  }
  text = text.slice(0, MAX_BYTES);
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, json, headers: res.headers };
}

// WWW-Authenticate: Bearer resource_metadata="...", scope="..."
export function parseChallenge(header) {
  const out = {};
  for (const m of String(header || '').matchAll(/([a-zA-Z_]+)="([^"]*)"/g)) out[m[1].toLowerCase()] = m[2];
  return out;
}

export function createOAuth({ env = {}, now = Date.now } = {}) {
  const p1 = p1Config(env);
  const p1Resources = parseResourceMap(env.MCPTOOLS_P1_RESOURCES);
  const piflow = createPiFlow({ now });
  const sessions = new Map(); // connection id -> { issuer, clientId, clientSecret, accessToken, refreshToken, expiresAt, scope, tokenEndpoint, resource }
  const pending = new Map(); // state -> { connectionId, verifier, redirectUri, issuer, clientId, clientSecret, tokenEndpoint, resource, scope, at }
  const discovered = new Map(); // connection id -> { at, info }
  const challenges = new Map(); // connection id -> { at, header }: a Bearer challenge a real call got (see noteChallenge)
  const CHALLENGE_TTL_MS = 60 * 60 * 1000;

  async function discover(conn, { fresh = false } = {}) {
    const hit = discovered.get(conn.id);
    if (!fresh && hit && Date.now() - hit.at < 60_000) return hit.info;
    const server = checkedUrl(conn.url, 'the MCP server URL');
    // 1. Does the server want a token at all? An anonymous initialize answers that.
    const probe = await getJson(server.toString(), {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mcp-tools', version: '0.1.0' } } }),
    });
    const noted = challenges.get(conn.id);
    const wantsToken = probe.status === 401 || (noted && now() - noted.at < CHALLENGE_TTL_MS);
    if (!wantsToken) { const info = { required: false }; discovered.set(conn.id, { at: Date.now(), info }); return info; }
    const challenge = parseChallenge(probe.status === 401 ? probe.headers.get('www-authenticate') : noted.header);
    // 2. Protected-resource metadata (RFC 9728): the URL from the challenge, else the well-known path.
    const candidates = challenge.resource_metadata ? [challenge.resource_metadata]
      : [`${server.origin}/.well-known/oauth-protected-resource${server.pathname.replace(/\/$/, '')}`, `${server.origin}/.well-known/oauth-protected-resource`];
    let prm = null;
    for (const c of candidates) {
      const r = await getJson(checkedUrl(c, 'the protected-resource metadata URL').toString());
      if (r.status === 200 && r.json && Array.isArray(r.json.authorization_servers)) { prm = r.json; break; }
    }
    if (!prm || !prm.authorization_servers.length) throw new OAuthError('the server asks for a token but publishes no protected-resource metadata naming an authorization server', 'oauth_no_metadata');
    const issuer = checkedUrl(prm.authorization_servers[0], 'the authorization server');
    const ours = sameIssuer(issuer.toString(), p1.issuer);
    // RFC 9728: the resource in the metadata must be the server we are talking to. A server must not be able to name another
    // audience for the token it receives. One exception: with our PingOne, the operator may have mapped THIS URL to the
    // audience it declares (MCPTOOLS_P1_RESOURCES); anything else it names is refused.
    const mapped = ours ? p1Resources.get(trimSlashes(server.toString())) : undefined;
    const declaresMapped = mapped !== undefined && prm.resource === mapped;
    if (typeof prm.resource === 'string' && trimSlashes(prm.resource) !== trimSlashes(server.toString()) && !declaresMapped) {
      throw new OAuthError('the server names a different resource than its own URL in its metadata; refusing to ask for a token for it' + (ours ? ' (to allow one audience for this URL, set MCPTOOLS_P1_RESOURCES=<server URL>=<audience>)' : ''), 'oauth_resource_mismatch');
    }
    if (ours && !p1.clientId) {
      const info = { required: true, method: 'piflow', refused: 'This server signs in with our PingOne environment (pi.flow). Set PINGONE_MCP_CLIENT_ID in ~/Development/.env to the PingOne application for it, then restart this tool.', issuer: issuer.toString() };
      discovered.set(conn.id, { at: Date.now(), info }); return info;
    }
    if (!ours && isPingHost(issuer.hostname)) {
      const info = { required: true, refused: 'This authorization server is on a Ping host. Ping sign-in is pi.flow only (rule 16), so this tool will not open a redirect sign-in for it. Save the server with a token instead.', issuer: issuer.toString() };
      discovered.set(conn.id, { at: Date.now(), info }); return info;
    }
    // 3. Authorization-server metadata (RFC 8414, then OIDC discovery), with the issuer checked.
    const path = issuer.pathname.replace(/\/$/, '');
    const metaUrls = [`${issuer.origin}/.well-known/oauth-authorization-server${path}`, `${issuer.origin}/.well-known/openid-configuration${path}`, `${issuer.origin}${path}/.well-known/openid-configuration`];
    let meta = null;
    for (const u of metaUrls) { const r = await getJson(u); if (r.status === 200 && r.json?.authorization_endpoint) { meta = r.json; break; } }
    if (!meta) throw new OAuthError('the authorization server publishes no metadata', 'oauth_no_metadata');
    if (String(meta.issuer || '').replace(/\/$/, '') !== issuer.toString().replace(/\/$/, '')) throw new OAuthError('the authorization server metadata names a different issuer', 'oauth_issuer_mismatch');
    if (Array.isArray(meta.code_challenge_methods_supported) && !meta.code_challenge_methods_supported.includes('S256')) throw new OAuthError('the authorization server does not support PKCE S256', 'oauth_no_pkce');
    const endpoint = (v, what) => {
      const u = checkedUrl(v, what);
      // Every endpoint, not only the issuer: a non-Ping issuer must not front a Ping endpoint (pi.flow only for Ping).
      if (!ours && isPingHost(u.hostname)) throw new OAuthError(`${what} is on a Ping host. Ping sign-in is pi.flow only (rule 16), so this tool will not open a redirect sign-in for it.`, 'oauth_ping_refused');
      return u.toString();
    };
    const info = {
      required: true, issuer: meta.issuer, method: ours ? 'piflow' : 'redirect',
      authorizationEndpoint: endpoint(meta.authorization_endpoint, 'the authorization endpoint'),
      tokenEndpoint: endpoint(meta.token_endpoint, 'the token endpoint'),
      registrationEndpoint: meta.registration_endpoint ? endpoint(meta.registration_endpoint, 'the registration endpoint') : null,
      resource: declaresMapped ? mapped : server.toString(), // the connection's own URL, or the one audience the operator mapped to it; never what the server alone says
      scopes: (challenge.scope ? challenge.scope.split(' ') : Array.isArray(prm.scopes_supported) ? prm.scopes_supported : []).filter(Boolean).slice(0, 30),
      issParameter: meta.authorization_response_iss_parameter_supported === true,
    };
    discovered.set(conn.id, { at: Date.now(), info });
    return info;
  }

  async function start(conn, { clientId, redirectUri }) {
    const info = await discover(conn, { fresh: true });
    if (!info.required) throw new OAuthError('this server does not ask for a token', 'oauth_not_required');
    if (info.refused) throw new OAuthError(info.refused, 'oauth_ping_refused');
    if (info.method === 'piflow') throw new OAuthError('this server signs in with our PingOne environment: use the pi.flow sign-in, never a redirect (rule 16)', 'oauth_use_piflow');
    let id = String(clientId || '').trim() || null; let secret = null;
    if (!id) {
      if (!info.registrationEndpoint) throw new OAuthError('this authorization server has no dynamic registration: type a client id registered with redirect URI ' + redirectUri, 'oauth_needs_client_id');
      const r = await getJson(info.registrationEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'MCP tools LAB (local)', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }) });
      if (!(r.status === 201 || r.status === 200) || typeof r.json?.client_id !== 'string') throw new OAuthError(`client registration failed (HTTP ${r.status})`, 'oauth_registration_failed');
      id = r.json.client_id; secret = typeof r.json.client_secret === 'string' ? r.json.client_secret : null;
    }
    for (const [s, p] of pending) if (now() - p.at > STATE_TTL_MS || p.connectionId === conn.id) pending.delete(s); // one sign-in per connection
    const state = b64url(crypto.randomBytes(24));
    const verifier = b64url(crypto.randomBytes(32));
    pending.set(state, { connectionId: conn.id, issParameter: info.issParameter, verifier, redirectUri, issuer: info.issuer, clientId: id, clientSecret: secret, tokenEndpoint: info.tokenEndpoint, resource: info.resource, scope: info.scopes.join(' '), at: now() });
    const url = new URL(info.authorizationEndpoint);
    url.search = new URLSearchParams({ response_type: 'code', client_id: id, redirect_uri: redirectUri, state, code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256', resource: info.resource, ...(info.scopes.length ? { scope: info.scopes.join(' ') } : {}) }).toString();
    return { authorizeUrl: url.toString(), issuer: info.issuer, scopes: info.scopes, registration: clientId ? 'manual' : 'dynamic' };
  }

  async function tokenRequest(p, params) {
    const body = new URLSearchParams({ client_id: p.clientId, ...(p.clientSecret ? { client_secret: p.clientSecret } : {}), resource: p.resource, ...params });
    const r = await getJson(p.tokenEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
    if (r.status !== 200 || typeof r.json?.access_token !== 'string') throw new OAuthError(`token request failed (HTTP ${r.status}${typeof r.json?.error === 'string' ? `, ${r.json.error.slice(0, 60)}` : ''})`, 'oauth_token_failed');
    return r.json;
  }

  // The browser lands here. The state (single use, expiring) ties it to a sign-in this tool started.
  async function callback({ code, state, error, iss }) {
    const p = typeof state === 'string' ? pending.get(state) : null;
    if (p) pending.delete(state);
    if (!p || now() - p.at > STATE_TTL_MS) throw new OAuthError('unknown or expired sign-in (state); start again from the Server page', 'oauth_bad_state');
    if (error) throw new OAuthError(`the authorization server refused: ${String(error).slice(0, 80)}`, 'oauth_denied');
    if (Array.isArray(iss)) throw new OAuthError('the callback carries more than one iss', 'oauth_issuer_mismatch');
    if (iss === undefined && p.issParameter) throw new OAuthError('the authorization server says it sends iss, but the callback has none', 'oauth_issuer_mismatch');
    if (iss !== undefined && String(iss).replace(/\/$/, '') !== String(p.issuer).replace(/\/$/, '')) throw new OAuthError('the callback came from a different issuer (iss)', 'oauth_issuer_mismatch');
    if (typeof code !== 'string' || !code) throw new OAuthError('no code in the callback', 'oauth_no_code');
    const t = await tokenRequest(p, { grant_type: 'authorization_code', code, redirect_uri: p.redirectUri, code_verifier: p.verifier });
    sessions.set(p.connectionId, { ...p, accessToken: t.access_token, refreshToken: typeof t.refresh_token === 'string' ? t.refresh_token : null, expiresAt: Date.now() + (Number(t.expires_in) > 0 ? Number(t.expires_in) : 3600) * 1000, scope: typeof t.scope === 'string' ? t.scope : p.scope });
    return p.connectionId;
  }

  // Refreshes a token that is about to expire. A failed refresh signs the connection out (the operator signs in again).
  const refreshing = new Map(); // connection id -> the refresh in flight (one per connection: a rotating refresh token is used once)
  async function fresh(connectionId) {
    const s = sessions.get(connectionId);
    if (!s || s.expiresAt - Date.now() > 30_000) return;
    if (refreshing.has(connectionId)) return refreshing.get(connectionId);
    const p = refresh(connectionId, s).finally(() => refreshing.delete(connectionId));
    refreshing.set(connectionId, p);
    return p;
  }
  async function refresh(connectionId, s) {
    if (!s.refreshToken) { sessions.delete(connectionId); return; }
    try {
      const t = await tokenRequest(s, { grant_type: 'refresh_token', refresh_token: s.refreshToken });
      if (s.audCheck) checkAudience(t.access_token, s.resource); // a refresh may not widen what the first token was checked for
      Object.assign(s, { accessToken: t.access_token, refreshToken: typeof t.refresh_token === 'string' ? t.refresh_token : s.refreshToken, expiresAt: Date.now() + (Number(t.expires_in) > 0 ? Number(t.expires_in) : 3600) * 1000 });
    } catch { sessions.delete(connectionId); }
  }

  const keep = (connectionId, t, base) => sessions.set(connectionId, { ...base, accessToken: t.access_token, refreshToken: typeof t.refresh_token === 'string' ? t.refresh_token : null, expiresAt: Date.now() + (Number(t.expires_in) > 0 ? Number(t.expires_in) : 3600) * 1000, scope: typeof t.scope === 'string' ? t.scope : base.scope });

  // pi.flow sign-in with our PingOne: the browser sends a username and password to this tool, never to PingOne.
  async function piflowStart(conn, { redirectUri }) {
    const info = await discover(conn, { fresh: true });
    if (info.method !== 'piflow') throw new OAuthError('this server does not sign in with our PingOne environment', 'oauth_not_piflow');
    if (info.refused) throw new OAuthError(info.refused, 'oauth_needs_client_id');
    // A server must not choose what our PingOne grants: only scopes listed in MCPTOOLS_P1_SCOPES (default: none beyond
    // openid) are requested, whatever the server asks for.
    const allowed = new Set(String(env.MCPTOOLS_P1_SCOPES || '').split(/[\s,]+/).filter(Boolean));
    const scope = ['openid', ...info.scopes.filter((x) => x !== 'openid' && allowed.has(x))].join(' ');
    const base = { issuer: info.issuer, clientId: p1.clientId, clientSecret: null, tokenEndpoint: info.tokenEndpoint, resource: info.resource, scope, audCheck: true };
    return piflow.start({ key: conn.id, meta: { issuer: info.issuer, authorizationEndpoint: info.authorizationEndpoint, tokenEndpoint: info.tokenEndpoint }, clientId: p1.clientId, redirectUri, resource: info.resource, scope, onTokens: (id, t) => { checkAudience(t.access_token, info.resource); keep(id, t, base); } });
  }

  return {
    discover, start, callback, fresh, piflowStart,
    piflowCredentials: (connectionId, run, creds) => piflow.credentials(run, creds, connectionId),
    auth: (connectionId) => { const s = sessions.get(connectionId); return s && s.expiresAt > Date.now() ? ['Authorization', `Bearer ${s.accessToken}`] : null; },
    status(connectionId) {
      const s = sessions.get(connectionId);
      return { signedIn: Boolean(s && s.expiresAt > Date.now()), issuer: s?.issuer ?? null, scope: s?.scope ?? null, expiresAt: s?.expiresAt ?? null, canRefresh: Boolean(s?.refreshToken), pending: [...pending.values()].some((p) => p.connectionId === connectionId) };
    },
    // Who is signed in (claims only), for filling the call form; null when not signed in or the token is not a JWT.
    identity: (connectionId) => { const s = sessions.get(connectionId); return s && s.expiresAt > Date.now() ? identityFrom(s.accessToken) : null; },
    secrets: (connectionId) => { const s = sessions.get(connectionId); return s ? [s.accessToken, s.refreshToken, s.clientSecret].filter(Boolean) : []; },
    // A real call got a 401 with a Bearer challenge: the server wants a token even though its initialize probe said no. Only a
    // Bearer challenge counts (Basic or none is an ordinary error). Returns whether it was recorded.
    noteChallenge(connectionId, header) {
      if (typeof header !== 'string' || !/^\s*Bearer\b/i.test(header)) return false;
      challenges.set(connectionId, { at: now(), header: header.slice(0, 2000) });
      discovered.delete(connectionId);
      return true;
    },
    clearChallenge(connectionId) { challenges.delete(connectionId); discovered.delete(connectionId); },
    // Sign out keeps the challenge (the server still wants a token); forget (a deleted connection) drops it.
    signOut(connectionId, { forget = false } = {}) { sessions.delete(connectionId); discovered.delete(connectionId); if (forget) challenges.delete(connectionId); for (const [k, p] of pending) if (p.connectionId === connectionId) pending.delete(k); },
    clear() { sessions.clear(); pending.clear(); discovered.clear(); challenges.clear(); piflow.clear(); },
  };
}
