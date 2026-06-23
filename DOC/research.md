# Eka Platform — Research & Findings

> Last Updated: 2026-06-18 (Session 9)

---

## Project Stack
- **Backend**: FastAPI + PostgreSQL (SQLAlchemy ORM) — `main.py`
- **DB**: PostgreSQL `eka_automation` @ `localhost:5432` (migrated from SQLite)
- **Frontend**: Vanilla JS + CSS — `static/app.js`, `static/index.html`, `static/style.css`
- **SSO Provider**: OnePalC Hub-Based SSO (AccessHub)
- **VM Management**: libvirt / virsh over SSH

---

## Deployment Reality (as of 2026-06-12)
| Item | Value |
|------|-------|
| **Runtime** | `uvicorn main:app --host 0.0.0.0 --port 8000` (not Docker) |
| **Database** | **PostgreSQL** `eka_automation` (migrated from SQLite ✅) |
| **JWT verification** | **Level 2 (unverified + exp check)** — OnePalC uses RS256; `ONEPALC_JWT_SECRET` is NOT the signing key ⚠️ |
| **Session model** | **User-based persistent** (no TTL) ✅ |

---

## Environment Config (`.env`)
| Variable | Value / Purpose |
|----------|----------------|
| `ONEPALC_ENABLED` | `true` |
| `ONEPALC_HUB_AUTH_URL` | `http://172.26.1.228/login` |
| `ONEPALC_APP_NAME` | `Eka` |
| `ONEPALC_CALLBACK_URL` | `http://172.26.1.126:8000/hub-callback` |
| `ONEPALC_ROLE_KEY` | `EKA` |
| `ONEPALC_API_TOKEN` | `a04bfbf382db7356727876901fa0f93e` (AccessHub query token) |
| `ONEPALC_JWT_SECRET` | `a04bfbf382db7356727876901fa0f93e` — **this is the AccessHub API token, NOT a JWT signing key**. HS256 verification fails because OnePalC signs with RS256. |
| `ONEPALC_PUBLIC_KEY` | *(empty)* — **must be set to OnePalC's RSA public key (PEM) to enable proper RS256 verification. Request from IT team.* |
| `DATABASE_URL` | `postgresql://eka_user:***@localhost:5432/eka_automation` |

---

## Key File Locations

| File | Lines | Purpose |
|------|-------|---------|
| `main.py` | 57–68 | `load_dotenv()` — auto-loads `.env` on startup |
| `main.py` | 6680–6690 | `_ONEPALC_JWT_SECRET`, `_ONEPALC_PUBLIC_KEY` env vars |
| `main.py` | 1270–1335 | Root `/` SSO guard + JWT-on-root forwarder (Session 6 fix) |
| `main.py` | 6757–6768 | `_SEEN_JTI` / `_record_jti()` — replay attack prevention |
| `main.py` | 6771–6850 | `_decode_jwt_payload()` — HS256 → RS256 → unverified fallback |
| `main.py` | 6854–6946 | `hub_callback()` — processes JWT, creates/reuses session |
| `main.py` | 6949–6975 | `onepalc_logout()` — marks session terminated + clears cookie |
| `main.py` | 234–250 | `UserSession` DB model (`expires_at` nullable) |
| `main.py` | 4085–4132 | `vs_action()` — virsh start/stop/resume/suspend/reboot |
| `static/app.js` | 4270–4355 | VS table render — running/paused/shutoff states + Pause+Destroy / Resume / Start buttons |
| `static/app.js` | 4407–4440 | `vsQuickAction()` — handles all VS actions with confirm dialogs (suspend/resume included) |
| `static/style.css` | 903–907 | `.badge.paused` — amber badge for paused VMs |

---

## SSO Authentication Flow

> **Important (Session 6):** OnePalC does NOT call `/hub-callback`. It redirects the
> browser to `/?token=<JWT>` (the app root) after login. The root handler detects the
> token and forwards internally to `/hub-callback`. The `ONEPALC_CALLBACK_URL` value in
> `.env` is sent to OnePalC but appears to be **ignored** by OnePalC.

```
User opens http://172.26.1.126:8000/
    |
    v
serve_dashboard() at "/" (main.py ~1270):
  ?token= present AND ONEPALC_ENABLED -> HTTP 302 -> /hub-callback?token=<JWT>  ← NEW (Session 6)
  No cookie -> HTTP 302 -> http://172.26.1.228/login?app_name=Eka&redirect_uri=...
  Has cookie -> DB lookup: session.status == "active"? -> serve index.html
    |
    v (after OnePalC login — OnePalC redirects to /?token=<JWT>)
hub_callback() at /hub-callback?token=<JWT>:
  Level 1A: PyJWT HS256 verify using ONEPALC_JWT_SECRET  ← FAILS (token is RS256-signed)
  Level 1B: PyJWT RS256 verify using ONEPALC_PUBLIC_KEY  ← SKIPPED (key not set)
  Level 2:  Base64 decode + exp/jti checks               ← ACTIVE (unverified fallback) ✅
  Replay guard: jti already seen -> 403 blocked
  Find existing active session by email -> REUSE (same session_id)
  Not found -> CREATE new persistent session (expires_at=NULL)
  Set eka_session_id cookie + redirect /?sso=1&session_id=...&user_name=...&user_role=...
    |
    v
Frontend app.js:
  Stores session_id, user_name, user_email, user_role to localStorage
  initializeSession() -> validateSession() -> renders dashboard
  Keepalive pings every 4 min (activity recording, no TTL change)
```

---

## Session Model — USER-BASED PERSISTENT

> Sessions do NOT expire by time. A session ends ONLY when:
> 1. User logs out (`/api/onepalc/logout`)
> 2. Admin revokes (`POST /api/sessions/<id>/revoke`)
> 3. Background job cleans up `terminated`/`revoked` sessions

| Field | Type | Notes |
|-------|------|-------|
| `session_id` | VARCHAR(255) UNIQUE | `sso-` prefix for SSO sessions |
| `user_name` | VARCHAR(100) | From JWT `name`/`preferred_username` |
| `user_email` | VARCHAR(255) | From JWT `email`/`sub` |
| `user_role` | VARCHAR(255) | From JWT `roles[EKA]` — synced on every login |
| `status` | VARCHAR(20) | `active` / `terminated` / `revoked` |
| `expires_at` | DATETIME **nullable** | NULL for SSO sessions (no TTL) |
| `last_activity` | DATETIME | Updated on every validate/keepalive call |

---

## Security Hardening — Complete Log

### Fix 1 — JWT Verification (REVISED Session 6) ⚠️ PARTIALLY ACTIVE
**Discovery**: OnePalC signs JWTs with **RS256** (RSA asymmetric). The `ONEPALC_JWT_SECRET`
value is the AccessHub API query token — it is NOT a JWT signing key. HS256 verification
always fails silently and falls through to Level 2.

**Current active mode**: Level 2 — unverified base64 decode with `exp` and `jti` checks.
This is functional but does NOT verify the JWT signature.

**Startup log**: `[OnePalC] JWT verification mode: HS256 (shared secret)` — this line is
misleading; it means HS256 is *attempted* first, but it always falls to Level 2 in practice.

**Action required**: Request the RSA public key (PEM) from the IT/OnePalC team and set
`ONEPALC_PUBLIC_KEY` in `.env`. That enables Level 1B (RS256 cryptographic verification).

Priority chain:
```
1A. HS256 with ONEPALC_JWT_SECRET  ← always fails (wrong key type)
1B. RS256 with ONEPALC_PUBLIC_KEY  ← CORRECT path once key is set
2.  Base64 + exp/jti checks        ← currently active fallback (no sig check)
```

