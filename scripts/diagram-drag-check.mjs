#!/usr/bin/env node
// Real-browser check of the "How it fits" diagram: drag every box (alone, then one after another), on every run, at a desktop
// and a phone width, and expect no edge label on top of a box or of another label, before the drag, after it and after Reset.
// Not part of `npm test` (it needs a browser); the pure geometry of the same rule is in web/src/lib/__tests__/labelSpot.test.js.
//
//   npm run build                      (once; the server serves web/dist)
//   npm run diagram-check              starts the app on DIAGRAM_PORT (default 4768) with a temp DATA_DIR, drives it, stops it
//
// Needs the Chromium the installed Playwright resolves (`npx playwright install chromium` if missing; E2E_CHROMIUM is an
// executable-path fallback). WEB_DIST points at another build (the mutation runner uses it). The app binds loopback; the
// browser requests nothing outside it.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.DIAGRAM_PORT) || 4768;
const base = `http://127.0.0.1:${port}`;
const DRAGS = [[40, 30], [-40, -30]];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (!fs.existsSync(path.join(process.env.WEB_DIST || path.join(root, 'web', 'dist'), 'index.html'))) { console.error('Run `npm run build` first.'); process.exit(2); }

// Runs in the page. Label boxes and node boxes in screen pixels: any label touching a node, or covering more than 8% of a
// smaller label, is a problem. (The same measure as the family's diagram-overlap script, with a stricter node test.)
const MEASURE = () => {
  const rect = (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; };
  const area = (a, b) => { const w = Math.min(a.r, b.r) - Math.max(a.x, b.x); const h = Math.min(a.b, b.b) - Math.max(a.y, b.y); return w > 0 && h > 0 ? w * h : 0; };
  const labels = [...document.querySelectorAll('.react-flow__edge-textwrapper')].map((el) => ({ text: el.textContent.trim(), box: rect(el) })).filter((l) => l.text && l.box.w > 1);
  const nodes = [...document.querySelectorAll('.react-flow__node')].map((el) => ({ text: (el.querySelector('strong')?.textContent || '').trim(), box: rect(el) }));
  const found = [];
  for (const l of labels) for (const n of nodes) { const a = area(l.box, n.box); if (a > 1) found.push(`label ${l.text} covers ${Math.round((a / (l.box.w * l.box.h)) * 100)}% on ${n.text}`); }
  for (let i = 0; i < labels.length; i += 1) for (let j = i + 1; j < labels.length; j += 1) {
    const a = area(labels[i].box, labels[j].box);
    if (a / (Math.min(labels[i].box.w * labels[i].box.h, labels[j].box.w * labels[j].box.h) || 1) > 0.08) found.push(`label ${labels[i].text} covers label ${labels[j].text}`);
  }
  return { labels: labels.length, found };
};

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-tools-diagram-'));
fs.chmodSync(work, 0o700);
const app = spawn(process.execPath, ['server/src/index.js'], { cwd: root, env: { ...process.env, PORT: String(port), DATA_DIR: work, STANDALONE_ENV: '/nonexistent/none.env' }, stdio: 'ignore' });
let browser;
let checks = 0;
const failures = [];
try {
  for (let i = 0; i < 100; i += 1) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* not up yet */ } await sleep(150); }
  browser = await chromium.launch({ executablePath: process.env.E2E_CHROMIUM || undefined });
  for (const [width, height] of [[1440, 900], [375, 812]]) {
    const page = await (await browser.newContext({ viewport: { width, height } })).newPage();
    const external = [];
    page.on('request', (r) => { if (new URL(r.url()).origin !== base && !/^(data|blob):/.test(r.url())) external.push(r.url()); });
    await page.goto(`${base}/#diagram`);
    await page.waitForSelector('.react-flow__node');
    await sleep(800);
    const runs = await page.getByLabel('Run').locator('option').evaluateAll((els) => els.map((e) => e.value));
    const measure = async (run, what) => {
      await page.mouse.move(1, 1); await sleep(250);
      const r = await page.evaluate(MEASURE);
      checks += 1;
      if (r.labels < 1 || r.found.length) failures.push(`${width}px ${run} ${what}: ${r.labels < 1 ? 'no labels found' : r.found.join('; ')}`);
    };
    const reset = async () => { await page.getByRole('button', { name: 'Reset' }).click(); await sleep(900); await page.mouse.move(1, 1); };
    const drag = async (index, [dx, dy]) => {
      const node = page.locator('.react-flow__node').nth(index);
      await node.scrollIntoViewIfNeeded(); await sleep(150);
      const b = await node.boundingBox();
      const x = b.x + b.width / 2, y = b.y + b.height / 2;
      await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 3 }); await page.mouse.move(x + dx, y + dy, { steps: 3 }); await page.mouse.up(); await sleep(250);
      return (await node.locator('strong').innerText()).trim();
    };
    for (const run of runs) {
      await page.getByLabel('Run').selectOption(run);
      await sleep(900);
      await reset();
      await measure(run, 'before any drag');
      const count = await page.locator('.react-flow__node').count();
      for (const d of DRAGS) {
        for (let i = 0; i < count; i += 1) { const name = await drag(i, d); await measure(run, `after dragging "${name}" by ${d}`); await reset(); }
        await measure(run, 'after Reset');
        for (let i = 0; i < count; i += 1) { const name = await drag(i, d); await measure(run, `after dragging up to "${name}" by ${d}, one after another`); }
        await reset();
        await measure(run, 'after Reset (all moved)');
      }
    }
    if (external.length) failures.push(`${width}px: requests outside the app: ${external.slice(0, 3).join(', ')}`);
  }
} finally {
  await browser?.close();
  app.kill();
  fs.rmSync(work, { recursive: true, force: true });
}
console.log(`${checks} measurements, ${failures.length} problem(s)`);
for (const f of failures.slice(0, 30)) console.log(`FAIL  ${f}`);
process.exit(failures.length ? 1 : 0);
