# Plan: Live Execution Dashboard + Testcase History + Comparison

## Goal
1. **Live results** during execution — inside the Execute tab
2. **Download HTML dashboard + Excel report** from the Logs tab history
3. **Testcase-level history** — per test function, trend across runs — in the Dashboard tab
4. **Execution comparison** — pick any two runs, see what regressed / improved / is new
5. No new top-level tab is added anywhere

---

## 1. Database — new table + two new columns

### 1a. New table: `TestCaseResult`
Stores one row per individual test function per execution.
SpyTest's `results_*_functions.csv` columns map to this.

```
id              INTEGER  PK
execution_id    INTEGER  FK → executions.id
script_path     TEXT     e.g. routing/bgp/test_ipv4_bgp_link_flap.py
module          TEXT     same as script_path (Module column in CSV)
test_function   TEXT     e.g. TestBgpIpv4Basic.test_bgp_ipv4_configure_verify_unconfig
testcase_id     TEXT     test_function after stripping class prefix
result          TEXT     Pass / Fail / Skip / ScriptError
time_taken      TEXT     raw e.g. "0:00:17"
time_seconds    INTEGER  parsed seconds
description     TEXT     first sentence from Doc column
created_at      DATETIME
```

This is the source of truth for testcase history and comparison.

### 1b. Two new columns on `Execution`
| Column | Type | Purpose |
|---|---|---|
| `test_results` | `Text` (JSON) | Per-script aggregate: `[{script, status, passed, failed, skipped, duration_s}]` |
| `scripts_count` | `Integer` | How many scripts were in this execution |

---

## 2. Backend — `execute-service/main.py`

### 2a. After each script: fetch CSV from remote VM and parse it
`_run_spytest_background` is extended:

1. Add `--logs-path /tmp/eka_logs/{execution_id}/{script_stem}` to the spytest command
2. After the SSH command returns, SCP the `results_*_functions.csv` back to the Eka server
3. Parse the CSV rows → insert `TestCaseResult` rows into DB
4. Build per-script aggregate (pass/fail/skip counts) → append to `execution.test_results` JSON
5. Broadcast `script_result` WebSocket message with aggregate for live UI update

### 2b. New API endpoints

| Endpoint | Method | Returns |
|---|---|---|
| `/api/executions/{id}/results` | GET | JSON — per-script aggregate list |
| `/api/executions/{id}/testcases` | GET | JSON — full `TestCaseResult` rows for this execution |
| `/api/executions/{id}/dashboard` | GET | HTML file download |
| `/api/executions/{id}/excel` | GET | `.xlsx` file download (openpyxl) |
| `/api/testcases/history?function=<name>` | GET | JSON — last N results for one test function across all executions |
| `/api/executions/compare?a=<id>&b=<id>` | GET | JSON — side-by-side diff of testcases between two executions |

### 2c. Compare logic (`/api/executions/compare`)
Returns three groups:
- **Regressed** — Pass in run A, Fail/Skip in run B
- **Fixed** — Fail/Skip in run A, Pass in run B
- **New failures** — not in run A, Fail in run B
- **Stable pass / Stable fail / Stable skip** — same result both runs

### 2d. `requirements.txt` — add `openpyxl`

---

## 3. Frontend — all inside existing tabs

### 3a. Execute tab — "Live Results" panel
New card inserted between "Queue & Status" and "Live Execution Logs". Hidden until execution starts.

```
┌─ Live Results ─────────────────────────── [Download HTML] [Download Excel] ─┐
│  ██████████████░░░░  8 passed  2 failed  1 skipped  of 14 total             │
│                                                                               │
│  Script name                 Status     Pass  Fail  Skip  Duration           │
│  ─────────────────────────── ─────────  ────  ────  ────  ────────           │
│  test_ipv4_bgp_link_flap     ✓ passed    5     0     0    0:01:24            │
│  test_bgp_daemon_restart     ✗ failed    3     2     0    0:02:11            │
│  test_ipv6_bgp_loopback      ⟳ running  –     –     –    –                  │
│  test_ipv4_bgp_route_ref…    ◌ queued   –     –     –    –                  │
└───────────────────────────────────────────────────────────────────────────────┘
```

- Updated on each `script_result` WebSocket message (real-time, no polling)
- Download buttons activate only after execution completes
- Script name truncated with ellipsis if long

### 3b. Logs tab — Execution History table
Two changes to the existing table:

1. **Results column** (after Status): `✓8 ✗2 ↷1` compact counts from `test_results`
2. **Actions column** gains two icon buttons: `[⬇ HTML]` and `[⬇ XLS]`
3. **Compare mode**: a checkbox column on the left; selecting exactly 2 rows shows a
   `Compare Selected` button in the card header. Clicking opens a full-width comparison panel
   below the table (not a modal, stays in the same view).