### Fix 2 — JWT Replay Attack Guard ✅
`_SEEN_JTI` in-memory LRU (1000 entries). Same token reused → 403 blocked.

### Fix 3 — User-Based Persistent Sessions ✅
`expires_at=NULL` for SSO sessions. No time-based expiry ever.

### Fix 4 — Logout Terminates DB Session ✅
`/api/onepalc/logout` marks `status=terminated`. Background cleanup deletes record.

### Fix 5 — Admin Revoke Endpoint ✅
`POST /api/sessions/{session_id}/revoke` — instant access revocation.

### Fix 6 — dotenv Auto-Load ✅
`load_dotenv()` added to top of `main.py` — `.env` is always loaded on startup,
no shell `export` needed.

---

## VS (Virtual System) Management — Pause / Resume / State Buttons

### Problem (Session 3 — 2026-06-12)
`virsh list --all` can return VMs in `paused` state (e.g. after `virsh suspend`
or host memory pressure). The old UI only checked `running` vs everything else —
paused VMs showed a Start button, which would fail because virsh cannot
`start` an already-paused VM.

### Fix (Session 3) — Backend + Paused-state detection
Added `resume` and `suspend` to the allowed actions whitelist (`main.py` line ~4107):
```python
allowed_actions = ["start", "destroy", "reboot", "shutdown", "suspend", "resume"]
```
Both map directly to `sudo virsh <action> <vs_name>` over SSH.

---

### Enhancement (Session 4 — 2026-06-12) — Pause button for running VMs

#### Problem
The UI had no way to pause a running VM from the table — only Start and Destroy
were visible. Users had to use the CLI to suspend a VM.

#### Solution — `app.js` line ~4299 (VS table row renderer)

Action column now shows **state-specific buttons**:

| State | Badge | Icon | Buttons shown |
|-------|-------|------|---------------|
| `running` | 🟢 green | `play_circle` | 🟡 **Pause** + 🔴 **Destroy** |
| `paused` | 🟡 amber | `pause_circle` | 🟡 **Resume** only |
| `shut off` | ⚫ grey | `stop_circle` | 🟢 **Start** only |

- **Pause** button (amber `pause` icon) calls `vsQuickAction(name, 'suspend')`
  → confirm dialog → `sudo virsh suspend <name>`
- **Resume** button (amber `play_arrow` icon) calls `vsQuickAction(name, 'resume')`
  → confirm dialog → `sudo virsh resume <name>`
- Action column header widened: `60px` → `100px` to fit two-button layout

#### Confirm dialogs (`app.js` line ~4418)
```
Suspend (pause) VM "sp-Sonic-101"?
This will run:
  sudo virsh suspend sp-Sonic-101

Resume paused VM "sp-Sonic-101"?
This will run:
  sudo virsh resume sp-Sonic-101
```

#### No backend changes needed
`suspend` and `resume` were already in the allowed actions whitelist from Session 3.

#### CSS — `.badge.paused` (`style.css` line ~903)
```css
.badge.paused {
    background: rgba(245, 158, 11, 0.15);
    color: #f59e0b;
}
```

---

## VS Action API Reference

```
POST /api/vs/{dut_id}/action
Body: { "vs_name": "sp-Sonic-101", "action": "resume" }

Actions:
  start    → virsh start   <name>   boot a shut-off VM
  destroy  → virsh destroy <name>   hard stop (like pulling power)
  reboot   → virsh reboot  <name>   graceful restart
  shutdown → virsh shutdown <name>  graceful stop (ACPI)
  suspend  → virsh suspend <name>   pause / freeze VM in memory
  resume   → virsh resume  <name>   un-pause a paused VM
```

---

## PostgreSQL Migration (Completed)

```
Source: SQLite data/eka.db
Target: postgresql://eka_user:***@localhost:5432/eka_automation

Tables migrated (12): audit_logs, dut_configurations, dut_locks, duts,
  execution_logs, executions, hardware_load_jobs, images, scripts,
  topology_connections, user_sessions, users
```

Migration scripts:
- `setup_postgres.sh` — provision DB + user + tables
- `migrate_smart.py` — schema-reflecting data migration (handles extra columns)
- `create_pg_tables.py` — standalone table creation (no FastAPI dependency)

---

## AccessHub API Notes
- Endpoint: `GET /api/app_users.php?token=<TOKEN>&app_name=<APP>`
- 17 Eka users confirmed active as of 2026-06-12
- Some users have blank `display_name`/`email` — incomplete AccessHub profiles

---

## User Management Page — Role-Based Session Visibility

### Session 5 — 2026-06-12

#### Feature
The **Users** tab now shows two side-by-side panels:

| Panel | Content |
|-------|---------|
| **Registered Users** | All users pulled from AccessHub (`/api/onepalc/users`) |
| **Active Sessions** | Role-filtered: admin sees ALL active sessions, user sees only their own |

#### Backend — `GET /api/sessions/active` (`main.py` line ~5936)

Response is now role-aware:

```python
is_admin = (current.user_role or "").lower() == "admin"

if is_admin:
    # returns every session with status="active"
    return {"sessions": [...all], "is_admin": True}
else:
    # returns only the requester's own session
    return {"sessions": [...own], "is_admin": False}
```

Old response shape `{"session": {...}}` replaced with `{"sessions": [...], "is_admin": bool}`.

#### Frontend — `app.js`

| Function | Change |
|----------|--------|
| `loadActiveSessions()` | **Bug fix**: was missing `X-Session-ID` header → HTTP 401. Fixed by using `getSessionHeaders()`. |
| `loadActiveSessions()` | New session card design: avatar with green online dot, name + "You" tag, role badge (purple=admin, blue=user), last-active time-ago, DUT count, join date. |
| `_timeAgo(isoStr)` | New helper — converts ISO timestamp to "just now / Xm ago / Xh ago / Xd ago". |
| `revokeSession()` | Fixed to also send `X-Session-ID` header on the revoke POST. |
| `switchTab('users')` | Calls both `loadUsers()` and `loadActiveSessions()` on tab open. |

#### Session card behaviour
- **Own session**: shown first (sorted to top), tagged with **"You"** pill — no Revoke button
- **Other sessions** (admin only): show **Revoke** button → `POST /api/sessions/{id}/revoke`
- **Role badge**: `admin` = purple, `user` = blue
- **Avatar colour**: admin = purple gradient, user = indigo/blue gradient
- **Online dot**: green dot on avatar (all listed sessions are `status="active"`)

#### Frontend — `index.html` + `style.css`

New two-column grid layout (`.um-grid`) with card panels (`.um-panel`):
- Each panel has a header bar (`.um-panel-head`) with icon + title + count badge
- Scrollable body (`.um-scroll`, max-height 540px)
- Session cards (`.session-card`, `.session-avatar`, `.session-card-meta`, `.session-role-badge`)
- Responsive: collapses to single column below 920 px

#### Key file locations (updated)

| File | Lines | Purpose |
|------|-------|---------|
| `main.py` | ~5936 | `GET /api/sessions/active` — admin gets all, user gets own |
| `static/app.js` | ~5927 | `loadActiveSessions()` — session card renderer |
| `static/app.js` | ~5927 | `_timeAgo()` — timestamp helper |
| `static/app.js` | ~6040 | `revokeSession()` — admin revoke with confirmation |
| `static/index.html` | ~886 | Users tab — two-panel `.um-grid` layout |
| `static/style.css` | ~3283 | `.um-grid`, `.um-panel`, `.session-card` and related classes |

---

## Session 6 — 2026-06-15 — SSO Redirect Loop Fix

### Problem
After entering credentials on the OnePalC login page, users were redirected back to the
OnePalC login page in an infinite loop instead of landing on the Eka dashboard.

### Root Cause (confirmed from `uvicorn.log`)

