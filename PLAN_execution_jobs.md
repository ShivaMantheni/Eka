# Execution Jobs — Implementation Plan
## Eka v3.2 | Execute Tab Job Management

---

## Implementation Status — COMPLETE ✅

**Completed:** 2026-06-19 (v3.2 branch)
**Bug fixes:** 2026-06-22

| Step | Description | Status | What Changed |
|------|-------------|--------|--------------|
| 1 | Migration file `005_execution_jobs.py` | ✅ Done | New file: `migrations/005_execution_jobs.py` — creates `execution_jobs` table, adds `executions.job_id`, `dut_locks.lock_type`; supports both SQLite and PostgreSQL |
| 2 | ORM model `ExecutionJob` + `Execution.job_id` + `DUTLock.lock_type` | ✅ Done | `main.py` line 355: new `ExecutionJob` model; `Execution` gets `job_id = Column(Integer, nullable=True, index=True)`; `DUTLock` gets `lock_type = Column(String(10), default='exec')` |
| 3 | CRUD endpoints (create/list/get/update/delete) | ✅ Done | `main.py` lines 6183–6290: `POST /api/execution-jobs`, `GET /api/execution-jobs`, `GET /api/execution-jobs/{id}`, `PUT /api/execution-jobs/{id}`, `DELETE /api/execution-jobs/{id}` |
| 4 | Conflict-check endpoint | ✅ Done | `main.py` line 6291: `GET /api/execution-jobs/{id}/conflicts?dut_ids=...` — returns list of DUTs claimed by another active job with job name |
| 5 | Stamp `job_id` in `_run_spytest_execution()` + job status updates | ✅ Done | `start_spytest_execution()` reads `job_id` from body, stamps `Execution.job_id`, sets job status `running` on launch, `completed` when all scripts finish |
| 6 | Job-aggregated report endpoints (html + excel) | ✅ Done | `main.py` lines 6324–6370: `GET /api/execution-jobs/{id}/report/html` and `/report/excel` — merges all `TestCaseResult` rows from all executions in the job |
| 7 | Job header bar HTML + CSS | ✅ Done | `index.html` line 251: `.job-header-bar` div with dropdown, status badge, New Job / Rename / Delete buttons, conflict banner. `style.css` lines 3169–3216: all `.job-*` and `.conflict-banner` styles |
| 8 | `createJob`, `switchJob`, `saveJobState`, `renderJobDropdown` JS | ✅ Done | `app.js` lines 1337–1560: `activeJobId`, `activeJobList`, `_jobSaveTimer` globals; all 9 job management functions (`loadJobs`, `renderJobDropdown`, `createJob`, `switchJob`, `saveJobState`, `renameActiveJob`, `deleteActiveJob`, `checkDUTConflicts`, `downloadJobReport`, `_updateJobStatusBadge`) |
| 9 | Wire DUT checkbox to `checkDUTConflicts()` + auto-save | ✅ Done | `app.js` lines 1252–1257: after DUT check/uncheck, calls `checkDUTConflicts([numId])` and `saveJobState()` (debounced 500ms) |
| 10 | Pass `job_id` in `startExecution()` + status badge update | ✅ Done | `app.js` `startExecution()`: adds `job_id: activeJobId` to request body; calls `_updateJobStatusBadge('running')` on start, `'completed'` on finish |
| 11 | Job report buttons in Live Results panel | ✅ Done | `index.html` lines 637–646: `btn-job-html` and `btn-job-excel` buttons hidden until execution completes, then shown via `app.js` |
| 12 | Auto-create Job-1 on Execute tab open | ✅ Done | `app.js` line 724: `switchTab('execute')` calls `loadJobs().then(...)` — if no jobs exist, auto-calls `createJob()` |
| 13 | Startup column migration (idempotent) | ✅ Done | `main.py` lines 372–406: `_apply_column_migrations()` adds `executions.job_id` and `dut_locks.lock_type` on startup using `ADD COLUMN IF NOT EXISTS` (PostgreSQL) / try-except (SQLite) |

---

## Bug Fixes (2026-06-22)

### BF-1 — Job stuck on "running" forever

**Root causes:**
1. `_run_spytest_execution` exception handler set `Execution.status = "failed"` but never updated `ExecutionJob.status` — job stayed `running` in DB indefinitely.
2. Startup cleanup reset stuck `Execution` rows but ignored stuck `ExecutionJob` rows — server restart didn't help.
3. No UI escape hatch to manually unblock a stuck job.

**Fixes:**
| File | Change |
|------|--------|
| `main.py` | Exception handler in `_run_spytest_execution` now also sets `ExecutionJob.status = "failed"` when `job_id` is present |
| `main.py` | Startup cleanup (`_cleanup_stuck_jobs`) now queries `ExecutionJob` rows with `status = "running"` and marks them `"failed"` |
| `static/index.html` | Added amber **Reset** button (`btn-reset-job`) next to the status badge — hidden unless badge shows `running` |
| `static/app.js` | `_updateJobStatusBadge()` shows/hides the Reset button based on status; `resetJobToIdle()` sends `PUT /api/execution-jobs/{id}` with `{status: "idle"}` |

---

### BF-2 — Scheduled job fires but nothing runs (devices/scripts/VM selected, still no execution)

