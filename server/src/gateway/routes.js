// /api/gateway/*: the simulated gateway over HTTP. Stateless: the browser sends the config it is editing with each
// request, and nothing is stored on the host, so visitors cannot affect each other and mock-only mode needs no change.
// Everything runs in this process; there is no outbound call of any kind. Errors never repeat what the sender typed.
import express from 'express';
import { analyze, buildReport } from '../scanner/index.js';
import { BOUNDS, ConfigError, TOOL_NAME, credentialLike, nameOk, normalizeConfig } from './config.js';
import { freshConfig } from './fixture.js';
import { BANNER, PROVENANCE, TAG_TEXT } from './provenance.js';
import { createReal } from './real.js';
import { audit, callAggregate, callMember, callerOf, listAggregate, listMember, memberOf } from './sim.js';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const VIEWS = ['aggregate', 'direct'];
const CLAIM = Object.freeze({ banner: BANNER, model: 'lab-invented simulation in this process', live: false });
const QUALIFIED_NAME = /^[a-z][a-z0-9-]{0,15}__[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const bad = (res, message, status = 400, error = 'bad_request') => res.status(status).json({ error, message, claim: CLAIM });

// Strings anywhere in call arguments are checked for credential shapes, with a bound on depth and size. Never echoed.
function argsLookLikeCredentials(v, depth = 0, budget = { n: 200 }) {
  if (budget.n-- <= 0 || depth > 4) return true; // too big or too deep is refused too
  if (typeof v === 'string') return v.length > 2000 || credentialLike(v);
  if (Array.isArray(v)) return v.some((x) => argsLookLikeCredentials(x, depth + 1, budget));
  if (isObj(v)) return Object.entries(v).some(([k, x]) => k.length > 100 || credentialLike(k) || argsLookLikeCredentials(x, depth + 1, budget));
  return false;
}

// One request body -> { cfg, view, caller, member } or throws ConfigError. Only the listed fields are accepted.
function parse(body, allowed) {
  if (!isObj(body)) throw new ConfigError('body', 'must be an object');
  for (const k of Object.keys(body)) if (!allowed.includes(k)) throw new ConfigError('body', 'unexpected field');
  const cfg = normalizeConfig(body.config === undefined ? freshConfig() : body.config);
  const view = body.view ?? 'aggregate';
  if (!VIEWS.includes(view)) throw new ConfigError('view', 'must be aggregate or direct');
  const caller = typeof body.caller === 'string' ? callerOf(cfg, body.caller) : null;
  if (!caller) throw new ConfigError('caller', 'is not a listed caller');
  let member = null;
  if (view === 'direct') {
    member = typeof body.member === 'string' ? memberOf(cfg, body.member) : null;
    if (!member) throw new ConfigError('member', 'is not a listed member');
  } else if (body.member !== undefined) throw new ConfigError('member', 'is only used by the direct view');
  return { cfg, view, caller, member };
}
const listing = ({ cfg, view, caller, member }) => (view === 'direct' ? listMember(cfg, member, caller.id) : listAggregate(cfg, caller.id));

export function createGatewayRouter({ getMode = () => 'mock', mockOnly = false, env = process.env, real = createReal({ env }) } = {}) {
  const router = express.Router();
  const json = express.json({ limit: '64kb' });
  const wrap = (fn) => (req, res) => {
    try { fn(req, res); } catch (err) {
      if (err instanceof ConfigError) return bad(res, err.message, 400, 'bad_config');
      console.error('[mcp-tools] gateway error:', err?.code || err?.name);
      return res.status(500).json({ error: 'server_error' });
    }
  };

  router.get('/default', (_req, res) => res.json({
    claim: CLAIM, config: freshConfig(), bounds: BOUNDS, tags: TAG_TEXT, provenance: PROVENANCE,
  }));

  router.post('/list', json, wrap((req, res) => {
    const p = parse(req.body, ['config', 'view', 'caller', 'member']);
    res.json({ claim: CLAIM, view: p.view, caller: p.caller.id, ...listing(p) });
  }));

  router.post('/call', json, wrap((req, res) => {
    const p = parse(req.body, ['config', 'view', 'caller', 'member', 'tool', 'arguments']);
    const re = p.view === 'direct' ? TOOL_NAME : QUALIFIED_NAME;
    if (!nameOk(req.body.tool, re)) throw new ConfigError('tool', 'is not a well-formed tool name');
    if (req.body.arguments !== undefined && (!isObj(req.body.arguments) || argsLookLikeCredentials(req.body.arguments))) throw new ConfigError('arguments', 'must be a small object with no credential in it');
    const out = p.view === 'direct' ? callMember(p.cfg, p.member, p.caller.id, req.body.tool) : callAggregate(p.cfg, p.caller.id, req.body.tool);
    const { ok, trace, ...rest } = out;
    res.status(ok ? 200 : 403).json({ claim: CLAIM, ...rest, demoTrace: { note: 'Demo only: a real gateway would show the caller just the refusal.', steps: trace } });
  }));

  router.post('/audit', json, wrap((req, res) => {
    const p = parse(req.body, ['config', 'view', 'caller', 'member']);
    res.json({ claim: CLAIM, demoOnly: 'This view names hidden tools. A caller never sees it.', view: p.view, caller: p.caller.id, rows: audit(p.cfg, p.caller.id, p.member) });
  }));

  // Scan the listing exactly as this caller sees it, with the filtered-list caveat in the notes.
  router.post('/scan', json, wrap((req, res) => {
    const p = parse(req.body, ['config', 'view', 'caller', 'member']);
    const seen = listing(p);
    const input = { tools: seen.tools.map((t) => structuredClone(t)) };
    const { findings, truncated } = analyze(input, { trustedNames: [] });
    const report = buildReport({ findings, truncated, input, source: { type: 'snapshot', label: `simulated gateway listing as ${p.caller.label}` } });
    report.notes = [
      `This scan covers only the ${seen.tools.length} tool(s) that ${p.caller.label} sees. Tools hidden from this caller were not scanned, so a clean result here is not a clean result for any other caller.`,
    ];
    res.json({ claim: CLAIM, view: p.view, caller: p.caller.id, report, listed: seen });
  }));

  // ---- Real: the same questions asked of a real gateway's MCP aggregate apps, with the operator's agent keys ----
  const REAL_CLAIM = Object.freeze({ banner: BANNER, model: 'measured on the gateway named in MCP_TOOLS_GW_URL', live: true });
  const READING = 'Which check a refusal matches is our reading of the gateway\'s message; the gateway does not name the check.';
  const realView = () => {
    if (mockOnly) return { mode: 'mock', available: false, problem: 'This hosted copy is mock only (MOCK_ONLY=1): Real is unavailable.' };
    const cfg = real.load();
    return { mode: getMode(), available: cfg.ok, ...(cfg.ok ? { version: cfg.version, apps: cfg.apps, callers: cfg.callers.map(({ id, label }) => ({ id, label })) } : { problem: cfg.problem }) };
  };
  // Every Real request: Real mode on, configured, and an app and caller from the settings. -> cfg, or sends the refusal.
  function realGate(req, res, allowed) {
    if (mockOnly) { res.status(409).json({ error: 'real_not_available', message: 'Real is not available on this hosted mock copy (MOCK_ONLY=1).' }); return null; }
    if (getMode() !== 'real') { res.status(409).json({ error: 'mock_mode', message: 'Switch the header to Real to ask the real gateway.' }); return null; }
    const cfg = real.load();
    if (!cfg.ok) { res.status(409).json({ error: 'real_not_configured', message: cfg.problem }); return null; }
    const b = req.body;
    if (!isObj(b) || Object.keys(b).some((k) => !allowed.includes(k))) { bad(res, `accepted fields: ${allowed.join(', ')}`); return null; }
    if (!real.isApp(cfg, b.app)) { bad(res, 'app is not one of MCP_TOOLS_GW_APPS'); return null; }
    if (!real.isCaller(cfg, b.caller)) { bad(res, 'caller is not one of the configured keys'); return null; }
    return cfg;
  }
  const realWrap = (fn) => (req, res) => fn(req, res).catch((err) => {
    console.error('[mcp-tools] real gateway error:', err?.code || err?.name);
    if (!res.headersSent) res.status(500).json({ error: 'server_error' });
  });

  router.get('/real', (_req, res) => res.set('Cache-Control', 'no-store').json({ claim: REAL_CLAIM, reading: READING, ...realView() }));

  router.post('/real/list', json, realWrap(async (req, res) => {
    const cfg = realGate(req, res, ['app', 'caller']);
    if (!cfg) return;
    const out = await real.list(cfg, req.body.app, req.body.caller);
    res.json({ claim: REAL_CLAIM, reading: READING, app: req.body.app, caller: req.body.caller, ...out });
  }));

  // Only a name that is NOT in this caller's listing is sent: this route tests the refusal, it never runs a listed tool.
  router.post('/real/call', json, realWrap(async (req, res) => {
    const cfg = realGate(req, res, ['app', 'caller', 'tool', 'confirm']);
    if (!cfg) return;
    if (!real.isTool(req.body.tool)) return bad(res, 'tool is not a well-formed tool name');
    if (req.body.confirm !== true) return bad(res, 'confirm must be true: this sends a real tools/call to the gateway');
    const seen = await real.list(cfg, req.body.app, req.body.caller);
    if (seen.ok && seen.tools.some((t) => t.name === req.body.tool)) {
      return res.status(409).json({ error: 'listed_tool', message: 'That tool is in this caller\'s listing. This page only tests that a hidden name is refused; call a listed tool from the Server page, behind the confirm dialog.' });
    }
    const out = await real.callHidden(cfg, req.body.app, req.body.caller, req.body.tool);
    res.json({ claim: REAL_CLAIM, reading: READING, app: req.body.app, caller: req.body.caller, tool: req.body.tool, listedFirst: seen.ok, ...out });
  }));

  return router;
}