**1. Wrong callback URL — OnePalC ignores `redirect_uri`**

Access logs showed:
```
GET /?token=eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9... HTTP/1.1 302 Found
```
OnePalC redirects to `/?token=<JWT>` (the app root), NOT to `/hub-callback?token=<JWT>`
as configured in `ONEPALC_CALLBACK_URL`. The `redirect_uri` parameter sent during login is
**ignored by OnePalC** — it always sends the token back to the app root.

The `serve_dashboard("/")` handler ignored the `?token=` param entirely, found no cookie,
and immediately 302'd back to OnePalC login → infinite loop.

**2. RS256 JWT — `ONEPALC_JWT_SECRET` is the wrong key type**

The JWT header is `{"typ":"JWT","alg":"RS256"}`. OnePalC signs with an RSA private key.
The value `a04bfbf382db7356727876901fa0f93e` is the AccessHub API query token, not a JWT
signing secret. Using it for HS256 always raises `InvalidSignatureError`.

### Fix — `main.py` (Session 6)

**`serve_dashboard` — detect JWT on root and forward to hub-callback** (`main.py` ~1291)

```python
jwt_on_root = token or auth_token or access_token or session_token
if jwt_on_root and _ONEPALC_ENABLED:
    callback_url = f"/hub-callback?token={urllib.parse.quote(jwt_on_root)}"
    logger.info(f"[SSO Guard] JWT received at / — forwarding to /hub-callback")
    return RedirectResponse(url=callback_url, status_code=302)
```

`serve_dashboard` now accepts `token`, `auth_token`, `access_token`, `session_token` as
optional query params. If any is present, it 302s to `/hub-callback?token=...` so the
existing session-creation logic handles it. No code duplication.

**`hub_callback` — fix `payload` undefined bug** (`main.py` ~6914)

```python
payload = {}   # ← added — prevents NameError if jwt is empty
if jwt:
    payload = _decode_jwt_payload(jwt)
```

Without this, hitting `/hub-callback` with no token raised `NameError: name 'payload' is
not defined` at the replay-guard check.

### New SSO flow (actual, as of Session 6)

```
/ (no cookie)  →  OnePalC login page
OnePalC login  →  /?token=<RS256 JWT>       ← OnePalC always uses root, not /hub-callback
/?token=...    →  /hub-callback?token=...   ← NEW redirect by serve_dashboard
/hub-callback  →  Level 2 decode (unverified, exp checked)
               →  session created in DB, eka_session_id cookie set
               →  /?sso=1&session_id=...    →  dashboard served
```

### How to diagnose SSO issues in the future

1. Check `uvicorn.log` for `[SSO Guard]` and `[OnePalC]` lines
2. Look at the HTTP access log — what URL is OnePalC actually calling back to?
   - `GET /hub-callback?token=...` → callback is being received correctly
   - `GET /?token=...` → normal (handled by the Session 6 fix)
   - `GET /` (no token, repeated) → cookie issue or DB session not being created
3. If you see `[OnePalC] JWT HS256 signature invalid` → expected, falls to Level 2
4. If you see `[OnePalC] JWT expired` → clock skew between Eka server and OnePalC
5. If you see `[OnePalC] JWT replay detected` → user refreshed the callback URL; harmless

---

## Session 7 — 2026-06-17 — Live Dashboard Plan Revision

### Plan change: Dashboard tab "Recent Executions" left untouched

**Original plan (section 3c)** proposed adding progress bars and pass/fail counts to each
row in the Dashboard tab's "Recent Executions" card.

**Revised decision (Session 7, final)**: The "Recent Executions" card is **removed entirely**
from the Dashboard tab. The Devices card is now full-width. Testcase History sits below it.

**What IS kept / added instead:**

| Location | Feature |
|----------|---------|
| Execute tab | **Live Results** panel — real-time per-script pass/fail/skip table during execution |
| Execute tab | **[Download HTML]** and **[Download Excel]** buttons in the Live Results panel (activate after execution completes) |
| Logs tab | Results column (`✓8 ✗2 ↷1`) + `[⬇ HTML]` `[⬇ XLS]` icon buttons per row + inline comparison panel |
| Dashboard tab | **Testcase History** card (new) — trend across last N runs per test function |

The full revised plan is in `PLAN_live_dashboard.md`.

---

## Session 8 — 2026-06-17 — Bug Fixes & Script Path UX

### Dashboard tab — Script Execution Graph
- `renderDashExecSummary()` (`app.js`) now filters to `type === 'script'` / `'spytest'` only — VS and hardware image-load executions excluded.
- Replaced the per-execution progress-bar list with a single SVG stacked bar chart (passed=green, failed=red, skipped=gray). X-axis = last 12 execution IDs; Y-axis = test-case count auto-scaled to max. Hover tooltip on each bar.
- Card header renamed "Script Execution Graph" (`index.html`).

### Logs tab — Comparison fix
- `GET /api/executions/compare` existed only in `services/execute-service/main.py` (port 8002) but not in `main.py` (port 8000, the actual runtime).
- Added `TestCaseResult` ORM model (maps to existing `testcase_results` table) to `main.py`.
- Added `/api/executions/compare` endpoint to `main.py` **before** `/{execution_id}` so FastAPI matches it correctly (path parameter `{execution_id: int}` would swallow "compare" otherwise via 422).

### Execute tab — Scripts path is now dynamic (user-supplied)
**Problem**: Scripts browse was hardcoded to `SPYTEST_TESTS_DIR = /home/hp_test/Eka/sonic-mgmt/spytest/tests`. Newly added VMs without that path got "Server returned 404".

**Root cause (Starlette routing)**: `{path:path}` converter uses regex `.+` — empty string never matches. URL `/api/spytest/browse/?host_id=X` (empty path) → FastAPI 404 before any app code runs.

**Fixes applied**:

| File | Change |
|------|--------|
| `index.html` | Added path input + "Load" button in "Categories & Scripts" card header |
| `app.js` | `activeBasePath` variable; `loadScriptsFromPath()` validates input and triggers browse; URL uses `/api/spytest/browse` (no slash) for root and `/api/spytest/browse/<path>` for sub-folders |
| `app.js` | `onSpyVMChange()` no longer auto-calls `navigateToPath('')` — scripts only load when user explicitly provides a path and clicks Load |
| `main.py` | Added `GET /api/spytest/browse` root endpoint (delegates to `browse_spytest_folder("", ...)`) |
| `main.py` | `browse_spytest_folder` accepts optional `base_path` query param; uses it instead of hardcoded `SPYTEST_TESTS_DIR` when provided; returns graceful empty response (not 404) when directory missing |

**Key file locations (updated)**:

| File | Lines | Purpose |
|------|-------|---------|
| `main.py` | ~4311 | `GET /api/spytest/browse` — root browse (new) |
| `main.py` | ~4316 | `GET /api/spytest/browse/{path:path}` — sub-folder browse |
| `static/app.js` | ~1430 | `loadScriptsFromPath()` — reads input, sets `activeBasePath`, triggers browse |
| `static/app.js` | ~1444 | `navigateToPath()` — appends `&base_path=` when set |
| `static/index.html` | ~426 | Path input + Load button in "Categories & Scripts" card |

### Execute tab — All spytest paths now dynamic (previously hardcoded)

**Problem**: Even with `base_path` threading added, `_run_spytest_execution()` still used hardcoded `SPYTEST_BIN`, `SPYTEST_VENV`, `SPYTEST_PYTHON`, etc. for the actual execution command.

**Fix**: Added a path-derivation block at the top of `_run_spytest_execution()`:

```python
if base_path:
    _spytest_root   = os.path.dirname(base_path.rstrip("/"))
    _tests_dir      = base_path.rstrip("/")
    _testbed_dir    = _spytest_root + "/testbeds"
    _spytest_bin    = _spytest_root + "/bin/spytest"
    _spytest_venv   = _spytest_root + "/spytest_venv"
    _spytest_python = _spytest_venv + "/bin/python"
else:
    _spytest_root   = SPYTEST_BASE
    _tests_dir      = SPYTEST_TESTS_DIR
    _testbed_dir    = SPYTEST_TESTBED_DIR
    _spytest_bin    = SPYTEST_BIN
    _spytest_venv   = SPYTEST_VENV
    _spytest_python = SPYTEST_PYTHON
```

All 5 hardcoded `SPYTEST_*` constants inside the function replaced with `_`-prefixed local vars. Same pattern applied to `script-info` endpoint.

### Execute tab — Testbed write/read path mismatch ("Execution failed (3s)")

**Symptom**: Execution started, scripts analysed, devices assigned — but run failed within ~3 seconds.

**Root cause (two-part)**:

1. `generateMasterTestbed()` in `app.js` returned `{ master_testbed_path: "/full/absolute/path" }` but `startExecution()` discarded the return value — `await generateMasterTestbed(true)` with no capture.

2. Execute body sent `testbed: 'master_testbed.yaml'` (filename only). Backend re-derived the testbed directory from `base_path`, but when `activeBasePath` was empty it fell back to hardcoded `SPYTEST_TESTBED_DIR` (`/home/hp_test/Eka/sonic-mgmt/spytest/testbeds`) — a path that doesn't exist on new VMs. `cat <testbed_path>` failed instantly → execution marked failed.

**Fix — `static/app.js` (`startExecution()`)**:

```javascript
let generatedTestbedPath = '';
if (selectedDUTIds.size > 0) {
    try {
        const tbData = await generateMasterTestbed(true);
        generatedTestbedPath = tbData?.master_testbed_path || '';
    } catch (e) {
        toast('Failed to generate testbed. Please check topology and try again.', 'error');
        return;
    }
}
const testbedFile = generatedTestbedPath || 'master_testbed.yaml';
```

**Fix — `main.py` (`_run_spytest_execution()`)**:

```python
if testbed_file.startswith("/"):
    testbed_path = testbed_file   # full absolute path — use directly, no re-derivation
else:
    testbed_path = f"{_testbed_dir}/{testbed_file}"
```

**Full path threading chain**:

```
User input (scripts-base-path field)
  → activeBasePath (app.js global)
  → fetch body: base_path: activeBasePath
  → API: user_base_path = body.get("base_path")
  → Thread: _run_spytest_execution(..., base_path=user_base_path)
  → Local vars: _spytest_root, _tests_dir, _testbed_dir, _spytest_bin, etc.

generateMasterTestbed() → POST /api/spytest/generate-testbed
  → derives testbed_dir = dirname(user_base_path) + "/testbeds"
  → mkdir -p testbed_dir  (created if absent)
  → writes master_testbed.yaml
  → returns { master_testbed_path: "/absolute/path/testbeds/master_testbed.yaml" }

startExecution() captures master_testbed_path → passes as testbed field
  → backend: if testbed_file.startswith("/") → use directly (no re-derivation)
```

**Key rule**: Always capture and pass the full remote absolute path returned by `generate-testbed`. Never rely on re-deriving the directory from `base_path` inside `_run_spytest_execution` — `base_path` may be missing at that point.

**Key file locations**:

| File | Location | Purpose |
|------|----------|---------|
| `static/app.js` | `startExecution()` | Capture `tbData.master_testbed_path`, pass as `testbedFile` |
| `main.py` | `_run_spytest_execution()` | Path-derivation block + `startswith("/")` guard |
| `main.py` | `generate_master_testbed()` | Derives `testbed_dir`, `mkdir -p`, returns full path |

---

---

## Session 9 — 2026-06-18 — Smart DUT Allocation Fix

### Problem
Scripts were always assigned exactly 1 DUT regardless of their `st.ensure_min_topology()` declaration because:
1. The `scripts` list sent from the frontend didn't include pre-analyzed `dut_count` / `min_topology` fields → they defaulted to `1` / `[]`.
2. "Enhancement 4" b2b-priority logic in `_find_duts_matching_topology` gave back-to-back (self-loop) DUTs to **every** single-DUT script unconditionally, which was incorrect.
3. `acquire_duts` routed all single-DUT scripts through topology-aware matching (`if link_requirements or needed == 1`), even scripts with no requirements.

### Fixes applied (`main.py`)

#### Fix 1 — Pre-populate `dut_count` / `min_topology` before threads launch
**Location**: `_run_spytest_execution()`, after `topology_connections` is loaded (~line 5081).

When the Topology Canvas has connections (`topology_connections` non-empty), each script whose `min_topology` field is empty is analyzed on-the-fly: the backend reads the script file via the existing `coord_ssh` connection and calls `_parse_spytest_script()`. This fills `dut_count` and `min_topology` before any worker thread starts.

After analysis the max-DUT-requirement check is also re-run so the error message reflects the true requirement.

```
Canvas has connections → read each script → _parse_spytest_script() → fill dut_count + min_topology
```

#### Fix 2 — Gate topology-aware allocation (`acquire_duts`, ~line 5119)
Topology-aware combo matching now only activates when **both**:
- `topology_connections` is non-empty (canvas has connections), AND
- `link_requirements` is non-empty (script declared `D1D2:N` etc.)

All other cases → simple FIFO. Removed the incorrect `needed == 1` condition that routed every single-DUT script through topology matching.

```python
if topology_connections and link_requirements:
    matched = _find_duts_matching_topology(...)
else:
    allocated = available_pool[:needed]   # FIFO
```

#### Fix 3 — Simplified `_find_duts_matching_topology` (~line 4897)
Removed all "Enhancement 4" back-to-back priority logic. The function now:
- Returns `available_duts[:dut_count]` (FIFO) when `link_requirements` is empty
- Tries all combinations to find a combo satisfying link counts when requirements exist
- Returns `None` if no satisfying combo found (triggers waiting in `acquire_duts`)

No b2b detection, no b2b priority — those were incorrectly forcing b2b DUTs onto scripts that didn't need them.

#### Fix 4 — Allocation log (`run_one_script`, ~line 5181)
Log now shows whether topology-matched or FIFO mode was used:
```
[ALLOC] topology-matched → DUT(s): DUT-A, DUT-B
[ALLOC] FIFO → DUT(s): DUT-C
```

### Key rule
Topology-aware allocation (combo matching against canvas connections) only activates when the user has wired up devices in the Topology Canvas **and** the script itself declares link requirements in `st.ensure_min_topology`. Scripts that declare only `"D1"` (no pair like `"D1D2:2"`) always get FIFO allocation.

### Key file locations (updated)

| File | Lines | Purpose |
|------|-------|---------|
| `main.py` | ~4897 | `_find_duts_matching_topology()` — simplified combo matching, no b2b priority |
| `main.py` | ~5081 | Script pre-analysis block — fills `dut_count`/`min_topology` via SSH |
| `main.py` | ~5119 | `acquire_duts()` — FIFO vs topology-aware gate |
| `main.py` | ~5181 | Allocation log — shows FIFO vs topology-matched |

---

## Known Issues / To-Do
- [ ] `user_id=43` has blank profile in AccessHub — needs admin cleanup
- [ ] Non-SSO sessions (`palc-`, `eka-` prefixed) retain old `expires_at` — legacy; expire naturally
- [ ] **`ONEPALC_PUBLIC_KEY` not set** — JWT signatures are NOT verified. Request RSA public key PEM from IT team and set in `.env` to enable Level 1B (RS256) verification.
- [ ] `ONEPALC_JWT_SECRET` is misnamed — it's the AccessHub API token, not a JWT secret. Leaving it as-is for compatibility but it does not contribute to JWT security.
- [ ] Live Dashboard feature (PLAN_live_dashboard.md) — implementation pending (Session 7)