**Root causes:**
1. `saveJobState()` never saved the testbed file path — scheduler had no idea which testbed YAML to use on the VM.
2. Scheduler's old testbed generation used a heredoc inside a single paramiko `exec_command` call (`cat > file << 'EOFYAML'`), which does not work — the write always silently failed, leaving `testbed_file = "master_testbed.yaml"` (bare filename). `_run_spytest_execution` then tried to read `{testbed_dir}/master_testbed.yaml`, which didn't exist, and the execution failed immediately with "Cannot read testbed".
3. Even if the write had succeeded, the generated YAML was in the wrong format — missing `version: "2.0"`, `topology`, `services`, and other sections SPyTest requires.

**Fixes:**
| File | Change |
|------|--------|
| `main.py` | Added `testbed_path = Column(Text, nullable=True)` to `ExecutionJob` model |
| `main.py` | `_apply_column_migrations()` now adds `testbed_path TEXT` column to `execution_jobs` on startup |
| `main.py` | `update_execution_job` (`PUT /api/execution-jobs/{id}`) now accepts and persists `testbed_path` |
| `main.py` | `get_execution_job` (`GET /api/execution-jobs/{id}`) now returns `testbed_path` |
| `main.py` | `_trigger_scheduled_job` now: (1) reads `job.testbed_path` from DB first; (2) if missing, generates a proper `version: "2.0"` testbed YAML via `base64 -d >` pipe (same technique as `generate_master_testbed`); (3) persists the generated path back to the job for reuse; (4) aborts with a clear log message if no testbed path can be established |
| `static/app.js` | After `startExecution()` succeeds, immediately saves `generatedTestbedPath` to the job via `PUT /api/execution-jobs/{activeJobId}` with `{testbed_path}` |

**Recommended flow for first scheduled run**: Run the job manually once — this auto-generates the testbed and saves its VM path to the job record. All subsequent scheduled runs reuse that path without regenerating.

---

### BF-3 — Script selections never saved to job record (scheduler always skips)

