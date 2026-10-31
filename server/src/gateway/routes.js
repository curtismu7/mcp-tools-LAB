// /api/gateway/*: the simulated gateway over HTTP. Stateless: the browser sends the config it is editing with each
// request, and nothing is stored on the host, so visitors cannot affect each other and mock-only mode needs no change.
// Everything runs in this process; there is no outbound call of any kind. Errors never repeat what the sender typed.
import express from 'express';
import { analyze, buildReport } from '../scanner/index.js';
import { BOUNDS, ConfigError, TOOL_NAME, credentialLike, nameOk, normalizeConfig } from './config.js';
import { freshConfig } from './fixture.js';
import { BANNER, PROVENANCE, TAG_TEXT } from './provenance.js';
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

export function createGatewayRouter() {
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

  return router;
}
