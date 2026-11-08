// OPTIONAL, OFF BY DEFAULT (MCPTOOLS_PINGONE=1) and NOT TESTED against a real PingOne tenant in this repo.
// PingOne's hosted MCP server for our environment as one more connection (transport 'pingone'), with the same scan,
// call and confirm path. Sign-in is pi.flow (rule 16): the standard Sign in modal posts a username and password to
// this tool, which drives PingOne's flows API (piflow.js); no browser redirect. Adapted from AI-DEMO2
// standalone/mcp-inspector server/lib/pingone.js (MIT); the redirect + PAR sign-in it had is gone.
// The environment, region and client id come from p1config.js (~/Development/.env: PINGONE_ENVIRONMENT_ID,
// PINGONE_REGION, PINGONE_MCP_CLIENT_ID). The token stays in process memory and is never returned by any API.
import { p1Config } from './p1config.js';
import { createPiFlow } from './piflow.js';

export function createPingone({ env = process.env, port }) {
  let token = null; // { accessToken, expiresAt }
  const p1 = p1Config(env);
  const piflow = createPiFlow();
  const authBase = () => String(p1.issuer || '').replace(/\/as\/?$/, '');
  const mcpUrl = () => env.MCPTOOLS_P1_MCP_URL || `https://mcp.pingone.${p1.region}/admin/${p1.environmentId}/mcp`;
  const redirectUri = () => `http://127.0.0.1:${port}/api/oauth/callback`; // registered with the app; pi.flow never redirects to it
  const configured = () => Boolean(p1.issuer && p1.clientId);
  const signedIn = () => Boolean(token && token.expiresAt > Date.now());

  return {
    configured, signedIn, mcpUrl,
    status: () => ({ enabled: true, configured: configured(), signedIn: signedIn(), expiresAt: token?.expiresAt ?? null }),
    requireToken() {
      if (!signedIn()) throw Object.assign(new Error('Not signed in to PingOne.'), { code: 'pingone_login_required' });
      return token.accessToken;
    },
    secrets: () => (token ? [token.accessToken] : []),
    // pi.flow: opens the flow and returns an opaque run handle; credentials() finishes it.
    startLogin: () => piflow.start({
      key: 'pingone', meta: { issuer: p1.issuer, authorizationEndpoint: `${p1.issuer}/authorize`, tokenEndpoint: `${p1.issuer}/token` },
      clientId: p1.clientId, redirectUri: redirectUri(), resource: mcpUrl(), scope: 'openid',
      onTokens: (_k, t) => { token = { accessToken: t.access_token, expiresAt: Date.now() + (Number(t.expires_in) > 0 ? Number(t.expires_in) : 3600) * 1000 }; },
    }),
    credentials: (run, creds) => piflow.credentials(run, creds, 'pingone'),
    signOut() { token = null; piflow.clear(); },
    authBase,
  };
}