**Root cause:**
`onScriptCheckboxChange()` and `toggleAllScripts()` updated `selectedScriptPaths` in memory but never called `saveJobState()`. The only time scripts reached the DB was on `loadScriptsFromPath()` (at that point scripts weren't selected yet, so `[]` was saved) or on `switchJob()`. The scheduler read `job.scripts = []`, hit the guard `if not host_id or not scripts → return`, and silently skipped — no execution was created, the badge stayed `idle`, and the user saw nothing.

**Fix — 2026-06-22:**
| File | Change |
|------|--------|
| `static/app.js` | Added `saveJobState()` at the end of `onScriptCheckboxChange()` — every individual script check/uncheck now debounces a state save (500 ms) |
| `static/app.js` | Added `saveJobState()` at the end of `toggleAllScripts()` — selecting/deselecting all scripts also triggers a state save |

---

### BF-7 — Poller silently misses executions that fail before reaching `running` status

**Root cause:**
`_pollActiveJob()` only connected the WebSocket when `latestExec.status === 'running'`. If an execution went straight from `pending` → `failed` (e.g., SSH connection refused on the VM), the status was never `running` so the poller skipped it every 5 seconds — the user saw nothing, not even an error message. The same window problem existed for `pending`: if the poller fired in the brief moment between DB insert and the background thread setting the status to `running`, it would skip that poll tick.

**Fix — 2026-06-22:**
| File | Change |
|------|--------|
| `static/app.js` | `_pollActiveJob()` now handles three cases for a new execution: `pending` or `running` → connect WebSocket and show logs normally; `failed` → show an error toast directing the user to the Logs tab. The outer guard on `data.status === 'running'` was also removed so the poller checks executions regardless of the job-level status |

---

### BF-6 — "Next run" label disappears 5 seconds after opening the Execute tab

**Root cause:**
`_pollActiveJob()` (called every 5 s) fetches `GET /api/execution-jobs/{id}` and passes the response to `_renderNextRunLabel(data)`. That endpoint did not include a `next_run` field, so `data.next_run` was always `undefined`, causing `_renderNextRunLabel` to hide the "⏰ Next: …" label. The user saw the next-run time briefly after saving the schedule (from the `PUT` response), then it vanished 5 seconds later.

**Fix — 2026-06-22:**
| File | Change |
|------|--------|
| `main.py` | `get_execution_job` (`GET /api/execution-jobs/{id}`) now queries APScheduler for `ap_job.next_run_time` and returns it as `"next_run"` — same logic already used by the schedule-specific GET endpoint |

---

### BF-5 — `saveSchedule()` didn't flush job state before registering the schedule

**Root cause:**
`saveSchedule()` called `PUT /api/execution-jobs/{id}/schedule` immediately without waiting for the debounced `saveJobState()` timer (500 ms). If the user selected scripts and clicked Schedule within 500 ms — or if the debounce timer hadn't fired for any other reason — the DB still had stale/empty `scripts`, `host_id`, or `base_path` when APScheduler registered the job. The trigger fired against incomplete data and silently skipped.

**Fix — 2026-06-22:**
| File | Change |
|------|--------|
| `static/app.js` | Added `await saveJobState(true)` as the first line of `saveSchedule()` — forces an immediate (non-debounced) state flush before the schedule API call, guaranteeing the DB has the latest scripts, VM, DUTs, and base path |

---

### BF-4 — VM selection never saved to job record

**Root cause:**
`onSpyVMChange()` loaded testbeds and cleared script state but never called `saveJobState()`. `host_id` in the DB stayed `null` unless the user happened to check/uncheck a DUT after changing the VM. The scheduler guard `if not host_id or not scripts → return` then silently skipped execution.

**Fix — 2026-06-22:**
| File | Change |
|------|--------|
| `static/app.js` | Added `saveJobState()` at the end of `onSpyVMChange()` — saves the new `host_id` (and the now-cleared `scripts`/`base_path`) to the job record immediately after the VM dropdown changes |

---

### BF-8 — Switching jobs does not restore execution UI state

**Root cause:**
`switchJob()` restores DUT selection, topology, scripts, base path, and VM — but it never restores the *execution* half of the UI. When the user switches to a job that already ran (or is currently running), five things are wrong:

| Sub-issue | Symptom | Root cause |
|-----------|---------|------------|
| 8a | `currentExecId` still points to the previous job's execution | `switchJob()` never reads `data.executions[0]` to update `currentExecId` |
| 8b | Start/Stop buttons show wrong state | Not reset based on the new job's `executions[0].status` |
| 8c | Live results panel shows old job's script results (or is hidden when it should show) | `showLiveResultsPanel` / `hideLiveResultsPanel` never called during switch |
| 8d | Queue status panel not cleared | Not hidden/reset on switch; stale progress from previous job remains |
| 8e | Job report buttons (`btn-job-html`, `btn-job-excel`) hidden even if the job has completed runs | They are only revealed via the WS `execution_complete` event — never restored on switch |

**Fix — 2026-06-22:**
| File | Change |
|------|--------|
| `static/app.js` | In `switchJob()`, after state restoration: (1) set `currentExecId` and `_jobPollLastExecId` from `data.executions[0]`; (2) close any open WebSocket and stop queue polling from the previous job; (3) hide queue panel and ancillary run controls; (4) if latest exec is `running`/`pending` → reconnect WS + `startQueuePolling` + show Stop button, hide job report buttons; (5) if latest exec is `completed`/`failed` → show Start button + show job report buttons; (6) if no executions → show Start button, hide all run-specific UI |

---

### BF-9 — Script multi-select text label not updated on job switch

**Root cause:**
`switchJob()` correctly sets `selectedScriptPaths` from `data.scripts`, but `updateScriptMultiSelectText()` was missing. The dropdown label kept showing the previous job's script count ("3 scripts selected") even after switching to a different job with a different set of scripts.

**Fix — 2026-06-22:**
| File | Change |
|------|--------|
| `static/app.js` | `updateScriptMultiSelectText()` already added alongside `updateDUTMultiSelectText()` in the re-render block of `switchJob()` — confirmed present at line 1466 |

---

### BF-10 — Poller only watches the active job; background jobs change state silently

**Root cause:**
`_pollActiveJob()` fetches `GET /api/execution-jobs/{activeJobId}` only. When multiple jobs exist and a scheduled trigger fires on a **non-active** job (e.g. Job 2 fires at 7:30 PM while the user is watching Job 1), no fetch is made for Job 2 — zero toast, zero badge update, zero indication anything happened. The user has to manually switch the dropdown to discover the job ran or failed.

**Fix — 2026-06-22:**
| File | Change |
|------|--------|
| `static/app.js` | Added `_jobStatusSnapshot = {}` global — keyed by job id, holds last-known status |
| `static/app.js` | `loadJobs()` seeds `_jobStatusSnapshot` so the first sweep does not fire spurious toasts for pre-existing statuses |
| `static/app.js` | `_pollActiveJob()` calls `_sweepBackgroundJobs()` at the end of every 5 s tick |
| `static/app.js` | New `_sweepBackgroundJobs()`: fetches `GET /api/execution-jobs` (list), skips `activeJobId`, compares each job's current status against snapshot — fires a toast on `idle→running` ("started"), `running→completed` ("completed"), or `running→failed` ("failed"). Also refreshes `activeJobList` and re-renders the dropdown so all job badges stay current |

---

### BF-12 — Conflict warning is runtime-only; planning-level DUT overlap not detected

**Root cause:**
`check_job_conflicts` queries `DUTLock WHERE status != AVAILABLE AND lock_type = 'exec'`. DUTLock rows are only set to non-AVAILABLE **during an active execution** — they revert to AVAILABLE when the run ends. If DUT X is in Job 1's `dut_ids` (no execution running) and the user adds DUT X to Job 2, the lock is AVAILABLE so no conflict is reported. The user gets no warning about the planning-level overlap.

**Fix — 2026-06-22:**
| File | Change |
|------|--------|
| `main.py` | `check_job_conflicts` now runs two passes: (1) existing runtime check via `DUTLock` — returns `conflict_type: "runtime"`; (2) new planning check — queries `execution_jobs` for other session jobs with `status NOT IN ('completed','failed')` that contain the DUT id in their `dut_ids` JSON — returns `conflict_type: "planning"`. `seen_duts` set prevents double-reporting the same DUT |
| `static/app.js` | `checkDUTConflicts()` banner text now distinguishes types: runtime → "currently locked by Job X (execution running)"; planning → "already selected in Job X" |

---

### BF-11 — Live results panel blank after switching to a job that already completed

**Root cause:**
`switchJob()` (BF-8 fix) always calls `hideLiveResultsPanel()` for completed/failed jobs — the panel is blank and the user sees only the report buttons. Per-script result rows are lost because `showLiveResultsPanel()` requires a fresh script list and `updateLiveResults()` events from a WebSocket, neither of which replays on switch.

**Fix — 2026-06-22:**
| File | Change |
|------|--------|
| `main.py` | `get_execution_job` (`GET /api/execution-jobs/{id}`) now aggregates `TestCaseResult` rows per `script_path` inside each `executions[]` entry, returning `script_results: [{script_stem, passed, failed, skipped, duration_s, status}]` |
| `static/app.js` | New `_restoreLiveResultsPanel(latestExec, jobScripts)`: calls `showLiveResultsPanel()` to initialise rows, then replays each `script_results` entry via `updateLiveResults()` — reuses existing row-update logic. Download buttons enabled. |
| `static/app.js` | `switchJob()` completed/failed branch now calls `_restoreLiveResultsPanel(latestExec, data.scripts)` instead of `hideLiveResultsPanel()` |

---

### BF-13 — Execution viewer "stuck" on one job: switching jobs (or a scheduled run firing) doesn't update the execution page

**Symptom:**
1. Job-1 is scheduled. The user creates Job-2 with different devices/scripts. When Job-1's scheduled time arrives, the execution page still shows the previous job's details.
2. Selecting a different job from the dropdown does not change the execution page — it stays fixed on one job's run.

**Root cause:**
The Execute tab has exactly **one** execution viewer built on global state — `currentExecId`, `ws`, the logs panel (`#exec-log-container`/`allLogs`), the queue-status panel, and the live-results panel. Jobs were layered on top, but this single viewer was never made fully job-aware. `switchJob()` (BF-8) and `_pollActiveJob()` (BF-10) only *partially* re-point it, with the reset/restore logic **duplicated and incomplete** across the two paths:

| Gap | Detail |
|-----|--------|
| A | **Logs never cleared on switch (except when switching to a *running* job).** `switchJob()`'s completed/failed and no-execution branches never run `allLogs=[]; renderLogs()`, so the previous job's log lines stay on screen — the classic "still showing the fixed one." |
| B | **Queue panel stays hidden when switching to a running job.** `switchJob()` hides the queue panel unconditionally, then the running branch starts polling but never re-shows it. |
| C | **Background scheduled runs never bring the viewer to the firing job.** `_pollActiveJob()` only follows `activeJobId`; a scheduled run on a non-active job only fires a toast. When the user then switches to it, gaps A/B make it look stuck. |
| D | **Active job's own scheduled run isn't fully restored.** `_pollActiveJob()` connects the WebSocket but never calls `showLiveResultsPanel()` or shows the queue panel, so live results stay blank while logs stream. |

**Fix — 2026-06-22:**
| File | Change |
|------|--------|
| `static/app.js` | New single helper `_syncExecutionView(latestExec, jobScripts)` — the one source of truth for the execution viewer. Tears down the previous `ws`/queue polling, **always clears the logs panel**, then restores logs/queue panel/live-results/run buttons as a clean function of the selected job's latest execution (running → stream live + show queue panel + replay partial `script_results`; completed/failed → restore rows + report buttons; none → idle). |
| `static/app.js` | New `_jobScriptStems(latestExec, jobScripts)` helper — derives live-results row stems from `script_results` (preferred) or the job's saved `scripts` (fallback). |
| `static/app.js` | `switchJob()` BF-8 block replaced with a single `_syncExecutionView(latestExec, data.scripts)` call. |
| `static/app.js` | `_pollActiveJob()` running/pending branch replaced with `_syncExecutionView(latestExec, data.scripts)` so a scheduled run on the active job restores the full viewer (logs + queue + live results), not just logs. |

---

### BF-14 — "Categories & Scripts" panel not reset/restored on job switch

**Symptom:**
After switching jobs, the **Categories & Scripts** panel (subfolders, breadcrumb, Test Scripts dropdown, counts) keeps showing the *previous* job's folders and scripts. A fresh job with no saved path should show an empty panel; a job with a saved path should show its own scripts.

**Root cause:**
`switchJob()` restored the script *paths* into `selectedScriptPaths` but never touched the panel DOM or the global `scriptsData`. So `#script-dropdown-list`, `#subfolders-list`, `#category-breadcrumb`, `#subfolder-count`, `#scripts-count` and `scriptsData` all retained the previously-viewed job's content, and `updateScriptMultiSelectText()` read stale `scriptsData`. (The execution panels — Queue & Status, Live Results, Live Execution Logs — were already handled by BF-13; topology resets via `renderTopologyCanvas()`.)

**Fix — 2026-06-22:**
| File | Change |
|------|--------|
| `static/app.js` | New `_resetScriptPanel()` helper — clears `scriptsData`/`currentFolderPath` and resets the subfolders list, script dropdown, breadcrumb, both counts, and the script inspector to the empty "Enter a path and click Load" placeholder. |
| `static/app.js` | `navigateToPath(path, silent)` gained a `silent` arg to suppress the "Loaded N folders" toast during a restore. |
| `static/app.js` | `switchJob()` now calls `_resetScriptPanel()` first, then — if the job has both a saved `base_path` and `host_id` — silently `navigateToPath('')` to reload that job's folders/scripts (restored `selectedScriptPaths` re-check where visible); otherwise leaves the panel empty. Net result: a job with selections shows its own DUTs/topology/scripts/execution; a fresh job shows an empty canvas, empty scripts, and no execution panels. |

---

## Files Changed

| File | Change Type | Notes |
|------|-------------|-------|
| `migrations/005_execution_jobs.py` | New file | ~65 lines — initial schema |
| `main.py` | Modified | ~320 lines added total (original ~220 + BF-1/BF-2/BF-11/BF-12 fixes) |
| `static/app.js` | Modified | ~390 lines added total (original ~200 + BF-1/BF-2/BF-8/BF-10/BF-11/BF-12/BF-13/BF-14 fixes) |
| `static/index.html` | Modified | ~35 lines added (original ~30 + Reset button) |
| `static/style.css` | Modified | ~50 lines added |
| `PLAN_execution_jobs.md` | New file | This document |

---

## Key Behaviours

- **Job-1 auto-created**: First time user opens the Execute tab with no existing jobs, `createJob()` is called automatically. Zero friction.
- **State auto-saved**: Every DUT check/uncheck, canvas wire, path change, or script toggle debounces a `PUT /api/execution-jobs/{id}` call (500ms). No Save button needed.
- **Testbed path auto-saved**: After every successful manual run, the generated testbed path on the VM is saved to the job so the scheduler can reuse it without regenerating.
- **Conflict = warning only**: Device conflict is shown as a dismissible amber banner above the canvas. The user can still proceed — the hard block remains `DUTLock` at execution time.
- **Topology is per-job**: Each job's canvas connections are stored as JSON in `execution_jobs.topology`. Switching jobs restores the full canvas state.
- **Reports are job-scoped**: `/api/execution-jobs/{id}/report/html|excel` merges all `TestCaseResult` rows from every execution that ran under the job.
- **Column migrations are safe**: `_apply_column_migrations()` runs on every server restart. Safe against duplicate calls — uses `IF NOT EXISTS` on PostgreSQL, try-except on SQLite.
- **Stuck job recovery**: If a job stays `running` after an exception or server crash, the startup cleanup resets it to `failed`. The amber Reset button in the header bar lets the user manually reset to `idle` without restarting.

---

## 1. Feature Summary

Add a **Job** concept to the Execute tab so users can:

- Create named/numbered jobs, each with its own DUT selection, Topology Canvas, script path, and script list
- Run multiple jobs in parallel
- Get a **warning** if a device is already claimed by another active job
- Download HTML / Excel reports **per job**
- Switch between jobs via a dropdown

---

## 2. Current State (baseline)

| Concern | Today |
|---------|-------|
| DUT selection | `selectedDUTIds` — one global `Set` |
| Topology canvas | `TopologyConnection` table — one global set (all sessions share it) |
| Script path | `activeBasePath` — one global string |
| Script list | `selectedScripts` — one global array |
| DUT locking | `DUTLock.job_id` — exists but points to **hardware load** job ids |
| Reports | Per-execution (`/api/executions/{id}/dashboard`, `/api/executions/{id}/excel`) |

Everything is single-slot today. The Job feature adds a **wrapper** that gives each slot its own persisted state and links executions to it.

---

## 3. Database Changes

### 3.1 New table: `execution_jobs`

```sql
CREATE TABLE execution_jobs (
    id            SERIAL PRIMARY KEY,
    name          VARCHAR(100) NOT NULL DEFAULT 'Job',
    status        VARCHAR(20)  NOT NULL DEFAULT 'idle',
      -- idle | running | completed | failed
    session_id    VARCHAR(255),          -- owner session
    dut_ids       TEXT,                  -- JSON array of DUT ids, e.g. "[1,3,5]"
    base_path     TEXT,                  -- scripts base path on VM
    host_id       INTEGER,               -- coordinator VM id
    topology      TEXT,                  -- JSON snapshot of canvas connections
    scripts       TEXT,                  -- JSON array of script objects with path+dut_count+min_topology
    created_at    TIMESTAMP DEFAULT NOW(),
    updated_at    TIMESTAMP DEFAULT NOW()
);
```

Rationale: persisting job state (DUTs, topology, scripts) lets the user refresh the page and come back to the same job, and allows jobs to be re-run without re-selecting everything.

### 3.2 Alter `executions` table — add `job_id`

```sql
ALTER TABLE executions ADD COLUMN job_id INTEGER REFERENCES execution_jobs(id) ON DELETE SET NULL;
CREATE INDEX idx_executions_job_id ON executions(job_id);
```

All `run_spytest_execution` calls will stamp `job_id` on the `Execution` record.

### 3.3 `dut_locks.job_id` repurposed

The existing `dut_locks.job_id` column currently holds hardware-load job ids. We keep the same column but also write `execution_job_id` values there (they live in a different table so there is no collision — hardware load jobs use `hardware_load_jobs.id`, execution jobs use `execution_jobs.id`). A new column `lock_type` (`hw` | `exec`) disambiguates.

```sql
ALTER TABLE dut_locks ADD COLUMN lock_type VARCHAR(10) DEFAULT 'exec';
```

### 3.4 Migration file

New file: `migrations/005_execution_jobs.py`

Applies the DDL above. Safe to run on an existing database (uses `IF NOT EXISTS` / `IF column not exists` guards).

---

## 4. Backend (main.py)

### 4.1 New ORM model

```python
class ExecutionJob(Base):
    __tablename__ = "execution_jobs"
    id         = Column(Integer, primary_key=True, autoincrement=True)
    name       = Column(String(100), nullable=False, default="Job")
    status     = Column(String(20), default="idle")   # idle|running|completed|failed
    session_id = Column(String(255), nullable=True, index=True)
    dut_ids    = Column(Text, nullable=True)          # JSON
    base_path  = Column(Text, nullable=True)
    host_id    = Column(Integer, nullable=True)
    topology   = Column(Text, nullable=True)          # JSON canvas snapshot
    scripts    = Column(Text, nullable=True)          # JSON
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
```

Also add `job_id = Column(Integer, nullable=True, index=True)` to `Execution` model.

### 4.2 New REST endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/execution-jobs` | Create new job; returns `{id, name}` |
| `GET`  | `/api/execution-jobs` | List all jobs for session (last 50); includes `status`, `execution_count` |
| `GET`  | `/api/execution-jobs/{id}` | Full job state: dut_ids, topology, scripts, base_path, executions[] |
| `PUT`  | `/api/execution-jobs/{id}` | Save/update job state (auto-called on any change) |
| `DELETE` | `/api/execution-jobs/{id}` | Delete job if `status != running`; releases DUT locks |
| `GET`  | `/api/execution-jobs/{id}/conflicts` | Conflict check — returns list of dut_ids claimed by other jobs |
| `GET`  | `/api/execution-jobs/{id}/report/html` | Aggregated HTML for all executions in this job |
| `GET`  | `/api/execution-jobs/{id}/report/excel` | Aggregated Excel for all executions in this job |

### 4.3 `POST /api/execution-jobs`

```python
@app.post("/api/execution-jobs")
def create_execution_job(body: dict, db: Session = Depends(get_db),
                         current: UserSession = Depends(require_session)):
    job = ExecutionJob(
        name       = body.get("name") or f"Job {datetime.utcnow().strftime('%H:%M')}",
        session_id = current.session_id,
    )
    db.add(job); db.commit(); db.refresh(job)
    return {"id": job.id, "name": job.name, "status": job.status}
```

### 4.4 `GET /api/execution-jobs/{id}/conflicts`

```python
@app.get("/api/execution-jobs/{job_id}/conflicts")
def check_job_conflicts(job_id: int, dut_ids: str, db: Session = Depends(get_db),
                        current: UserSession = Depends(require_session)):
    """
    dut_ids: comma-separated list e.g. "1,3,5"
    Returns: [{dut_id, dut_name, conflicting_job_id, conflicting_job_name}]
    """
    requested = [int(x) for x in dut_ids.split(",") if x.strip()]
    conflicts = []
    for dut_id in requested:
        lock = db.query(DUTLock).filter(
            DUTLock.dut_id == dut_id,
            DUTLock.status != "AVAILABLE",
            DUTLock.lock_type == "exec",
            DUTLock.job_id != job_id          # another job owns it
        ).first()
        if lock:
            owner_job = db.query(ExecutionJob).filter(ExecutionJob.id == lock.job_id).first()
            dut = db.query(DUT).filter(DUT.id == dut_id).first()
            conflicts.append({
                "dut_id":               dut_id,
                "dut_name":             dut.name if dut else str(dut_id),
                "conflicting_job_id":   lock.job_id,
                "conflicting_job_name": owner_job.name if owner_job else f"Job {lock.job_id}"
            })
    return {"conflicts": conflicts}
```

### 4.5 Job-aggregated reports

`GET /api/execution-jobs/{id}/report/html` — fetches all `Execution` rows where `execution.job_id == id`, merges their `TestCaseResult` rows, and runs `_build_html_dashboard()` on the combined set. Returns a single HTML download named `{job_name}_report.html`.

`GET /api/execution-jobs/{id}/report/excel` — same merge, calls `_build_excel()`, returns `{job_name}_report.xlsx`.

### 4.6 Execution stamping

Inside `_run_spytest_execution()`, the `job_id` parameter is added to the function signature and written to the `Execution` record at creation time:

```python
execution = Execution(
    ...
    job_id = job_id,    # new
)
```

After execution completes, update `ExecutionJob.status`:
```python
job = db.query(ExecutionJob).filter(ExecutionJob.id == job_id).first()
if job:
    # running→completed if all scripts done, →failed if any failed
    remaining = db.query(Execution).filter(
        Execution.job_id == job_id, Execution.status == "running"
    ).count()
    if remaining == 0:
        job.status = "completed"
    db.commit()
```

### 4.7 DUT lock stamping

When `acquire_duts()` allocates devices for a job, write `lock_type='exec'` and the `execution_job_id`:

```python
lock.job_id   = execution_job_id
lock.lock_type = "exec"
```

When `release_duts()` frees devices, clear them:

```python
lock.status    = "AVAILABLE"
lock.job_id    = None
lock.lock_type = "exec"
```

---

## 5. Frontend Changes (app.js + index.html + style.css)

### 5.1 Job state structure

Replace the current single-slot globals with a per-job state object:

```javascript
// Global
let activeJobId   = null;   // currently-viewed job id
let jobs          = [];     // [{id, name, status}] — sidebar/dropdown list

// Per-job state (loaded when switching to a job)
let jobState = {
    // mirrors what we persist to the server
    selectedDUTIds:  new Set(),
    dutConnections:  [],
    activeBasePath:  '',
    hostId:          null,
    selectedScripts: [],
};
```

The existing globals `selectedDUTIds`, `activeBasePath`, etc. stay as aliases pointing into `jobState`:

```javascript
// Compatibility shim so existing code keeps working
let selectedDUTIds  = jobState.selectedDUTIds;
let activeBasePath  = jobState.activeBasePath;
let dutConnections  = jobState.dutConnections;
```

On job switch: save current `jobState` → server (`PUT /api/execution-jobs/{activeJobId}`), then load new job state from server (`GET /api/execution-jobs/{newId}`), then re-render canvas + script list + DUT table.

### 5.2 Execute tab header bar

Add at the **top of the Execute tab** (above all existing cards):

```
┌──────────────────────────────────────────────────────────┐
│  Job: [▼  Job-1 (idle)        ]  [+ New Job]  [🗑 Delete] │
└──────────────────────────────────────────────────────────┘
```

- Dropdown lists all jobs (name + status badge: idle/running/completed/failed)
- `[+ New Job]` → `POST /api/execution-jobs` → prepend to dropdown → switch to it
- `[🗑 Delete]` → confirm dialog → `DELETE /api/execution-jobs/{id}` (disabled if running)
- Selecting a different job from the dropdown calls `switchJob(newId)`

HTML element: `<div class="job-header-bar">` inserted as first child of `#tab-execute`.

### 5.3 `createJob()`

```javascript
async function createJob() {
    const res  = await apiFetch('/api/execution-jobs', {method: 'POST',
        body: JSON.stringify({name: `Job-${jobs.length + 1}`})});
    const data = await res.json();
    jobs.unshift(data);
    await switchJob(data.id);
    renderJobDropdown();
}
```

### 5.4 `switchJob(newId)`

```javascript
async function switchJob(newId) {
    // 1. Save current job state to server
    if (activeJobId) await saveJobState();

    // 2. Load new job from server
    const res  = await apiFetch(`/api/execution-jobs/${newId}`);
    const data = await res.json();

    // 3. Restore state
    activeJobId = newId;
    jobState.selectedDUTIds  = new Set(data.dut_ids || []);
    jobState.activeBasePath  = data.base_path || '';
    jobState.hostId          = data.host_id;
    jobState.dutConnections  = data.topology || [];
    jobState.selectedScripts = data.scripts  || [];

    // 4. Sync aliases
    selectedDUTIds = jobState.selectedDUTIds;
    activeBasePath = jobState.activeBasePath;
    dutConnections = jobState.dutConnections;

    // 5. Re-render all panels
    renderDUTTable();
    renderTopologyCanvas();
    renderScriptList();
    document.getElementById('scripts-base-path').value = activeBasePath;
    renderJobDropdown();
}
```

### 5.5 `saveJobState()` — auto-save on every change

Called on every user action that mutates job state (DUT select/deselect, topology wire, script add/remove, path change):

```javascript
async function saveJobState() {
    if (!activeJobId) return;
    await apiFetch(`/api/execution-jobs/${activeJobId}`, {
        method: 'PUT',
        body: JSON.stringify({
            dut_ids:   Array.from(jobState.selectedDUTIds),
            base_path: jobState.activeBasePath,
            host_id:   jobState.hostId,
            topology:  jobState.dutConnections,
            scripts:   jobState.selectedScripts,
        })
    });
}
```

Debounced to 500 ms so canvas drags don't flood the server.

### 5.6 Cross-job device conflict warning

Called when the user **checks a DUT** in the device table:

```javascript
async function checkDUTConflict(dutId) {
    if (!activeJobId) return;
    const res  = await apiFetch(
        `/api/execution-jobs/${activeJobId}/conflicts?dut_ids=${dutId}`);
    const data = await res.json();
    if (data.conflicts.length > 0) {
        const c = data.conflicts[0];
        showWarningBanner(
            `⚠ Device "${c.dut_name}" is already in use by <strong>${c.conflicting_job_name}</strong> (Job #${c.conflicting_job_id}). Adding it here may cause allocation conflicts.`
        );
    }
}
```

Warning is a dismissible yellow banner directly above the DUT table — not a blocking modal, so the user can still proceed if they know what they're doing.

### 5.7 `startExecution()` changes

- Reads `activeJobId` and passes it as `job_id` in the request body
- Job status badge in the dropdown updates to `running` immediately
- On completion event (SSE/polling), updates badge to `completed`/`failed`

```javascript
const body = {
    ...existingBody,
    job_id: activeJobId,     // new
};
```

### 5.8 Job-level report buttons

Add to the bottom of the Execute tab's **Live Results** panel, next to the existing per-execution `[Download HTML]` / `[Download Excel]` buttons:

```
[ ⬇ Job HTML Report ]  [ ⬇ Job Excel Report ]
```

These are activated once `activeJobId` is set and at least one execution in the job is `completed`.

```javascript
document.getElementById('btn-job-html').onclick = () =>
    window.open(`/api/execution-jobs/${activeJobId}/report/html`);
