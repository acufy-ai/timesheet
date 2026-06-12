# frontend3 — resume notes

Local-only redesign of the Timesheet UI. Sibling to `frontend2/`. Gitignored.
Design north star: `local/ui-renders/deck.html`.

## Current state (paused 2026-06-05)

- **Steps 1-3 complete and verified.** Scaffold, six-theme system, primitives playground at `/primitives`. Matrix screenshots in `local/ui-renders/frontend3-step2/` and `frontend3-step3/`.
- **Step 4 stalled.** AuthContext, API client, AuthProbe page all written. Vite proxy `/api/*` → backend was returning 404 (and later ECONNREFUSED).
- **Actual root cause** (figured out after the fact): a `tsc -b` run earlier in the session emitted a compiled `vite.config.js` next to `vite.config.ts`. Vite resolves `.js` before `.ts`, so my edits to the `.ts` were silently ignored. Two fixes landed in tsconfig/gitignore to prevent recurrence:
  - `tsconfig.node.json`: `composite: true` → `noEmit: true`
  - `tsconfig.json` includes `vite.config.ts` directly (no project reference to the node config)
  - `.gitignore` ignores `vite.config.js`, `vite.config.d.ts`, `*.tsbuildinfo`
- **Belt-and-suspenders fix also applied:** `vite.config.ts` proxy target changed from `localhost:8000` to `127.0.0.1:8000`. Good practice on Windows regardless — Node resolves `localhost` to IPv6 first, backend is IPv4-only.
- **Neither fix verified end-to-end yet** — needs Vite restart + the probe script run.

## To unblock in the next session

```bash
# 1. Confirm backend is up
curl http://localhost:8000/health
# expect {"status":"ok"}; if not, `docker compose up -d api worker`

# 2. Delete any stale compiled config artifacts (the actual root cause)
rm -f frontend3/vite.config.js frontend3/vite.config.d.ts
rm -f frontend3/tsconfig*.tsbuildinfo

# 3. Kill the running Vite
netstat -ano | grep ':5175.*LISTENING'
taskkill //PID <PID> //F

# 4. Restart Vite
cd frontend3 && npm run dev &

# 4. Verify the IPv4 fix
curl http://localhost:5175/api/health
# expect {"status":"ok"}

curl -X POST http://localhost:5175/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"manager1@example.com","password":"password"}'
# expect access_token + refresh_token + user

# 5. Run the auth-probe end-to-end test
cd /c/Users/acuen/Desktop/Timesheet
node local/ui-renders/f3_auth_probe.js
# Writes 3 screenshots to local/ui-renders/frontend3-step4/
# Looking for probe-authenticated.png showing the user JSON dump.
```

If Vite proxy STILL fails after the IPv4 fix, fallback is to bypass the proxy and hit the backend directly. Edit `src/api/client.ts`:

```ts
export const api = axios.create({
  baseURL: 'http://127.0.0.1:8000',
  timeout: 20_000,
});
```

Backend has CORS open for dev. That's how frontend2 works.

## After Step 4 verifies, proceed to:

- **Step 5** — AppShell with dual-mode nav. Sidebar three-state (expanded / icon-rail / hover-flyout) + TopNav centered segmented pill bar + toggle persisted in `localStorage['acufy:timesheet:nav:mode']`. Design ref: `local/ui-renders/deck.html#nav-modes`.
- **Step 6** — Real LoginPage replacing AuthProbe.
- **Step 7** — Real DashboardPage with backend data. Design ref: `local/ui-renders/deck.html#dashboard`.

After every step, capture the matrix:

```bash
MSYS_NO_PATHCONV=1 node local/ui-renders/capture_f3_matrix.js --step step5 --path "/"
# (prefix needed on Git Bash so `/` isn't path-mangled to C:/Program Files/Git/)
```

## What's already wired

- `src/contexts/ThemeContext.tsx` + `themeVariants.ts` — six themes, storage key `acufy-theme-variant-v3`
- `src/components/layout/ThemePicker.tsx` — palette icon + dark/light grouped dropdown
- `src/api/client.ts` — axios with bearer-token interceptor + `authApi` helpers
- `src/contexts/AuthContext.tsx` — login/logout/refreshUser + role hooks
- `src/types/user.ts` — User shape
- `src/components/ui/` — Button, Card, Input, StatusBadge, StatTile, WorkspaceHeader, Empty
- `src/pages/PrimitivesPage.tsx` — `/primitives` playground
- `src/pages/AuthProbePage.tsx` — `/auth-probe` dev smoke test (delete in Step 6)

## Gotchas worth remembering

1. Vite config-change auto-reload is unreliable on Windows. Edit `vite.config.ts` → kill PID → `npm run dev` again. Don't trust HMR for config changes.
2. MSYS path mangling: prefix Playwright commands with `MSYS_NO_PATHCONV=1` if running from Git Bash, or `/` arguments get rewritten to `C:/Program Files/Git/`.
3. Both frontends can run side-by-side (frontend2 on 5174, frontend3 on 5175). Theme storage keys are version-suffixed so they don't fight.
4. Memory note `[[project_frontend3_step4_resume]]` and `[[feedback_vite_windows_ipv4]]` capture this same context for cross-session continuity.
