import React from "react";

// Teaching content for the Entitled listing page: what an MCP aggregate is, the six checks a tool has to pass, guided
// steps and a glossary. Mock examples are names from the lab's invented members (crm, bill, wiki); nothing here is a
// Ping format, and the behaviour is a Ping release claim (2026-11-02), listing and cap measured on gateway v1.261106 (2026-11-08), per-caller entitlement UNVERIFIED on our tenant until Real measures it.

export function Intro({ real }) {
  return (
    <section className="card gwl__intro" aria-labelledby="gwl-what">
      <h3 id="gwl-what">What this page shows</h3>
      <p>An <strong>MCP aggregate</strong> is one gateway app that puts several MCP servers (its <em>members</em>) behind a single URL. An agent connects once and gets every member's tools, each renamed <code>alias__tool</code> so two members can both have a <code>search</code>.</p>
      <p><strong>The problem:</strong> without a filter, every agent that connects sees every tool from every member, including tools it may never use, such as <code>export_all</code> or <code>refund_payment</code>. Just seeing a tool is a risk: the model may try it, a prompt injection can name it, and the list tells an attacker what is there.</p>
      <p><strong>The claim:</strong> the gateway answers <code>tools/list</code> with only the tools this caller is entitled to (entitlement-aware discovery), and refuses a hidden tool when it is called by name anyway. The reply never says how many tools were left out.</p>
      <p className="gwl__mode" data-testid="gwl-mode">
        {real
          ? <><strong>You are in Real:</strong> the page asks your gateway's aggregate apps (from <code>MCP_TOOLS_GW_*</code> settings) with your agent keys, and shows what the gateway really lists and refuses.</>
          : <><strong>You are in Mock:</strong> a simulation in this app with three invented members (crm, bill, wiki) and three callers. Nothing leaves this computer. Switch the header to Real to measure a real gateway.</>}
      </p>
    </section>
  );
}

export const CHECKS = [
  { id: "unknown", name: "The tool exists", text: "The name has to match a tool on some member. A made-up name stops here.", mock: "nope__x" },
  { id: "unreachable", name: "The member is reachable", text: "If the member server is down, its tools drop out, and the member is reported as unreachable, not silently removed.", mock: "make bill unreachable (step 6)" },
  { id: "upstream-sign-in", name: "The caller has signed in to the member", text: "Some members need each user's own account (per-user upstream). Until this caller signs in there, that member's tools are hidden.", mock: "Guest and the bill member" },
  { id: "tool-filter", name: "The aggregate's ToolFilter exposes it", text: "A per-member allow-list on the aggregate: which of the member's tools it exposes at all, for everyone.", mock: "wiki__edit_page" },
  { id: "member-policy", name: "The member's own policy allows this caller", text: "The member server's own rules about who may use which tool. They apply through the aggregate and when the member is used directly.", mock: "Analyst and bill__refund_payment" },
  { id: "aggregate-cap", name: "The aggregate policy cap allows it", text: "A ceiling set on the aggregate. It can only take away from what a member allows, never add, and it is checked on the list and again at the member hop.", mock: "Operator and crm__export_all" },
];

/** active: the check ids to highlight (the one that stopped the last call), or []. note: one line about the highlight. */
export function SixChecks({ active = [], note, real }) {
  return (
    <section className="card" aria-labelledby="gwl-checks">
      <h3 id="gwl-checks">The six checks, in order</h3>
      <p className="muted small">A tool has to pass every check. The first one that fails hides the tool, from the list and from a call by name. The caller only ever sees "not available"; which check stopped it is shown here for teaching.</p>
      <ol className="gwl__checks" data-testid="six-checks">
        {CHECKS.map((c, i) => (
          <li key={c.id} data-active={active.includes(c.id) || undefined} aria-current={active.includes(c.id) ? "step" : undefined}>
            <span className="gwl__n" aria-hidden="true">{i + 1}</span>
            <div>
              <strong>{c.name}</strong>
              <p>{c.text}</p>
              {!real && <p className="muted small">Try it in Mock: {c.mock}</p>}
            </div>
          </li>
        ))}
      </ol>
      {note && <p className="gwl__note" role="status" data-testid="checks-note">{note}</p>}
    </section>
  );
}

