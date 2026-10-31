// The rule table: one stable id per rule, one fixed severity (info | warn | high), one kind.
// Kinds keep the original scanner's vocabulary (hidden-instruction, exfil-sink, sensitive-action) and add the new ones.
// Ids never change meaning; a retired rule keeps its id unused.
export const RULES = {
  'MT-HI-001': { severity: 'high', kind: 'hidden-instruction', title: 'Instruction tag in metadata (<IMPORTANT>, <SYSTEM>, ...)' },
  'MT-HI-002': { severity: 'high', kind: 'hidden-instruction', title: 'Metadata tells the agent to hide something from the user' },
  'MT-HI-003': { severity: 'high', kind: 'hidden-instruction', title: 'Agent-directed imperative smuggled into metadata' },
  'MT-EX-001': { severity: 'high', kind: 'exfil-sink', title: 'Argument default points to an off-box URL or address' },
  'MT-EX-002': { severity: 'warn', kind: 'exfil-sink', title: 'Argument or skill text asks for sensitive context (credentials, tokens, full conversation)' },
  'MT-CR-001': { severity: 'high', kind: 'credential-harvest', title: 'Tool description tells the agent to collect passwords, codes or secrets' },
  'MT-CR-002': { severity: 'warn', kind: 'credential-harvest', title: 'Argument is named like a credential (password, otp, secret, token)' },
  'MT-SH-001': { severity: 'high', kind: 'name-shadowing', title: 'Tool name collides with a trusted tool name' },
  'MT-SH-002': { severity: 'warn', kind: 'name-shadowing', title: 'Tool name is a look-alike of a trusted tool name' },
  'MT-SH-003': { severity: 'high', kind: 'name-shadowing', title: 'Description claims primacy over another tool' },
  'MT-SH-004': { severity: 'high', kind: 'name-shadowing', title: 'Two tools in one list share a name' },
  'MT-SA-001': { severity: 'warn', kind: 'sensitive-action', title: 'Content points the agent at a payment or fund-moving action' },
  'MT-SA-002': { severity: 'high', kind: 'sensitive-action', title: 'Content tells the agent to bypass approval or consent' },
  'MT-UC-001': { severity: 'high', kind: 'unicode-trick', title: 'Bidirectional control characters' },
  'MT-UC-002': { severity: 'warn', kind: 'unicode-trick', title: 'Zero-width or other invisible characters' },
  'MT-UC-003': { severity: 'high', kind: 'unicode-trick', title: 'Unicode tag characters (invisible ASCII smuggling)' },
  'MT-UC-004': { severity: 'warn', kind: 'unicode-trick', title: 'Mixed-script word (Latin with Cyrillic or Greek look-alikes)' },
  'MT-DS-001': { severity: 'info', kind: 'oversized-metadata', title: 'Unusually long tool description' },
  'MT-LM-001': { severity: 'warn', kind: 'scan-truncated', title: 'Scan truncated: input exceeded a size, depth or count budget' },
};

export const SEVERITIES = ['info', 'warn', 'high'];
export const severityRank = (s) => SEVERITIES.indexOf(s);

// What a metadata scan does NOT catch. Printed by the CLI, put in every report, shown in the UI.
export const LIMITS = [
  { id: 'result-injection', text: 'Result-based injection: a tool whose metadata is clean but whose call RESULT carries the instruction. The scan never calls a tool, so it cannot see results.' },
  { id: 'rug-pull', text: 'Rug-pulls after the scan: a server can serve a clean list now and a poisoned one later. A scan is a snapshot of one list, one moment. Re-scan, or pin hashes of what you approved.' },
  { id: 'unfetched-content', text: 'Poisoned resources and prompts are only seen if their content was fetched. A metadata-only or offline snapshot scan reads only the names and descriptions it was given.' },
  { id: 'novel-phrasing', text: 'The rules are heuristics over known poisoning shapes. A novel phrasing, another language, or an instruction split across fields can slip past, and an unusually worded legitimate tool can trip a flag.' },
  { id: 'first-contact', text: 'A clean scan is not proof of safety. It does not judge what a tool does when called, who runs the server, or whether the tool should be allowed at all. Control of the call path is a separate layer.' },
  { id: 'filtered-listing', text: 'A scan of an entitlement-filtered list covers only what that caller sees. A tool hidden from this caller was never scanned, so a clean result is not a clean result for any other caller. (Ping release claim of 2026-11-02, UNVERIFIED on our tenant; the lab only simulates it.)' },
  { id: 'reports-only', text: 'The scanner reports. It never blocks a server, changes its data, or stops an agent.' },
];