```
┌─ Execution History ──────────────────── [↻ Refresh] [Compare Selected] ────┐
│ ☐  ID   Name                  Type     Status   Results    Duration  Reports │
│ ☑  #14  spytest_20260612_10…  spytest  completed ✓8 ✗2 ↷1  4m 12s  ⬇H ⬇X  │
│ ☑  #11  spytest_20260611_09…  spytest  completed ✓6 ✗4 ↷1  5m 03s  ⬇H ⬇X  │
│ ☐  #9   spytest_20260610_14…  spytest  failed    ✓3 ✗7 ↷0  3m 44s  ⬇H ⬇X  │
└─────────────────────────────────────────────────────────────────────────────┘

┌─ Comparison: Run #14 vs Run #11 ───────────────────────────────────────────┐
│  REGRESSED (2)     test name                  #14      #11                  │
│  🔴                test_bgp_negative_nexthop  Pass  →  Fail                 │
│  🔴                test_bgp_negative_asn      Pass  →  Fail                 │
│                                                                               │
│  FIXED (1)                                                                   │
│  🟢                test_bgp_loopback_ipv6     Fail  →  Pass                 │
│                                                                               │
│  STABLE PASS (6)   test_bgp_link_flap … +5 more                             │
│  STABLE FAIL (1)   test_bgp_route_reflector                                 │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3c. Dashboard tab — "Testcase History" card (new card, same tab)
The **"Recent Executions" card is removed entirely** from the Dashboard tab.
The Devices card is now full-width. Testcase History is added below it.

```
┌─ Testcase History (last 10 runs) ─────────────────── [🔍 Filter by name] ──┐
│  Test Function                        Last 5 runs         Trend             │
│  ─────────────────────────────────────────────────────────────────────      │
│  test_bgp_link_flap_ipv4              ✓ ✓ ✓ ✓ ✓           Stable ✓         │
│  test_bgp_daemon_restart_ipv6         ✓ ✓ ✗ ✓ ✗           Flaky  ⚠         │
│  test_bgp_negative_nexthop_ipv4       ✓ ✓ ✓ ✗ ✗           Regressing 🔴    │
│  test_ipv6_bgp_route_reflector        ✗ ✗ ✗ ✓ ✓           Fixing  🟢        │
└─────────────────────────────────────────────────────────────────────────────┘
```

- Trend logic: last 5 results → all pass = Stable ✓, last 2 fail after passes = Regressing,
  last 2 pass after fails = Fixing, alternating = Flaky
- Filter input narrows by test function name
- Clicking a row opens a mini popover showing the full run-by-run history (execution ID,
  date, result, duration) — no modal, no new tab

---

## 4. Files changed

| File | Change |
|---|---|
| `services/execute-service/main.py` | `TestCaseResult` model, new columns, CSV parse + SCP after each script, 6 new endpoints |
| `services/execute-service/requirements.txt` | Add `openpyxl` |
| `static/index.html` | Live Results card (Execute tab); Compare checkbox + panel (Logs tab); Testcase History card (Dashboard tab) |
| `static/app.js` | `script_result` WS handler, live results updater, `downloadReport()`, comparison UI, testcase history loader, trend calculator |

---

## 5. Full data flow

```
SpyTest runs on remote VM
  └─ writes results_*_functions.csv to /tmp/eka_logs/{exec_id}/{script}/

Backend (after each script)
  ├─ SCP csv back to Eka server
  ├─ Parse rows → insert TestCaseResult rows
  ├─ Aggregate P/F/S → update execution.test_results JSON
  └─ Broadcast WS: { type:"script_result", script, passed, failed, skipped }

Frontend (Execute tab)
  └─ Receives WS → updates Live Results table row in real-time

User opens Logs tab
  └─ loadExecutions() renders P/F/S counts + [HTML] [Excel] buttons

User ticks 2 checkboxes → clicks Compare
  └─ GET /api/executions/compare?a=14&b=11
  └─ Renders Regressed / Fixed / Stable sections inline

User opens Dashboard tab
  └─ Testcase History card loads top N testcases with trend dots
     └─ Click row → popover with per-run history
  (Recent Executions card is unchanged — no progress bar enhancement)
```

---

## 6. Out of scope
- No new nav tab
- Auth / session logic unchanged
- VS, Hardware-Load, Terminal tabs untouched
- `generate_graphical_dashboard.py` and `generate_failure_analysis.py` in DOC/ are NOT
  changed — backend ports the core CSV parsing logic inline

---

## Approval checklist
- [ ] Plan approved
- [ ] No new nav tab
- [ ] Recent Executions card in Dashboard tab is NOT modified (left as-is)
- [ ] Testcase History card lands in Dashboard tab (not a new tab)
- [ ] Comparison panel is inline in Logs tab (no modal, no new tab)
- [ ] Live results panel is inside Execute tab only (with Download HTML + Excel buttons)