---

## Session 10 — 2026-06-18 — Execution #23 Post-Mortem Fixes

### Errors diagnosed from execution #23 logs

#### Error 1 — Wrong DUT allocation (all scripts got 1 DUT instead of 2)
**Root cause (two layers, both failed):**
1. Frontend `startExecution()` called `/api/spytest/script-info` per script but only captured `dut_count`, discarding `min_topology`. Backend received scripts with no `min_topology` → `link_requirements` was always empty → topology-aware combo matching never activated.
2. Backend pre-analysis block (`_run_spytest_execution` ~line 5094) tried `cat {s_path}` where `s_path` was a **relative path** (e.g. `automation/stp/scripts/test_stp_pvst_neg_007_008.py`). Command always failed (rc≠0) silently — no error log, `dut_count` stayed 1.

**Fixes:**

| File | Change |
|------|--------|
| `static/app.js` → `startExecution()` | Also capture and pass `min_topology` from script-info in `scriptsWithCount` |
| `main.py` → pre-analysis (~5094) | Construct full path: `f"{_tests_dir}/{s_path}"` if not absolute; add `else` log when cat fails |

**Key rule**: `script.path` values coming from the frontend are **relative to `_tests_dir`**. Always prefix with `_tests_dir` before SSHing.

---

#### Error 2 — `test_interface not defined in testbed global params`
Scripts `test_stp_pvst_neg_001.py` and `test_stp_pvst_neg_009.py` required `params.test_interface` in the master testbed. SPyTest uses this as the primary test interface name.

**Fix**: `generate_master_testbed()` now derives `test_interface` from the first (alphabetically) interface of the first connected device in the topology and injects it into `params`.

```python
# Derived: first sorted interface of first device with connections
params_section["test_interface"] = "Ethernet0"   # example output
```

---

#### Error 3 — HTML / Excel reports empty, Dashboard shows nothing
**Root cause**: Three pieces were missing from `main.py` (all existed only in the legacy `services/execute-service/main.py` at port 8002):

1. **No result collection** — `run_one_script` never collected the SPyTest CSV results file after the script finished. `TestCaseResult` rows were never written. `execution.test_results` was never updated.
2. **Missing endpoints** — `/api/executions/{id}/dashboard` and `/api/executions/{id}/excel` did not exist in `main.py`.
3. **Missing `/api/testcases/summary`** — Dashboard's Testcase History card called this endpoint; it didn't exist in `main.py`.

**Fixes applied to `main.py`:**

| Addition | Details |
|----------|---------|
| `_parse_results_csv()` | Parses SPyTest `results_*_functions.csv` into dicts |
| `_collect_and_save_results()` | Called after `✓ Script completed`: finds CSV via SFTP, saves `TestCaseResult` rows, updates `execution.test_results` JSON aggregate |
| `_build_html_dashboard()` | Generates self-contained HTML report with per-feature tabs |
| `_build_excel()` | Generates 3-sheet xlsx: Summary, All Testcases, Failures |
| Helper functions | `_extract_feature`, `_extract_tc_id`, `_fmt_seconds`, `_norm_result`, `_calc_trend` |
| `GET /api/executions/{id}/dashboard` | Returns HTML download |
| `GET /api/executions/{id}/excel` | Returns .xlsx download (requires openpyxl) |
| `GET /api/testcases/summary` | Returns per-function trend data for Dashboard |
| `GET /api/testcases/history` | Returns per-execution history for a function |
| `Execution.test_results` | Added `test_results = Column(Text)` to ORM model |
| `GET /api/executions` response | Now includes `passed`, `failed`, `skipped` counts per execution |
| Imports | Added `StreamingResponse`, `csv`, openpyxl guard |

**How results flow now:**
```
SPyTest writes logs to {log_dir}/
  → After process exits: find results_*_functions.csv
  → _parse_results_csv() → list of {module, test_function, result, ...}
  → Insert TestCaseResult rows into DB
  → Aggregate pass/fail/skip counts → append to execution.test_results JSON
  → Dashboard /api/testcases/summary reads TestCaseResult table
  → HTML/Excel download reads both execution.test_results + TestCaseResult rows
```

### Key file locations (Session 10)

| File | Lines | Purpose |
|------|-------|---------|
| `main.py` | ~4963 | `_parse_results_csv()` — CSV parser |
| `main.py` | ~4997 | `_collect_and_save_results()` — post-script result collector |
| `main.py` | ~5040 | `_build_html_dashboard()` — HTML report generator |
| `main.py` | ~5140 | `_build_excel()` — Excel report generator |
| `main.py` | ~5700 | `run_one_script` — calls `_collect_and_save_results` after script done |
| `main.py` | ~3253 | `GET /api/executions/{id}/dashboard` |
| `main.py` | ~3270 | `GET /api/executions/{id}/excel` |
| `main.py` | ~3286 | `GET /api/testcases/summary` |
| `main.py` | ~3305 | `GET /api/testcases/history` |
| `static/app.js` | `startExecution()` | Passes `min_topology` in `scriptsWithCount` |
| `main.py` | pre-analysis ~5094 | Full path fix: `f"{_tests_dir}/{s_path}"` |
| `main.py` | `generate_master_testbed` | Derives `test_interface` from first topology link |

---

---

## Session 11 — 2026-06-19 — `_parse_spytest_script()` Vars-File Blindness Fix

### Problem (Execution #27 logs)

All 4 STP scripts still received `dut_count=1, min_topology=[]` after the Session 9/10
pre-analysis fixes, even though topology connections were loaded (3 pairs) and the YAML vars
files clearly specify 2-DUT requirements for some scripts.

### Root Cause — Regex mismatch in `_parse_spytest_script()`

`_parse_spytest_script()` (`main.py` ~4624) uses:
```python
min_topo_match = re.search(r'st\.ensure_min_topology\(([^)]+)\)', content)
topo_args = re.findall(r'["\']([^"\']+)["\']', args_str)  # looks for quoted strings
```

This only works for **inline literal** calls:
```python
st.ensure_min_topology("D1", "D1D2:2")   # ← matches ✓
```

Every STP script uses a **starred-variable** pattern instead:
```python
min_topology = defaults.get("min_topology") or ["D1D2:2"]
topology = st.ensure_min_topology(*min_topology)   # ← *min_topology → no quoted strings → []
```

`re.findall` on `*min_topology` returns `[]` → `dut_count` stays 1 for every script.

### Actual topology requirements (from YAML vars files)

The real `min_topology` lives in companion YAML files under `{tests_dir}/.../vars/`:

| Script | YAML vars file | `defaults.min_topology` | DUTs needed | Got (broken) |
|--------|---------------|------------------------|-------------|--------------|
| `test_stp_pvst_neg_001.py` | `vars_stp_pvst_neg_001.yaml` | `["D1"]` | 1 | 1 ✓ |
| `test_stp_pvst_neg_007_008.py` | `vars_stp_pvst_neg_007_008.yaml` | `["D1D2:2"]` | 2 | 1 ✗ |
| `test_stp_pvst_neg_009.py` | `vars_stp_pvst_neg_009.yaml` | `["D1"]` | 1 | 1 ✓ |
| `test_stp_pvst_pos_001.py` | `vars_stp_pvst_pos_001.yaml` | `["D1D2:2"]` | 2 | 1 ✗ |

YAML vars path convention:
```
Script:  {tests_dir}/automation/stp/scripts/test_stp_pvst_neg_007_008.py
Vars:    {tests_dir}/automation/stp/vars/vars_stp_pvst_neg_007_008.yaml
                                         ^^^^                 ^^^^
                               prefix changes from test_ to vars_
                               directory changes from scripts/ to vars/
```

