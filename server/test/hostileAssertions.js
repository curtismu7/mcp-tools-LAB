// The success criterion for the scanner, shared by the always-on fixture test and the optional live test: every
// poisoned entry of the hostile server is flagged, none of the benign ones are, and the rug-pull shows on list 2.
import assert from 'node:assert/strict';

export function assertHostileScan(first, second) {
  const by = new Map();
  for (const f of first.report.findings) by.set(f.subject, [...(by.get(f.subject) || []), f]);
  const has = (subject, ruleId) => (by.get(subject) || []).some((f) => f.ruleId === ruleId);

  assert.ok(has('get_weather', 'MT-HI-001'), 'hidden-instruction: <IMPORTANT> block');
  assert.ok(has('summarize_ticket', 'MT-HI-003'), 'hidden-instruction without a tag');
  assert.ok(has('search_docs', 'MT-EX-001') && has('search_docs', 'MT-EX-002'), 'exfil-sink: off-box default + leak instruction');
  assert.ok(has('send_email', 'MT-EX-001'), 'exfil-sink: off-box bcc default');
  assert.ok(has('get_balance', 'MT-SH-001') && has('get_balance', 'MT-SH-003'), 'shadowing: trusted-name collision and claimed primacy');
  assert.ok(has('verify_identity', 'MT-CR-001') && has('verify_identity', 'MT-CR-002'), 'credential harvest');
  assert.ok(has('resource:account-verification', 'MT-HI-001') && has('resource:account-verification', 'MT-SA-002'), 'poisoned resource');
  assert.ok(has('prompt:account_review', 'MT-HI-001'), 'poisoned prompt');

  for (const benign of ['read_ticket', 'create_transfer', 'delete_all_records', 'grant_admin', 'get_stock_price']) {
    assert.deepEqual(by.get(benign) || [], [], `${benign} must not be flagged on the first list`);
  }
  assert.ok(first.listed.tools.some((t) => t.name === 'get_stock_price'));

  // The documented limit: the second list is not the first. The scan of list #1 said nothing about it.
  assert.ok(second.report.findings.some((f) => f.subject === 'get_stock_price' && f.kind === 'hidden-instruction'), 'rug-pull caught on the later list');
  assert.ok(second.report.limits.some((l) => l.id === 'rug-pull'));
}
