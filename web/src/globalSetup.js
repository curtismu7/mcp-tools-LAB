// Vitest global setup: runs in Node (not jsdom). Starts the real server app on one of the repo's test ports so the page
// tests for the simulated gateway can call the real engine. MOCK_ONLY keeps it from touching any disk or network.
import { createApp } from "../../server/src/app.js";
import { startHttpServer } from "../../server/src/index.js";

const PORTS = [4760, 4761, 4762, 4763, 4764, 4765, 4766, 4767, 4768, 4769];

export default async function setup(project) {
  const app = createApp({ env: { MOCK_ONLY: "1" } });
  let srv;
  let last;
  for (const port of PORTS) {
    try { srv = await startHttpServer({ port, host: "127.0.0.1", app }); break; } catch (err) { if (err?.code !== "EADDRINUSE") throw err; last = err; }
  }
  if (!srv) throw last;
  project.provide("gatewayOrigin", `http://127.0.0.1:${srv.port}`);
  return async () => { await srv.close(); };
}