### Fix applied (`main.py`)

#### Fix A — `_parse_spytest_script()` (~line 4640)
After the quoted-string findall returns empty, detect the starred-variable pattern and set
`uses_vars_file: True` flag:
```python
if not result["min_topology"]:
    if re.search(r'st\.ensure_min_topology\(\*\w+\)', content):
        result["uses_vars_file"] = True
```

#### Fix B — Pre-analysis block (~line 5578)
When `uses_vars_file` is set, derive the companion YAML path and SSH-read it:
```python
if info.get("uses_vars_file"):
    stem = re.sub(r'^test_', '', os.path.splitext(os.path.basename(s_path))[0])
    vars_path = f"{os.path.dirname(full_s_path)}/../vars/vars_{stem}.yaml"
    vars_out, _, vars_rc = coord_ssh.execute_command(f"cat '{vars_path}'", timeout=10)
    if vars_rc == 0:
        defaults_section = re.search(r'defaults:.*?(?=\n\w|\Z)', vars_out, re.DOTALL)
        if defaults_section:
            topo_items = re.findall(r'^\s*-\s*["\']([^"\']+)["\']',
                                    defaults_section.group(0), re.MULTILINE)
            if topo_items:
                info["min_topology"] = topo_items
                max_duts = max(
                    (max((int(d) for d in re.findall(r'D(\d+)', arg)), default=1)
                     for arg in topo_items), default=1)
                info["dut_count"] = max_duts
```

### Expected log after fix
```
[TOPO] test_stp_pvst_neg_001.py:     dut_count=1, min_topology=["D1"]
[TOPO] test_stp_pvst_neg_007_008.py: dut_count=2, min_topology=["D1D2:2"]
[TOPO] test_stp_pvst_neg_009.py:     dut_count=1, min_topology=["D1"]
[TOPO] test_stp_pvst_pos_001.py:     dut_count=2, min_topology=["D1D2:2"]
```

`test_stp_pvst_neg_007_008.py` and `test_stp_pvst_pos_001.py` will now receive 2-DUT
topology-aware allocation (link-combo matching) instead of a single-device testbed.

### Key rule
Scripts that load `min_topology` from a YAML vars file via `st.ensure_min_topology(*var)`
cannot be parsed by regex alone. Always derive and read the companion
`vars/vars_{stem}.yaml` when the starred-variable pattern is detected.

### Key file locations (Session 11)

| File | Lines | Purpose |
|------|-------|---------|
| `main.py` | ~4624 | `_parse_spytest_script()` — added `uses_vars_file` flag |
| `main.py` | ~5568 | Pre-analysis block — vars-file SSH read + `defaults:` section parse |

---

## Session 11 (continued) — Refresh Button Incomplete Reset

### Bug
Clicking the **Refresh** button on the "Categories & Scripts" card (`onSpyVMChange()` in `app.js`)
only cleared the scripts path input (`#scripts-base-path`) but left three UI elements stale:

| Element | ID | Problem |
|---|---|---|
| "Current Path" breadcrumb | `#category-breadcrumb` | Kept showing last-navigated folder path |
| Subfolders count badge | `#subfolder-count` | Kept showing old count (e.g. "5") |
| Test Scripts count badge | `#scripts-count` | Kept showing old count |

### Root Cause
`onSpyVMChange()` called `updateBreadcrumb()` nowhere — `currentFolderPath` was cleared to `''`
in the JS variable but the DOM breadcrumb was never re-rendered. The two count badges have no
dedicated reset call; they are only updated inside `navigateToPath()` after a successful API
response.

### Fix — `static/app.js` `onSpyVMChange()` reset block
Added three lines after the subfolder `innerHTML` reset:
```javascript
updateBreadcrumb('');                                          // re-renders breadcrumb as "Home" only
document.getElementById('subfolder-count').textContent = '0'; // reset count badge
document.getElementById('scripts-count').textContent   = '0'; // reset count badge
```

### Key file location
| File | Lines | Purpose |
|---|---|---|
| `static/app.js` | `onSpyVMChange()` reset block | Added `updateBreadcrumb('')` + count badge resets |

---

## Session 12 — 2026-06-19 — Subset Testbed Device Name Remapping Fix

### Problem (Execution #28 logs)

SPyTest logs showed `Topology unknown: D1D2:2` for `test_stp_pvst_neg_007_008.py` even
though the allocation correctly gave it 2 DUTs (D3, D2). The script then failed because
`st.ensure_min_topology("D1D2:2")` could not find a device named **D1** in the testbed
(the subset testbed had devices named D3 and D2, not D1 and D2).

Evidence from SPyTest thread labels:
```
[D1-D2] Connecting to device (D2): sonic_ssh: 192.168.100.207:22
[D2-D3] Connecting to device (D3): sonic_ssh: 192.168.100.209:22
```
The `[D1-D2]` label indicates D2's topology entry still referenced an EndDevice named D1
(not fully filtered), AND that SPyTest was treating the physical names literally — it needed
a device actually named D1 to satisfy `ensure_min_topology("D1D2:2")`.

### Root Cause

`_create_subset_testbed()` copied physical device names (D3, D2) into the temp testbed as-is.
SPyTest `ensure_min_topology("D1D2:2")` performs a **literal device-name check** — it looks
for a device named D1 and a device named D2 in the testbed. If the allocated devices are D3
and D2, D1 is absent → topology check fails → tests skipped/failed.

### Fix (`main.py` `_create_subset_testbed`)

Devices are now **renamed** to sequential logical names based on allocation order:
```
Allocated: [D3, D2]
Remap:  D3 → D1 (first allocated)
        D2 → D2 (second allocated)
```

For each physical device in the allocation:
1. Create logical name `D{i+1}` (1-indexed position)
2. Copy device entry (IP, credentials) under logical name
3. Rewrite `EndDevice` in topology interfaces to use logical name of the peer
4. Rebuild `params.topo` to reflect only the subset links with logical names

#### Example: Allocation [D3, D2] for `D1D2:2` requirement

**Before fix** (temp testbed):
```yaml
devices: {D3: {ip: 192.168.100.209}, D2: {ip: 192.168.100.207}}
topology:
  D3: {interfaces: {Eth0: {EndDevice: D2, EndPort: Eth0}, Eth1: {EndDevice: D2, EndPort: Eth1}}}
  D2: {interfaces: {Eth0: {EndDevice: D3, EndPort: Eth0}, Eth1: {EndDevice: D3, EndPort: Eth1}}}
params: {topo: {D1D2: 1, D2D3: 2, D1D3: 1}}   # full master topo, wrong for subset
```
→ `ensure_min_topology("D1D2:2")` fails: no device named D1

**After fix** (temp testbed):
```yaml
devices: {D1: {ip: 192.168.100.209}, D2: {ip: 192.168.100.207}}
topology:
  D1: {interfaces: {Eth0: {EndDevice: D2, EndPort: Eth0}, Eth1: {EndDevice: D2, EndPort: Eth1}}}
  D2: {interfaces: {Eth0: {EndDevice: D1, EndPort: Eth0}, Eth1: {EndDevice: D1, EndPort: Eth1}}}
params: {topo: {D1D2: 2}}   # only links in this subset
```
→ `ensure_min_topology("D1D2:2")` passes: D1 and D2 exist with 2 links

### Key rule
Always remap physical DUT names to sequential logical names (D1, D2, D3…) in per-script
temp testbeds. SPyTest scripts refer to testbed devices by literal name (D1, D2, etc.) in
`st.ensure_min_topology()`. The physical pool names are irrelevant to the script.

### Key file location (Session 12)

