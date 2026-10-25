# scripts

## `pnpm verify`

The single gate. Runs, failing fast: `format:check` → `typecheck` → `lint` → `test` (Vitest) →
`build` (server + `web/` Vite app into `dist/web`) → boot `dist/server.js` on a free port with a temp SQLite DB → Playwright e2e
(`e2e/`) against it → clean shutdown (must exit 0). Prints a PASS/FAIL table; exit code 0 only
if everything passed.

Outputs (gitignored): `artifacts/screenshots/dashboard.png`, `artifacts/verify/server.log`,
`artifacts/verify/summary.json`, Playwright traces/screenshots on failure under
`artifacts/playwright/`.

## `pnpm dev`

Runs the backend (`tsx watch`, port 3000) and the `web/` Vite dev server together. Open
http://localhost:5173/ for the dashboard with hot reload; Vite proxies `/api`, `/events`,
`/tools`, `/webhooks`, `/health` to the backend (`BACKEND_URL` overrides). The built app
(`dist/web`) is served by Hono at `/`; `/next` redirects there.

## `pnpm ui:explore`

Builds `web/` into `dist/web`, boots the app from source (tsx) on a free port with fake Driver
and Dispatcher phone numbers (calls go to FakeVoice), opens the dashboard at `/` in Chromium, runs steps,
and writes everything to `artifacts/explore/<timestamp>/`:
`NN-<name>.png` screenshots (always `initial` and `final`), `console.jsonl` (browser console,
page errors, failed requests), `server.log`, `summary.json`, `explore.db`.

```sh
pnpm ui:explore                                   # initial + final screenshot
pnpm ui:explore --headed                          # watch it
pnpm ui:explore --click 'text=Drivers' --wait 500 --screenshot after-click
pnpm ui:explore --fill '#search::Casey' --press '#search::Enter' --screenshot searched
pnpm ui:explore --wait-for '[data-testid=sse-status][data-state=connected]'
pnpm ui:explore --steps steps.json                # JSON steps run before CLI steps
pnpm ui:explore --url http://127.0.0.1:3000       # use an already running server
```

Steps run in the order given. Two-value flags use `::` as the separator. JSON steps file:

```json
[
  { "action": "goto", "path": "/" },
  { "action": "click", "selector": "h1" },
  { "action": "fill", "selector": "#search", "value": "Casey" },
  { "action": "press", "selector": "#search", "key": "Enter" },
  { "action": "wait", "ms": 250 },
  { "action": "waitFor", "selector": "[data-testid=dashboard]" },
  { "action": "post", "path": "/api/traffic/i280" },
  { "action": "screenshot", "name": "done", "fullPage": true }
]
```

On a failing step it saves `NN-error.png`, records the error in `summary.json`, and exits 1.