document.getElementById('btn-job-excel').onclick = () =>
    window.open(`/api/execution-jobs/${activeJobId}/report/excel`);
```

### 5.9 Logs tab — job filter column

In the Logs tab execution table, add a **Job** column showing `Job-1`, `Job-2`, etc. (or `—` if no job). A filter dropdown above the table lets the user narrow logs to one job.

---

## 6. UI / CSS

### 6.1 Job header bar

```css
.job-header-bar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 16px;
    background: var(--surface2);
    border-radius: 8px;
    margin-bottom: 16px;
}
.job-select {
    flex: 1;
    max-width: 280px;
    padding: 6px 10px;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--surface1);
    color: var(--text);
    font-size: 14px;
}
.job-status-badge {
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 10px;
    font-weight: 600;
    text-transform: uppercase;
}
.job-status-badge.idle      { background: rgba(100,116,139,0.15); color: #64748b; }
.job-status-badge.running   { background: rgba(59,130,246,0.15);  color: #3b82f6; }
.job-status-badge.completed { background: rgba(34,197,94,0.15);   color: #22c55e; }
.job-status-badge.failed    { background: rgba(239,68,68,0.15);   color: #ef4444; }
```

### 6.2 Device conflict warning banner

```css
.conflict-banner {
    display: none;
    padding: 8px 14px;
    background: rgba(245,158,11,0.12);
    border: 1px solid rgba(245,158,11,0.4);
    border-radius: 6px;
    color: #d97706;
    font-size: 13px;
    margin-bottom: 8px;
}
.conflict-banner.visible { display: flex; align-items: center; gap: 8px; }
```

---

## 7. Implementation Order

| Step | What | Files |
|------|------|-------|
| 1 | DB migration — `execution_jobs` table, `executions.job_id`, `dut_locks.lock_type` | `migrations/005_execution_jobs.py` |
| 2 | ORM model `ExecutionJob` + `job_id` on `Execution` | `main.py` |
| 3 | CRUD endpoints (create / list / get / update / delete) | `main.py` |
| 4 | Conflict-check endpoint | `main.py` |
| 5 | Stamp `job_id` in `_run_spytest_execution()` + DUT lock updates | `main.py` |
| 6 | Job-aggregated report endpoints (html + excel) | `main.py` |
| 7 | Job header bar HTML + CSS | `index.html`, `style.css` |
| 8 | `createJob`, `switchJob`, `saveJobState`, `renderJobDropdown` | `app.js` |
| 9 | Wire DUT checkbox to `checkDUTConflict()` | `app.js` |
| 10 | Pass `job_id` in `startExecution()` | `app.js` |
| 11 | Job report buttons in Live Results panel | `app.js`, `index.html` |
| 12 | Logs tab — job column + filter | `app.js`, `index.html` |
| 13 | Auto-create a default Job-1 on Execute tab open if no jobs exist | `app.js` |

---

## 8. Key Rules / Decisions

### Device conflict is a warning, not a hard block
Two jobs can share a device at the job-state level (planning). The hard block happens at execution time via `DUTLock` (unchanged behavior). The warning is UX only — it tells the user before they click Run.

### Topology is per-job
The `TopologyConnection` DB table becomes **legacy** (still used by default for the currently-open Execute tab when no job is active). Once a job is created its topology is stored as JSON in `execution_jobs.topology`. This avoids changing the canvas API and means two jobs can have completely different topologies.

### Job state is auto-saved (debounced, 500ms)
No explicit Save button. Every DUT check, canvas wire, script add triggers a debounced `PUT /api/execution-jobs/{id}`.

### Job-1 is auto-created
When the user opens the Execute tab for the first time (no jobs exist for their session), one job named `Job-1` is created automatically so the UX is unchanged from today.

### Parallel job execution
Each job's `_run_spytest_execution()` runs in its own background thread (unchanged from current behavior). The `DUTLock` table remains the source of truth for which physical device is in use. Two jobs will compete for devices at execution time via `acquire_duts()` exactly as two simultaneous executions do today.

### Reports are job-scoped
`/api/execution-jobs/{id}/report/html` merges ALL `TestCaseResult` rows from all `Execution` records where `execution.job_id == id`. The result is one consolidated HTML/Excel with a "Job Summary" section at the top showing total pass/fail/skip across all scripts in that job.

---

## 9. Out of Scope (v3.2)

- Job sharing across users (jobs are session-scoped)
- Job templates / clone-job
- Scheduled jobs (cron)
- Job queue / priority ordering

---

## 10. Estimated File Changes

| File | Change volume |
|------|---------------|
| `main.py` | ~200 lines added (5 endpoints + ORM + job stamping) |
| `static/app.js` | ~180 lines added (job state, dropdown, conflict check, save) |
| `static/index.html` | ~30 lines added (header bar, report buttons, logs job column) |
| `static/style.css` | ~40 lines added (job bar, badges, conflict banner) |
| `migrations/005_execution_jobs.py` | ~50 lines |