| File | Lines | Purpose |
|---|---|---|
| `main.py` | ~5883 | `_create_subset_testbed()` — physical→logical device name remapping |

---

## Session 13 — 2026-06-19 — `test_interface` Missing from `global.params`

### Symptom
Execution #29 ran both scripts (neg_001 and neg_009) for ~652 seconds, but **all test cases were XFAIL** and the SPyTest log showed:
```
Report(Fail):: test_interface not defined in testbed global params @112
Report(Fail):: test_interface not defined in testbed global.params @115
```
After the class-prolog failure, SPyTest collected tech-support from the device (~600s), explaining the long runtime with zero actual test results.

### Root Cause
SPyTest's `get_param("test_interface")` reads from `self.global_params`, which is **only populated** from the `global.params` YAML key:

```python
# spytest/testbed.py line 775-776
if "global" in obj and "params" in obj["global"]:
    self.global_params = obj["global"]["params"]
```

Our `generate_master_testbed()` was placing `test_interface` in the **top-level** `params` section:
```yaml
params:
  topo: {D1D2: 2, D1D3: 2, D2D3: 2}
  test_interface: Ethernet0   # ← wrong key: get_param() can't see this
```

The reference testbed (`ztp_standalone.yaml`) shows the correct format:
```yaml
params: {}
global:
  params:
    test_interface: "Ethernet8"   # ← correct: get_param() reads from here
```

### Fix
**`generate_master_testbed()`** — remove `test_interface` from `params_section` and put it in a `global.params` key instead:
```python
params_section = {"topo": topo_dict if topo_dict else {}}
master_config = {"params": params_section, ...}
if test_interface:
    master_config["global"] = {"params": {"test_interface": test_interface}}
```

**`_create_subset_testbed()`** — pass the `global` section through from master to subset; also handle old master testbeds that still have `test_interface` in top-level params (backward compat):
```python
if "global" in full_config:
    result["global"] = full_config["global"]
elif "test_interface" in master_params:
    result["global"] = {"params": {"test_interface": master_params["test_interface"]}}
```

### Key rule
`test_interface` (and any user-facing params read by SPyTest scripts via `st.get_param()`) **must** live under `global.params`, NOT under the top-level `params` key. The top-level `params.topo` is read by SPyTest's internal topology engine, not by `get_param()`.

### Key file locations (Session 13)

| File | Lines | Purpose |
|---|---|---|
| `main.py` | ~6372–6388 | `generate_master_testbed()` — writes `global.params.test_interface` |
| `main.py` | ~5954–5960 | `_create_subset_testbed()` — copies `global` section to subset |
| `spytest/testbed.py` | 775–776 | SPyTest reads `global.params` into `self.global_params` |

---

## Session 14 — 2026-06-23 — "Failed to cancel: Execution not found" when unselecting a script

### Symptom
After a run finishes (or after the user deletes the execution from the Logs tab), unchecking a
script in the "Test Scripts" dropdown pops the **Cancel script?** confirmation, and confirming it
shows the red toast:
```
Failed to cancel: Execution not found
```
No script is actually cancelled — the checkbox stays as it was.

### Root cause (confirmed from `uvicorn.log`, execution #55)

The exact event sequence:
```
12:25:55  [LOGS] Deleted 175 logs for execution 55 (scope: all)
12:25:55  [LOGS] Deleted execution record 55
12:25:55  DELETE /api/executions/55/logs            → 200 OK   ← Execution row removed from DB
12:25:xx  POST   /api/executions/55/cancel-script   → 404 Not Found  (×5)
```

1. Execution #55 had already completed (a legacy run with `NULL session_id`).
2. The user deleted it from the Logs tab → `DELETE /api/executions/55/logs` removes both the
   `execution_logs` rows **and** the `Execution` record itself.
3. The frontend global **`currentExecId` is never cleared** — it still holds `55`.
4. `onScriptCheckboxChange()` (`static/app.js` ~2247) guards the cancel flow with:
   ```javascript
   if (!cb.checked && currentExecId) {   // ← treats truthy currentExecId as "execution running"
       cb.checked = true;                 // re-check, then ask to confirm cancel
       showCancelConfirmation(scriptName);
       return;
   }
   ```
   `currentExecId` is used as a proxy for *"an execution is actively running"*, but it persists
   after the run finishes and after the row is deleted. So unchecking a script triggers a cancel
   against a stale id.
5. `confirmCancelScript()` POSTs to `/api/executions/55/cancel-script`. The backend
   (`main.py` ~5418, `cancel_script_from_execution`) does
   `db.query(Execution).filter(Execution.id == 55).first()` → `None` →
   `raise HTTPException(404, "Execution not found")`. The frontend surfaces it as
   `Failed to cancel: ${err.detail}` (`app.js` ~3017).

### Why the guard is wrong
`currentExecId` answers "which execution did this tab last touch?", **not** "is an execution
running right now?". It survives:
- execution completion (kept so the user can view results / download reports), and
- execution deletion (nothing resets it when the row is removed via the Logs tab).

Any later unselect within the same Execute-tab session therefore mis-fires the in-flight
cancel-script path instead of a plain deselect.

### Fix applied — 2026-06-23 (`static/app.js`)
Introduced a `currentExecActive` boolean that is true **only** while the tracked execution is
running/pending, and gated the cancel flow on it instead of on mere id presence:

| Location | Change |
|---|---|
| top of file (~line 6) | New global `let currentExecActive = false;` |
| `onScriptCheckboxChange()` (~2247) | Guard changed to `if (!cb.checked && currentExecId && currentExecActive)` — unchecking a script after a run finished is now a plain deselect, not a cancel |
| `startExecution()` (~2576) | Sets `currentExecActive = true` right after `currentExecId` is assigned |
| WS `execution_complete` handler (~2631) | Sets `currentExecActive = false` when the run ends |
| `_syncExecutionView()` (~1469) | Sets `currentExecActive` from the restored execution's status (true only for running/pending) so job-switch / poll restores it correctly |
| `deleteLogs()` (~3685) | When the deleted execution equals `currentExecId`, resets `currentExecId = null` and `currentExecActive = false` so the stale pointer can't be reused |

Net result: the cancel-script call only fires against a genuinely live execution, so the
"Failed to cancel: Execution not found" toast no longer appears after a run completes or after
the execution is deleted from the Logs tab.

> Optional backend hardening (not done): `cancel_script_from_execution` could return a benign
> `{"status": "noop"}` instead of 404 for a missing execution. The frontend gate is the real fix;
> this would only soften any remaining edge case.

---

## Session 15 — 2026-06-23 — Execute tab overflow scrollers + running-only live logs

Two UX issues when a job runs hundreds of scripts.

### 15a — Queue & Status / Live Results panels overflow the page
With 100s of scripts the **Queue & Status** script list and the **Live Results** table grew
unbounded, pushing the rest of the Execute tab off-screen.

| File | Change |
|---|---|
| `static/index.html` | `#queue-scripts-list` got `max-height:320px; overflow-y:auto; padding-right:4px` |
| `static/index.html` | Live Results `<table>` wrapped in `<div class="live-results-scroll">` |
| `static/style.css` | New `.live-results-scroll { max-height:360px; overflow-y:auto }` + sticky `thead th` (`position:sticky; top:0; background:var(--bg-tertiary)`) so the header stays pinned while rows scroll |

### 15b — Live Execution Logs should show only running scripts
Previously every script kept its log pane open (completed ones auto-hid only after a 5-minute
timer, and only if the user had clicked "Show Only Running"). With many scripts the section
became an unreadable wall. Now **only running scripts are shown** — a script's pane is hidden the
instant it completes.