// Guided steps for Mock. Each one sets the controls (and makes a call where it says so) against the default policy.
export const STEPS = [
  { id: "guest", title: "Same gateway, a different list", action: { caller: "guest", view: "aggregate" }, notice: "Guest is shown one tool, wiki__search_pages. Nothing in the reply says that crm and bill tools exist. The bill member is marked \"needs the caller's own sign-in\": check 3." },
  { id: "cap", title: "Call a hidden tool by name", action: { caller: "operator", view: "aggregate", call: "crm__export_all" }, notice: "Refused. The crm member's own policy lets Operator export, but the aggregate cap does not, and the cap only takes away: check 6. The reply is the same \"not available\" a caller gets for any hidden tool." },
  { id: "filter", title: "A tool the aggregate never exposes", action: { caller: "operator", view: "aggregate", call: "wiki__edit_page" }, notice: "Refused by the ToolFilter (check 4): the aggregate does not expose edit_page for anyone, whatever the member's policy says." },
  { id: "direct", title: "Use that member directly", action: { caller: "operator", view: "direct", member: "wiki" }, notice: "Used directly, wiki lists edit_page for Operator. The ToolFilter and the cap belong to the aggregate; going around it leaves only the member's own policy. That is why agents should reach members through the aggregate." },
  { id: "member", title: "The member says no", action: { caller: "analyst", view: "aggregate", call: "bill__refund_payment" }, notice: "Refused by the member's own policy (check 5): bill lets Analyst read invoices and payments but not refund them." },
  { id: "down", title: "A member goes down", action: { caller: "analyst", view: "aggregate", unreachable: "billing" }, notice: "bill is now reported as unreachable in the Members list, not dropped without a word, and its tools are gone from the list (check 2). Press Reset to bring it back." },
];

export function TryThis({ onRun, current, disabled }) {
  const step = STEPS.find((s) => s.id === current);
  return (
    <section className="card" aria-labelledby="gwl-try">
      <h3 id="gwl-try">Try this</h3>
      <p className="muted small">Each step sets the controls below for you, using the default policy. Press Reset first if you have edited the policy.</p>
      <ol className="gwl__steps">
        {STEPS.map((s) => (
          <li key={s.id}>
            <button type="button" className="btn" aria-pressed={current === s.id} disabled={disabled} onClick={() => onRun(s)}>{s.title}</button>
          </li>
        ))}
      </ol>
      {step && <p className="gwl__note" role="status" data-testid="try-notice"><strong>What to notice:</strong> {step.notice}</p>}
    </section>
  );
}

export function RealTryThis() {
  return (
    <section className="card" aria-labelledby="gwl-try-real">
      <h3 id="gwl-try-real">Try this on your gateway</h3>
      <ol className="gwl__list">
        <li>Look at the comparison: the same key gets a different list from each aggregate app.</li>
        <li>Pick the app with the fewest tools, then click a name under "Listed in another app but hidden here". Tick the box and call it. The gateway should refuse it, and the six checks show which check the refusal matches.</li>
        <li>An app that refuses at the first request ("refused by policy") is a policy decision for this key on the whole app, before any tool is listed.</li>
        <li>If you have a second agent key, add it as another <code>MCP_TOOLS_GW_KEY_&lt;NAME&gt;</code> and switch the caller to see a different entitlement.</li>
      </ol>
    </section>
  );
}

const TERMS = [
  ["MCP aggregate", "One gateway app (AppType mcp-aggregate) that fronts several MCP servers at one URL."],
  ["Member", "One MCP server inside an aggregate. Each has an Alias."],
  ["alias__tool", "How a member's tool is named through the aggregate: the member Alias, two underscores, the tool's own name."],
  ["tools/list", "The MCP request an agent sends to learn what it can call. Here it is filtered per caller."],
  ["Entitlement", "What this caller is allowed to use. Entitlement-aware discovery lists only those tools."],
  ["ToolFilter", "A per-member list on the aggregate of which tools it exposes at all (the schema name; allow-list is our reading)."],
  ["Member policy", "The member server's own rules about who may use which tool."],
  ["Aggregate policy cap", "A ceiling on the aggregate that only removes access. The deck names it; there is no swagger field for it."],
  ["Per-user upstream", "A member that needs each caller's own sign-in to its service before its tools are shown."],
  ["Member hop", "The moment the gateway forwards a call to the member. The cap and member policy are checked again there."],
  ["Agent key", "The credential an agent presents to the gateway (Real mode). Write-only in this app: never shown or logged."],
];

export function Glossary() {
  return (
    <section className="card" aria-labelledby="gwl-terms">
      <h3 id="gwl-terms">Words on this page</h3>
      <dl className="gwl__terms">
        {TERMS.map(([t, d]) => <React.Fragment key={t}><dt>{t}</dt><dd>{d}</dd></React.Fragment>)}
      </dl>
    </section>
  );
}
