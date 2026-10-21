# Packaging: Docker, the shelf, the Learning Hub, e2e

## Docker (OrbStack)

```bash
HOST_PORT=4820 docker compose up --build -d     # http://127.0.0.1:4820 ; HOST_PORT defaults to 4810
docker compose down
```

- The image is `node:22-alpine`, runs as the non-root `node` user, keeps saved connections in the `mcp-tools-data` volume at `/data` (mode 700), and has a health check on `GET /api/health`.
- The compose file publishes `127.0.0.1:${HOST_PORT}:4810` only. Inside the container the server listens on all interfaces (`MCPTOOLS_BIND=0.0.0.0` in the Dockerfile) so the published port reaches it; the Host check still accepts only loopback names. **Do not publish it on another address.** `server/test/packaging.test.js` fails if a `ports:` entry does not start with `127.0.0.1:`.
- The root filesystem is read-only, `/tmp` is a tmpfs, all capabilities are dropped and `no-new-privileges` is on.
- **stdio connections launch processes inside the container**, not on your machine: the command you type runs with the container's filesystem and network, as the `node` user, and only what the minimal Alpine and Node image contains is there to run (`node` is; `npx` packages would need network access from the container). To scan a stdio server on your machine, run the app on the host (`npm start`). A server on your machine that listens only on loopback is not reachable from the container.
- Everything here was verified by content on OrbStack: `/api/health` is `demo-health/1` and `ready`, the page loads, a pasted snapshot scans through `POST /api/scan`, a call without confirm is 428 and with a wrong hash is 409.

## SE shelf

`docs/shelf-entry.json` is for the shelf's git-ignored `.data/demos.local.json` (merge it with any entries you already have). It lists the app twice, as D3 (inspector) and D4 (scanner), both at `http://localhost:4810`, because one app is both catalog rows. Edit `composeFile` to this checkout's absolute path. The shelf then shows "Ready" for both, from `GET /api/health`.

## Learning Hub

`content-pack.json` (`demo-content-pack/1`) holds the glossary, cards for the pages and the two stories, one source (the MCP home page named in the inspector README this repo was copied from; its status is `not-read`) and the story pointers. The schema is a copy of the ID-JAG kit's (`docs/content-pack.schema.json`).

```bash
npm run content-pack      # regenerate content-pack.json, then validate it with ajv
node scripts/validate-content-pack.mjs [file]
```

The in-app stories are `MT1` and `MT2`; the schema needs `S` plus two digits, so the pack publishes them as `S01` and `S02`. A test fails if `content-pack.json` is stale.

## Browser e2e (not CI)

```bash
npm run build && npm run e2e
```

Starts the app on `E2E_PORT` (default 4840) with a temporary data directory, clones the **real hostile-mcp server from a clean copy** of `../hostile-mcp` (`HOSTILE_MCP_SRC` to change; needs git and npm) and runs a benign in-process fixture server. In a real Chromium it connects to both, checks the scan-before-first-use banner, scans the hostile server and reads findings with evidence, checks that calls are locked until a scan and then confirm-gated (Cancel sends nothing, Send sends once), scans an offline snapshot with zero-width and bidi characters shown as `[U+XXXX]`, drives the diagram, and fails on any request outside the app origin or any console error. Screenshots go to `.data/e2e-screenshots` (git-ignored). If Playwright cannot find its Chromium, run `npx playwright install chromium` or set `E2E_CHROMIUM` to an executable path.