| File | Change |
|---|---|
| `static/app.js` | `showOnlyRunning` now defaults to `true` (global init + reset block at execution start) |
| `static/app.js` | `appendLogEntry()` — on the tick a script is first detected complete, its pane gets `log-pane-hidden` immediately (replaced the old 5-min `setAutoHideScriptLog` call; that helper is now unused) |
| `static/app.js` | `renderLogs()` — after a full rebuild, re-hides any pane whose script is in `completedScripts` (rebuilt panes start visible) |
| `static/app.js` | `toggleShowOnlyRunning()` — uses `classList.toggle('active', showOnlyRunning)`, updates icon + new `#show-only-running-label` text ("Show All" ⇄ "Show Only Running") |
| `static/index.html` | Button default label is now **Show All** (icon `visibility`); clicking it reveals completed panes |

Net: while a run is in progress the logs section shows only the scripts still executing; the user
can click **Show All** to bring back completed panes. The cancel-checkbox flow already hides a
cancelled script's pane via `log-pane-hidden` (unchanged).

---

## Session 16 — 2026-06-23 — Switching jobs "never updates" while an execution is running

### Symptom
Before any execution runs, picking another job from the dropdown correctly re-renders every Execute-tab
panel (device hub, Topology Canvas, Categories & Scripts, Queue & Status, Live Results, Live Execution
Logs). **While a job is running**, switching jobs does nothing — all panels stay frozen on the running
job, and they stay frozen even after the run finishes, until the user reloads the page. No error toast
appears.

### Root cause — an awaited save that hangs *outside* the try block
`switchJob()` (`static/app.js`) opened with:
```javascript
async function switchJob(newId) {
    if (!newId) return;
    if (activeJobId && activeJobId !== newId) {
        await saveJobState(true);   // ← PUT /api/execution-jobs/{id}, AWAITED, OUTSIDE the try below
    }
    try {
        const res = await fetch(`/api/execution-jobs/${newId}`, ...);   // GET — inside try
        ... restore + render every panel ...
        _syncExecutionView(latestExec, data.scripts);
    } catch (e) { toast('Failed to switch job: ' + e.message, 'error'); }
}
```
The leading `await saveJobState(true)` is a PUT that runs **before** the `try` and before any panel
re-render. While an execution is running the server is under load, and this PUT stalled — so
`switchJob()` suspended at that line and never reached the GET or any render. Because the stall is
*outside* the `try`, there was **no error toast** (a hang on the GET inside the `try` would have shown
"Failed to switch job" — which the user did NOT see, confirming the stall is the save, not the load).
A page reload resets the stuck JS promise, which is why only reload — not waiting — restored switching.

The execution viewer is a single set of globals (`ws`, `_queuePollTimer`, `allLogs`, the shared panels),
re-pointed by `_syncExecutionView()` at the END of `switchJob()`. Because `switchJob()` never got there,
the previous job's viewer (and all the per-job panels) stayed exactly as they were → "static in all jobs."

### Fix applied — 2026-06-23 (`static/app.js`, `switchJob()`)
| Change | Why |
|---|---|
| The outgoing-job flush is now **fire-and-forget** (`if (activeJobId) saveJobState(true);` — no `await`) | State is already debounce-saved on every change, and a running execution doesn't mutate the selection, so awaiting it gains nothing but can hang the whole switch. `saveJobState()` reads the globals synchronously to build the request body before it awaits, so the outgoing values are still captured correctly even though the globals are overwritten immediately after. |
| Early-return guard tightened to `if (!newId \|\| newId === activeJobId) return;` | Skips redundant work when re-selecting the current job. |
| The job `GET` is wrapped in an `AbortController` with a 15 s timeout | A wedged load can no longer leave the viewer stuck forever — it aborts into the existing `catch` and surfaces a real error instead of a silent freeze. |

Result: switching jobs mid-run now tears down the running job's viewer and restores the selected job's
panels immediately; the previous-job save still happens in the background.

> Follow-up worth checking: *why* the PUT stalled under execution load in the first place (DB-pool /
> anyio-threadpool contention while `_run_spytest_execution` and its per-script threads run). The
> frontend fix stops the hang from freezing the UI, but reducing that server-side contention is the
> deeper item (related to the Session-`perf_slowdown_fix` work).

---

## Session 17 — 2026-06-23 — "Stop" shows stopped but the execution keeps running

### Symptom
Clicking **Stop** on a running job flips the UI to stopped, but the scripts keep running on the VM —
the remote SPyTest processes finish normally and results still get collected.

### Root cause — Stop was purely client-side
`stopExecution()` (`static/app.js`) only closed the WebSocket, stopped the queue poll, and hid the
panels (its toast even said "Execution **monitoring** stopped"). **It never called the backend.** And
there was **no stop endpoint at all** — the only cancellation primitive, `_mark_script_for_cancel()` /
`_pending_scripts[...]["to_cancel"]`, was *written but never read* by the worker loop, so even
per-script cancel did nothing to the remote process. Each script runs as a remote
`nohup … & echo $!` background process polled every 10 s with `kill -0 <pid>`; nothing ever killed it
on user request.

### Fix applied — 2026-06-23

**Backend (`main.py`):**
| Change | Detail |
|---|---|
| Cancel registry | New `_exec_cancel` set + `_request_exec_cancel` / `_is_exec_cancelled` / `_clear_exec_cancel` (lock-guarded), and an `ExecutionCancelled` exception |
| `POST /api/executions/{id}/stop` | New endpoint: sets the cancel flag, logs the stop, and **best-effort immediately SSH-kills** the running PIDs (host resolved via `ExecutionJob.host_id`) so scripts die now instead of at the next poll tick |
| Worker poll loop | Each 10 s iteration checks the cancel flag → `kill -TERM`/`-KILL` the remote PID, marks the script `cancelled`, breaks, and skips the "completed"/result-collection path |
| `acquire_duts()` | Checks the cancel flag in its wait loop → raises `ExecutionCancelled` so a *queued* (not-yet-running) script aborts instead of blocking |
| Finalizer | Records the execution **and parent job** as `cancelled` (not `completed`) when the flag is set; clears the flag on both success and error paths |
| Execution-WS | `cancelled` added to the terminal-status set so the `execution_complete` event fires (previously only `completed`/`failed`) |

**Frontend (`static/app.js`, `static/style.css`):**
| Change | Detail |
|---|---|
| `stopExecution()` | Now `async`: confirms, `POST`s to `/api/executions/{id}/stop`, sets `currentExecActive=false`, flips the badge to "stopping", and keeps the WS open so the final `execution_complete (cancelled)` resets the UI cleanly |
| `execution_complete` handler | `_updateJobStatusBadge(data.status)` instead of a hard-coded `'completed'` (so failed/cancelled runs no longer show a green job badge) |
| `style.css` | Added `.job-status-badge.cancelled` / `.stopping` (amber) |

Worst-case kill latency is ≤10 s (the poll interval) for non-job manual runs; job-based runs are killed
immediately by the endpoint's SSH kill.

> Related latent bug (not fixed here): per-script cancel (`to_cancel`) is still never consumed by the
> worker loop, so the **cancel-script** flow only updates the queue display — it doesn't kill that one
> script's remote process. Wiring the poll loop to also honor `to_cancel` per script would close that gap.

### Key file locations (Session 14)
| File | Lines | Purpose |
|---|---|---|
| `static/app.js` | ~2247 | `onScriptCheckboxChange()` — stale `currentExecId` guard that mis-fires cancel |
| `static/app.js` | ~3000 | `confirmCancelScript()` — POSTs cancel-script, shows the error toast |
| `static/app.js` | ~3017 | `Failed to cancel: ${err.detail}` toast |
| `main.py` | ~5405–5432 | `cancel_script_from_execution()` — raises 404 when execution row is gone |
