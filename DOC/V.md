# Enterprise Data Intelligence Platform (EDIP)
## Full Technical & Architectural Plan

> **Purpose:** This document covers both the big-picture product vision and the ground-level developer implementation plan — how the platform connects to external systems, how data flows in, how queries are processed, and how reports are generated.

---

## Table of Contents

1. [Big Picture Overview](#1-big-picture-overview)
2. [System Architecture](#2-system-architecture)
3. [Platform Integrations — How to Connect Each System](#3-platform-integrations)
4. [Data Ingestion Pipeline — How Data Flows In](#4-data-ingestion-pipeline)
5. [The Unified Data Model](#5-the-unified-data-model)
6. [The AI Query Engine — How Analysis Works](#6-the-ai-query-engine)
7. [Department Modules — What Each One Tracks](#7-department-modules)
8. [Output & Report Generation](#8-output--report-generation)
9. [Security, RBAC & Audit](#9-security-rbac--audit)
10. [Tech Stack Recommendations](#10-tech-stack-recommendations)
11. [Developer Setup Guide — Feeding Data Step by Step](#11-developer-setup-guide)
12. [Phased Delivery Roadmap](#12-phased-delivery-roadmap)
13. [Key Risks & How to Handle Them](#13-key-risks--how-to-handle-them)

---

## 1. Big Picture Overview

### The Problem

In large organizations, critical data is scattered:
- **Scripts and CLIs** live in Git repositories across teams
- **Sprint and ticket data** lives in Jira or Azure DevOps
- **Test results** live in TestRail, Excel sheets, or CI logs
- **Employee and payroll data** lives in HRIS/ERP systems
- **Deployment records** live in Jenkins, GitHub Actions, or cloud consoles

When a manager asks *"how many CLIs do we have, which ones are working, and which sprint completed them?"* — an engineer has to spend hours or days manually hunting across all these systems, copy-pasting into Excel, and formatting a report.

### The Solution

EDIP is a **natural language-powered data intelligence layer** that:

1. Connects to all your existing platforms via APIs, file sync, or database connectors
2. Indexes and normalizes data into a unified internal store
3. Accepts plain English queries from users ("how many CLIs are untested in Sprint 24?")
4. Executes structured lookups, joins data across systems, and returns formatted results
5. Exports to Excel, PDF, dashboards, or scheduled email reports

### Who Uses It

| Role | What They Ask |
|---|---|
| Engineering Manager | "List all CLI scripts, their sprint, and working status" |
| QA Lead | "How many features from Sprint 23 are untested?" |
| HR Manager | "Headcount by team with salary band breakdown" |
| Finance Head | "Budget utilization by department this quarter" |
| DevOps Lead | "Which services haven't been deployed in 30 days?" |
| Admin | "Which software licenses expire in the next 60 days?" |

---

## 2. System Architecture

```
+-----------------------------------------------------------------+
¦                        USER INTERFACE                           ¦
¦          Web App  ·  REST API  ·  Slack Bot (optional)          ¦
+-----------------------------------------------------------------+
                             ¦
+----------------------------?------------------------------------+
¦                     QUERY GATEWAY                               ¦
¦        Auth/RBAC check  ·  Query router  ·  Rate limiter        ¦
+-----------------------------------------------------------------+
                             ¦
+----------------------------?------------------------------------+
¦                   AI QUERY ENGINE                               ¦
¦   NL Parser ? Intent Resolver ? Query Planner ? Executor        ¦
¦              (LLM-powered understanding layer)                   ¦
+-----------------------------------------------------------------+
     ¦              ¦                ¦                ¦
+----?---+    +-----?----+    +------?-----+   +----?------+
¦  Dev   ¦    ¦ HR/Fin   ¦    ¦  QA/Test   ¦   ¦  Deploy   ¦
¦ Module ¦    ¦ Module   ¦    ¦  Module    ¦   ¦  Module   ¦
+--------+    +----------+    +------------+   +-----------+
     ¦              ¦                ¦                ¦
+----?--------------?----------------?----------------?----------+
¦                  UNIFIED DATA STORE                             ¦
¦    Metadata Index  ·  Entity Graph  ·  Vector Store (search)    ¦
+-----------------------------------------------------------------+
     ¦              ¦                ¦                ¦
+----?---+    +-----?----+    +------?-----+   +----?------+
¦  Git   ¦    ¦  HRIS /  ¦    ¦  Jira /    ¦   ¦ Jenkins / ¦
¦  SVN   ¦    ¦  ERP     ¦    ¦  TestRail  ¦   ¦  GH Act.  ¦
¦  FS    ¦    ¦  Payroll ¦    ¦  Excel CSV ¦   ¦  K8s      ¦
+--------+    +----------+    +------------+   +-----------+
         CONNECTOR LAYER (adapters per platform)
```

### Key Architectural Decisions

| Decision | Choice | Reason |
|---|---|---|
| Storage model | Metadata index + raw reference | Don't copy sensitive data; store only queryable fields |
| Query understanding | LLM + deterministic executor | LLM for NL parsing, rules engine for actual data fetch |
| Integration style | Pull-based with scheduled sync | Less invasive than webhooks for legacy systems |
| Multi-tenancy | Per-department namespaces | Clean RBAC boundary, easy to audit |

---

## 3. Platform Integrations

### 3.1 Git / Source Code Repositories

**What to collect:** file paths, file names, function names, CLI command definitions, commit metadata, branch names, last modified date, author

**How to connect:**

```python
# Using GitPython library
import git

def index_repository(repo_url: str, local_path: str):
    repo = git.Repo.clone_from(repo_url, local_path)
    
    for commit in repo.iter_commits():
        for blob in commit.tree.traverse():
            if blob.type == 'blob':  # it's a file
                index_file({
                    "path": blob.path,
                    "name": blob.name,
                    "last_commit": commit.hexsha,
                    "author": commit.author.name,
                    "date": commit.authored_date,
                    "content_hash": blob.hexsha
                })
```

**CLI detection logic — how to find CLI commands in scripts:**

```python
import re

CLI_PATTERNS = [
    r'@click\.command',           # Python Click
    r'argparse\.ArgumentParser',  # Python argparse
    r'commander\.command\(',      # Node.js Commander
    r'yargs\.',                   # Node.js Yargs
    r'cobra\.Command{',           # Go Cobra
    r'^\s*def\s+cli_',            # Naming convention
    r'argparse|optparse|docopt',  # Generic
]

def detect_clis(file_content: str, file_path: str) -> list:
    found = []
    for pattern in CLI_PATTERNS:
        if re.search(pattern, file_content, re.MULTILINE):
            found.append({
                "file": file_path,
                "pattern_matched": pattern,
                "has_cli": True
            })
    return found
```

**Developer setup steps:**
1. Create a read-only Git service account (SSH key or PAT token with `read` scope)
2. Store credentials in environment variables or a secrets manager (never hardcode)
3. Schedule a sync job every 15–60 minutes using a cron or task queue
4. For large repos, use `git log --since` to do incremental syncs

---

### 3.2 Jira / Azure DevOps (Sprint & Ticket Data)

**What to collect:** sprint names, ticket IDs, ticket titles, assignees, status, labels, components, story points, linked PRs

**Jira REST API connection:**

```python
import requests
from requests.auth import HTTPBasicAuth

JIRA_BASE = "https://yourorg.atlassian.net"
AUTH = HTTPBasicAuth("email@org.com", "YOUR_API_TOKEN")

def get_sprint_issues(board_id: int, sprint_id: int):
    url = f"{JIRA_BASE}/rest/agile/1.0/board/{board_id}/sprint/{sprint_id}/issue"
    params = {
        "maxResults": 100,
        "fields": "summary,status,assignee,labels,components,story_points,customfield_10016"
    }
    response = requests.get(url, auth=AUTH, params=params)
    return response.json()["issues"]

def get_all_sprints(board_id: int):
    url = f"{JIRA_BASE}/rest/agile/1.0/board/{board_id}/sprint"
    response = requests.get(url, auth=AUTH)
    return response.json()["values"]
```

**Developer setup steps:**
1. Go to Jira ? Account Settings ? Security ? Create API Token
2. Store as `JIRA_EMAIL` and `JIRA_API_TOKEN` in your `.env` file
3. Identify your Board IDs (visible in the Jira board URL)
4. For Azure DevOps, use a Personal Access Token (PAT) with `Work Items (Read)` scope

---

### 3.3 HRIS / HR Systems (Workday, BambooHR, Greythr)

**What to collect:** employee ID, name, department, role/title, join date, employment status, leave status. **Do NOT collect** salary or PII in the general index — store in an encrypted HR-only partition.

**BambooHR API example:**

```python
import requests

def get_employees(api_key: str, subdomain: str):
    url = f"https://api.bamboohr.com/api/gateway.php/{subdomain}/v1/employees/directory"
    headers = {"Accept": "application/json"}
    response = requests.get(url, auth=(api_key, "x"), headers=headers)
    return response.json()["employees"]

# Fields to request:
FIELDS = [
    "id", "displayName", "jobTitle", "department",
    "workEmail", "employmentHistoryStatus", "hireDate"
]
```

**For payroll data (Finance module only):**
- Never sync raw salary figures into the general metadata store
- Create a separate encrypted partition accessible only to Finance role
- Use aggregated figures (total payroll by department) for cross-domain queries

**Developer setup steps:**
1. HR systems typically require formal IT approval — get sign-off before connecting
2. Use OAuth 2.0 where available (Workday supports this natively)
3. For legacy HRIS systems with no API, export scheduled CSV reports and build a CSV watcher

---

### 3.4 QA / Test Management (TestRail, Excel, CI Logs)

**What to collect:** test case ID, test name, linked feature/ticket, test status (pass/fail/blocked), sprint, tester, date run

**TestRail API example:**

```python
import requests
from requests.auth import HTTPBasicAuth

def get_test_runs(project_id: int):
    url = f"https://yourorg.testrail.io/index.php?/api/v2/get_runs/{project_id}"
    auth = HTTPBasicAuth("email@org.com", "YOUR_TESTRAIL_KEY")
    response = requests.get(url, auth=auth)
    return response.json()["runs"]

def get_tests_for_run(run_id: int):
    url = f"https://yourorg.testrail.io/index.php?/api/v2/get_tests/{run_id}"
    response = requests.get(url, auth=HTTPBasicAuth(...))
    return response.json()["tests"]
```

**For Excel/CSV-based test tracking:**

```python
import pandas as pd

def ingest_test_sheet(file_path: str, sheet_name: str = "Test Results"):
    df = pd.read_excel(file_path, sheet_name=sheet_name)
    
    # Normalize column names (teams name things differently)
    df.columns = df.columns.str.lower().str.replace(' ', '_')
    
    # Expected columns after normalization:
    # test_id, test_name, status, sprint, linked_ticket, tester, date_run
    
    records = df.to_dict('records')
    return [normalize_test_record(r) for r in records]
```

**Developer setup steps:**
1. For TestRail: generate an API key under My Settings ? API Keys
2. For Excel-based tracking: set up a shared folder watch (SharePoint or S3) that triggers ingestion when files are updated
3. Define a canonical column mapping config so the system can normalize varying sheet formats

---

### 3.5 Deployment & DevOps (Jenkins, GitHub Actions, Kubernetes)

**What to collect:** build ID, pipeline name, service name, environment (dev/staging/prod), deployment status, deployment date, version/tag deployed, duration

**GitHub Actions API:**

```python
import requests

GITHUB_TOKEN = "ghp_yourtoken"
HEADERS = {"Authorization": f"Bearer {GITHUB_TOKEN}"}

def get_workflow_runs(owner: str, repo: str, workflow_id: str):
    url = f"https://api.github.com/repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs"
    response = requests.get(url, headers=HEADERS)
    return response.json()["workflow_runs"]
```

**Jenkins API:**

```python
import requests

def get_jenkins_builds(jenkins_url: str, job_name: str, user: str, token: str):
    url = f"{jenkins_url}/job/{job_name}/api/json?tree=builds[number,result,timestamp,duration,url]"
    response = requests.get(url, auth=(user, token))
    return response.json()["builds"]
```

**Developer setup steps:**
1. GitHub Actions: create a fine-grained PAT with `Actions: Read` scope
2. Jenkins: create a dedicated API user with read-only permissions; use the Jenkins API token (not your password)
3. Kubernetes: create a read-only `ClusterRole` binding for a service account used by the platform

---

### 3.6 Document Stores (SharePoint, Google Drive)

**What to collect:** file name, path, last modified, owner, file type — and for structured files (Excel, CSV), also their data content

**Microsoft SharePoint (via Graph API):**

```python
import msal
import requests

def get_sharepoint_files(tenant_id, client_id, client_secret, site_id):
    app = msal.ConfidentialClientApplication(
        client_id,
        authority=f"https://login.microsoftonline.com/{tenant_id}",
        client_credential=client_secret
    )
    token = app.acquire_token_for_client(scopes=["https://graph.microsoft.com/.default"])
    
    headers = {"Authorization": f"Bearer {token['access_token']}"}
    url = f"https://graph.microsoft.com/v1.0/sites/{site_id}/drive/root/children"
    return requests.get(url, headers=headers).json()["value"]
```

**Google Drive (via Google API Python client):**

```python
from googleapiclient.discovery import build
from google.oauth2 import service_account

def get_drive_files(service_account_file: str, folder_id: str):
    creds = service_account.Credentials.from_service_account_file(
        service_account_file,
        scopes=["https://www.googleapis.com/auth/drive.readonly"]
    )
    service = build("drive", "v3", credentials=creds)
    results = service.files().list(
        q=f"'{folder_id}' in parents",
        fields="files(id, name, mimeType, modifiedTime, owners)"
    ).execute()
    return results.get("files", [])
```

---

## 4. Data Ingestion Pipeline

### Pipeline Architecture

```
Platform API / File System
         ¦
    [Connector]          ? one per platform type
         ¦
    [Extractor]          ? pulls raw data
         ¦
    [Transformer]        ? normalizes to unified schema
         ¦
    [Validator]          ? checks required fields, data types
         ¦
    [Enricher]           ? adds metadata tags, links entities
         ¦
    [Loader]             ? writes to unified data store
         ¦
  [Change Detector]      ? tracks what's new vs already indexed
```

### Sync Strategies

| Data Type | Sync Type | Frequency | Reason |
|---|---|---|---|
| Git file index | Incremental (git log --since) | Every 15 min | Changes often, only new commits needed |
| Jira tickets | Incremental (updated_after filter) | Every 30 min | Real-time not critical for reporting |
| HR employee data | Full refresh | Daily at midnight | Low change frequency, small dataset |
| CI/CD builds | Event-driven webhook | On build complete | Need fresh deployment data |
| Excel/CSV files | File watcher (hash diff) | On file change | Detect when team updates a sheet |
| TestRail results | Incremental | Every 1 hour | Test runs complete batch-wise |

### Incremental Sync Implementation

```python
import hashlib
from datetime import datetime

class IncrementalSyncer:
    def __init__(self, store):
        self.store = store
    
    def should_sync(self, entity_id: str, current_hash: str) -> bool:
        """Return True if entity has changed since last sync."""
        last = self.store.get_sync_state(entity_id)
        if not last:
            return True  # Never synced
        return last["content_hash"] != current_hash
    
    def compute_hash(self, data: dict) -> str:
        content = str(sorted(data.items()))
        return hashlib.md5(content.encode()).hexdigest()
    
    def mark_synced(self, entity_id: str, hash: str):
        self.store.set_sync_state(entity_id, {
            "content_hash": hash,
            "synced_at": datetime.utcnow().isoformat()
        })
```

### Error Handling & Retry Logic

```python
import time
from functools import wraps

def with_retry(max_attempts=3, backoff_seconds=5):
    def decorator(func):
        @wraps(func)
        def wrapper(*args, **kwargs):
            for attempt in range(max_attempts):
                try:
                    return func(*args, **kwargs)
                except Exception as e:
                    if attempt == max_attempts - 1:
                        log_failed_sync(func.__name__, str(e))
                        raise
                    time.sleep(backoff_seconds * (attempt + 1))
        return wrapper
    return decorator

@with_retry(max_attempts=3, backoff_seconds=10)
def sync_jira_sprint(board_id, sprint_id):
    # ... sync logic
    pass
```

---

## 5. The Unified Data Model

Every entity in EDIP — regardless of where it came from — gets normalized into a common schema. This is what makes cross-domain queries possible.

### Core Entity Types

```json
// SCRIPT entity (from Git)
{
  "entity_type": "script",
  "entity_id": "git:repo123:src/cli/deploy.py",
  "source_system": "git",
  "source_ref": "https://github.com/org/repo/blob/main/src/cli/deploy.py",
  "name": "deploy.py",
  "path": "src/cli/deploy.py",
  "has_cli": true,
  "cli_framework": "click",
  "language": "python",
  "last_modified": "2025-05-12T14:30:00Z",
  "author": "john.doe",
  "tags": ["cli", "deployment", "sprint-24"],
  "linked_tickets": ["PROJ-1234"],
  "department_scope": "development"
}
```

```json
// TICKET entity (from Jira)
{
  "entity_type": "ticket",
  "entity_id": "jira:PROJ-1234",
  "source_system": "jira",
  "title": "Implement deploy CLI with --env flag",
  "status": "Done",
  "sprint": "Sprint 24",
  "sprint_id": "sprint:board5:24",
  "assignee": "john.doe",
  "labels": ["cli", "backend"],
  "components": ["deployment-tools"],
  "story_points": 5,
  "linked_entities": ["git:repo123:src/cli/deploy.py"],
  "department_scope": "development"
}
```

```json
// TEST_RESULT entity (from TestRail / Excel)
{
  "entity_type": "test_result",
  "entity_id": "testrail:run456:case789",
  "source_system": "testrail",
  "test_name": "Deploy CLI with valid --env flag",
  "status": "passed",
  "linked_ticket": "jira:PROJ-1234",
  "sprint": "Sprint 24",
  "tester": "qa.engineer@org.com",
  "run_date": "2025-05-15",
  "department_scope": "qa"
}
```

```json
// EMPLOYEE entity (from HRIS)
{
  "entity_type": "employee",
  "entity_id": "hr:EMP-00421",
  "source_system": "bamboohr",
  "display_name": "Jane Smith",
  "department": "Engineering",
  "title": "Senior Software Engineer",
  "employment_status": "Active",
  "hire_date": "2022-03-01",
  "department_scope": "hr",
  "data_classification": "restricted"  // HR-only access
}
```

### Entity Linking (Cross-Domain Joins)

```python
class EntityLinker:
    """Links entities across systems using shared identifiers."""
    
    def link_script_to_ticket(self, script_entity: dict):
        """
        Looks for Jira ticket references in:
        - Commit messages (fixes PROJ-1234)
        - Branch names (feature/PROJ-1234-deploy-cli)
        - File path conventions
        """
        ticket_pattern = r'([A-Z]+-\d+)'
        
        found_tickets = []
        
        # Search commit messages
        for commit in script_entity.get("recent_commits", []):
            matches = re.findall(ticket_pattern, commit["message"])
            found_tickets.extend(matches)
        
        return list(set(found_tickets))
    
    def link_ticket_to_tests(self, ticket_id: str):
        """Find test cases linked to a given ticket."""
        return self.store.query({
            "entity_type": "test_result",
            "linked_ticket": f"jira:{ticket_id}"
        })
```

---

## 6. The AI Query Engine

### How a Query Gets Processed

```
User: "How many CLIs do we have in Sprint 24 and which ones are passing tests?"

Step 1 — Intent Parsing (LLM)
  ? intent: "coverage_report"
  ? entities: ["CLI", "Sprint 24", "test_status=passing"]
  ? departments: ["development", "qa"]

Step 2 — Permission Check
  ? user role: "engineering_manager"
  ? allowed scopes: ["development", "qa"]  ?

Step 3 — Query Planning
  ? fetch scripts WHERE has_cli=true
  ? join WITH tickets WHERE sprint="Sprint 24"
  ? join WITH test_results WHERE status="passed"
  ? aggregate: count by status

Step 4 — Execution
  ? 47 CLI scripts found in Sprint 24
  ? 31 have passing tests
  ? 16 have no test coverage

Step 5 — Response Formatting
  ? Summary text + table + Excel export
```

### LLM Integration for Query Understanding

```python
import anthropic

client = anthropic.Anthropic()

SYSTEM_PROMPT = """
You are a query parser for an enterprise data platform.
Given a natural language question, extract:
1. intent (what kind of report is needed)
2. entities (things being asked about)
3. filters (constraints like sprint name, date range, status)
4. departments (which data domains are needed: dev, qa, hr, finance, deployment)
5. output_format (table, count, list, chart)

Respond ONLY in JSON. No explanation.

Example:
Input: "How many employees joined last month in the engineering team?"
Output: {
  "intent": "headcount_report",
  "entities": ["employee"],
  "filters": {"department": "engineering", "date_range": "last_30_days", "event": "joined"},
  "departments": ["hr"],
  "output_format": "count_with_list"
}
"""

def parse_query(user_question: str) -> dict:
    response = client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=500,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user_question}]
    )
    import json
    return json.loads(response.content[0].text)
```

### Deterministic Query Executor

```python
class QueryExecutor:
    def __init__(self, data_store, entity_linker):
        self.store = data_store
        self.linker = entity_linker
    
    def execute(self, parsed_query: dict, user_role: str) -> dict:
        intent = parsed_query["intent"]
        filters = parsed_query["filters"]
        departments = parsed_query["departments"]
        
        # Permission gate
        allowed = self.check_permissions(user_role, departments)
        if not allowed["permitted"]:
            return {"error": f"Access denied to: {allowed['denied_scopes']}"}
        
        # Route to the correct handler
        handlers = {
            "cli_coverage_report": self.handle_cli_coverage,
            "headcount_report": self.handle_headcount,
            "sprint_summary": self.handle_sprint_summary,
            "test_coverage_report": self.handle_test_coverage,
            "deployment_summary": self.handle_deployment_summary,
        }
        
        handler = handlers.get(intent)
        if not handler:
            return {"error": f"Unknown intent: {intent}"}
        
        return handler(filters)
    
    def handle_cli_coverage(self, filters: dict) -> dict:
        sprint = filters.get("sprint")
        
        # Fetch CLI scripts linked to the sprint
        scripts = self.store.query({
            "entity_type": "script",
            "has_cli": True,
            "linked_sprint": sprint
        })
        
        # For each script, fetch its test results
        results = []
        for script in scripts:
            tests = self.linker.link_script_to_tests(script["entity_id"])
            results.append({
                "script": script["name"],
                "path": script["path"],
                "sprint": sprint,
                "test_count": len(tests),
                "passing": sum(1 for t in tests if t["status"] == "passed"),
                "status": "covered" if tests else "no_tests"
            })
        
        return {
            "total_clis": len(results),
            "covered": sum(1 for r in results if r["status"] == "covered"),
            "uncovered": sum(1 for r in results if r["status"] == "no_tests"),
            "records": results
        }
```

---

## 7. Department Modules

### 7.1 Development Module

**Tracked entities:** scripts, CLIs, functions, modules, commits, branches, pull requests

**Key queries it handles:**
- How many CLIs exist in the codebase?
- Which scripts are linked to Sprint X?
- Which files haven't been touched in 90+ days?
- Which developers contributed most to Sprint 24?

**Required connectors:** Git/SVN, Jira/Azure DevOps

---

### 7.2 QA / Testing Module

**Tracked entities:** test cases, test runs, test results, coverage maps

**Key queries it handles:**
- How many features from Sprint 23 are untested?
- What is the pass/fail rate for this release?
- Which test cases have been failing for 3+ consecutive runs?
- What percentage of CLI scripts have test coverage?

**Required connectors:** TestRail, Jira, Excel/CSV file watcher

---

### 7.3 HR & Finance Module (restricted access)

**Tracked entities:** employees, departments, roles, leave records

**Key queries it handles:**
- Total headcount by department
- Who joined or left this month?
- How many employees are on leave this week?
- Payroll total by department (Finance-only partition)

**Required connectors:** BambooHR / Workday / Greythr API, Payroll ERP

**IMPORTANT:** Salary and PII data must be stored in an encrypted, access-controlled partition separate from all other data.

---

### 7.4 Admin / Operations Module

**Tracked entities:** software licenses, hardware assets, SaaS subscriptions, IT tickets

**Key queries it handles:**
- Which licenses expire in the next 60 days?
- What is total SaaS spend this quarter?
- How many open IT support tickets are critical?

**Required connectors:** ServiceNow / Freshservice API, license management tools, spreadsheet ingestion

---

### 7.5 Deployment Module

**Tracked entities:** pipelines, builds, deployments, environments, service versions

**Key queries it handles:**
- What was deployed to production last week?
- Which services haven't been deployed in 30 days?
- What is the average build time for Service X?
- How many failed deployments happened in Sprint 24?

**Required connectors:** Jenkins API, GitHub Actions API, Kubernetes API, AWS/GCP deployment APIs

---

## 8. Output & Report Generation

### Excel Report Generation

```python
import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

def generate_cli_report(data: dict, output_path: str):
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "CLI Coverage Report"
    
    # Header styling
    HEADER_FILL = PatternFill("solid", fgColor="4B2D8F")  # Brand purple
    HEADER_FONT = Font(bold=True, color="FFFFFF", size=11)
    
    headers = ["Script Name", "File Path", "Sprint", "Tests Count", "Passing", "Status"]
    
    for col, header in enumerate(headers, 1):
        cell = ws.cell(row=1, column=col, value=header)
        cell.fill = HEADER_FILL
        cell.font = HEADER_FONT
        cell.alignment = Alignment(horizontal="center")
    
    # Data rows
    for row_idx, record in enumerate(data["records"], 2):
        ws.cell(row=row_idx, column=1, value=record["script"])
        ws.cell(row=row_idx, column=2, value=record["path"])
        ws.cell(row=row_idx, column=3, value=record["sprint"])
        ws.cell(row=row_idx, column=4, value=record["test_count"])
        ws.cell(row=row_idx, column=5, value=record["passing"])
        
        # Conditional color: red for no coverage, green for covered
        status_cell = ws.cell(row=row_idx, column=6, value=record["status"])
        if record["status"] == "no_tests":
            status_cell.fill = PatternFill("solid", fgColor="FFD7D7")
            status_cell.font = Font(color="A32D2D")
        else:
            status_cell.fill = PatternFill("solid", fgColor="D4EDD4")
            status_cell.font = Font(color="276221")
    
    # Summary row
    summary_row = len(data["records"]) + 3
    ws.cell(row=summary_row, column=1, value="TOTAL CLIs").font = Font(bold=True)
    ws.cell(row=summary_row, column=4, value=data["total_clis"]).font = Font(bold=True)
    ws.cell(row=summary_row, column=5, value=data["covered"]).font = Font(bold=True)
    
    # Auto-fit column widths
    for col in ws.columns:
        max_len = max(len(str(cell.value or "")) for cell in col)
        ws.column_dimensions[get_column_letter(col[0].column)].width = min(max_len + 4, 50)
    
    # Freeze header row
    ws.freeze_panes = "A2"
    
    wb.save(output_path)
    return output_path
```

### Scheduled Report via Email

```python
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.base import MIMEBase
from email.mime.text import MIMEText
from email import encoders
import schedule
import time

def send_weekly_report(recipient: str, report_path: str):
    msg = MIMEMultipart()
    msg["From"] = "reports@yourorg.com"
    msg["To"] = recipient
    msg["Subject"] = "Weekly CLI Coverage Report – Auto Generated"
    
    body = "Please find this week's CLI coverage report attached."
    msg.attach(MIMEText(body, "plain"))
    
    with open(report_path, "rb") as f:
        part = MIMEBase("application", "octet-stream")
        part.set_payload(f.read())
        encoders.encode_base64(part)
        part.add_header("Content-Disposition", f"attachment; filename=cli_report.xlsx")
        msg.attach(part)
    
    with smtplib.SMTP("smtp.yourorg.com", 587) as server:
        server.starttls()
        server.login("reports@yourorg.com", "SMTP_PASSWORD")
        server.sendmail(msg["From"], recipient, msg.as_string())

# Schedule for every Monday at 9am
schedule.every().monday.at("09:00").do(
    send_weekly_report,
    recipient="manager@yourorg.com",
    report_path="/tmp/weekly_cli_report.xlsx"
)
```

---

## 9. Security, RBAC & Audit

### Role Definitions

```python
ROLE_PERMISSIONS = {
    "engineering_manager": {
        "allowed_departments": ["development", "qa", "deployment"],
        "denied_departments": ["hr_sensitive", "finance_payroll"],
        "can_export": True,
        "can_schedule_reports": True
    },
    "hr_manager": {
        "allowed_departments": ["hr", "hr_sensitive"],
        "denied_departments": ["development", "qa", "finance_payroll"],
        "can_export": True,
        "can_schedule_reports": True
    },
    "finance_head": {
        "allowed_departments": ["finance", "finance_payroll", "hr"],
        "denied_departments": ["development", "deployment"],
        "can_export": True,
        "can_schedule_reports": True
    },
    "developer": {
        "allowed_departments": ["development", "qa"],
        "denied_departments": ["hr", "hr_sensitive", "finance", "finance_payroll"],
        "can_export": False,
        "can_schedule_reports": False
    }
}

def check_query_permission(user_role: str, required_departments: list) -> dict:
    role = ROLE_PERMISSIONS.get(user_role, {})
    allowed = role.get("allowed_departments", [])
    denied = [d for d in required_departments if d not in allowed]
    
    return {
        "permitted": len(denied) == 0,
        "denied_scopes": denied
    }
```

### Audit Log

```python
import json
from datetime import datetime

def log_query(user_id: str, user_role: str, query: str, 
              departments_accessed: list, result_row_count: int):
    entry = {
        "timestamp": datetime.utcnow().isoformat(),
        "user_id": user_id,
        "user_role": user_role,
        "raw_query": query,
        "departments_accessed": departments_accessed,
        "result_row_count": result_row_count,
        "session_id": get_current_session_id()
    }
    # Write to append-only audit log (never delete, never update)
    with open("/var/log/edip/audit.jsonl", "a") as f:
        f.write(json.dumps(entry) + "\n")
```

---

## 10. Tech Stack Recommendations

### Backend

| Component | Recommended Technology | Alternative |
|---|---|---|
| API Server | FastAPI (Python) | Express.js (Node) |
| Task Queue | Celery + Redis | BullMQ (Node) |
| Sync Scheduler | APScheduler or cron | Airflow (if complex DAGs) |
| AI/LLM Layer | Anthropic Claude API | OpenAI |
| Primary DB | PostgreSQL | MySQL |
| Search/Vector Store | Elasticsearch or Qdrant | Meilisearch |
| Cache | Redis | Memcached |
| File Queue | RabbitMQ | AWS SQS |

### Frontend

| Component | Recommended Technology |
|---|---|
| Web App | React + TypeScript |
| UI Components | shadcn/ui or Ant Design |
| Charts | Recharts or Apache ECharts |
| Excel Export | ExcelJS or SheetJS |

### Infrastructure

| Component | Recommended |
|---|---|
| Containerization | Docker + Docker Compose |
| Orchestration | Kubernetes (production) |
| Secrets Management | HashiCorp Vault or AWS Secrets Manager |
| CI/CD | GitHub Actions |
| Monitoring | Prometheus + Grafana |
| Logging | ELK Stack or Loki |

### Project Structure

```
edip/
+-- connectors/                  # One file per platform
¦   +-- git_connector.py
¦   +-- jira_connector.py
¦   +-- bamboohr_connector.py
¦   +-- testrail_connector.py
¦   +-- jenkins_connector.py
¦   +-- sharepoint_connector.py
+-- pipeline/
¦   +-- extractor.py
¦   +-- transformer.py
¦   +-- validator.py
¦   +-- enricher.py
¦   +-- loader.py
+-- engine/
¦   +-- query_parser.py          # LLM-based NL understanding
¦   +-- query_planner.py         # Translate intent to data ops
¦   +-- query_executor.py        # Deterministic data fetch
¦   +-- entity_linker.py         # Cross-domain joins
+-- modules/
¦   +-- development.py
¦   +-- qa.py
¦   +-- hr.py
¦   +-- finance.py
¦   +-- deployment.py
¦   +-- admin.py
+-- output/
¦   +-- excel_generator.py
¦   +-- pdf_generator.py
¦   +-- dashboard_api.py
¦   +-- email_sender.py
+-- security/
¦   +-- rbac.py
¦   +-- audit_logger.py
¦   +-- encryption.py
+-- api/
¦   +-- main.py                  # FastAPI app
¦   +-- routes/
¦   +-- middleware/
+-- models/
¦   +-- entities.py              # Pydantic models for all entity types
+-- config/
¦   +-- settings.py
¦   +-- connector_config.yaml    # Credentials refs (not actual secrets)
+-- tests/
+-- docker-compose.yml
+-- .env.example
```

---

## 11. Developer Setup Guide

### Step 1: Environment Setup

```bash
# Clone and set up
git clone https://github.com/yourorg/edip.git
cd edip
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# Copy and fill in your .env file
cp .env.example .env
```

### Step 2: Configure Your .env File

```env
# === DATABASE ===
DATABASE_URL=postgresql://edip_user:password@localhost:5432/edip_db

# === REDIS ===
REDIS_URL=redis://localhost:6379

# === LLM ===
ANTHROPIC_API_KEY=sk-ant-...

# === JIRA ===
JIRA_BASE_URL=https://yourorg.atlassian.net
JIRA_EMAIL=service-account@yourorg.com
JIRA_API_TOKEN=your_jira_token_here
JIRA_BOARD_IDS=5,12,18   # comma-separated board IDs to sync

# === GIT ===
GITHUB_PAT=ghp_...
GITHUB_ORGS=yourorg
GIT_SYNC_BRANCHES=main,develop

# === BAMBOOHR ===
BAMBOOHR_SUBDOMAIN=yourcompany
BAMBOOHR_API_KEY=your_key_here

# === TESTRAIL ===
TESTRAIL_URL=https://yourorg.testrail.io
TESTRAIL_EMAIL=service-account@yourorg.com
TESTRAIL_API_KEY=your_key_here

# === JENKINS ===
JENKINS_URL=https://jenkins.yourorg.com
JENKINS_USER=edip-readonly
JENKINS_TOKEN=your_token_here

# === EMAIL (for scheduled reports) ===
SMTP_HOST=smtp.yourorg.com
SMTP_PORT=587
SMTP_USER=reports@yourorg.com
SMTP_PASSWORD=your_smtp_password
```

### Step 3: Initialize the Database

```bash
# Apply database migrations
python manage.py migrate

# Create initial roles and admin user
python manage.py seed_roles
python manage.py create_admin --email admin@yourorg.com
```

### Step 4: Test Each Connector

```bash
# Test each connector individually before running full sync
python -m connectors.git_connector --test
python -m connectors.jira_connector --test
python -m connectors.bamboohr_connector --test
python -m connectors.testrail_connector --test
```

### Step 5: Run First Full Sync

```bash
# Sync all connectors (first run will be slow — indexes everything)
python -m pipeline.run_sync --full

# Or sync one at a time:
python -m pipeline.run_sync --connector git --full
python -m pipeline.run_sync --connector jira --full
python -m pipeline.run_sync --connector testrail --full
```

### Step 6: Start the Application

```bash
# Start all services
docker-compose up -d

# Or start individually for development
uvicorn api.main:app --reload --port 8000

# Start the sync worker
celery -A pipeline.worker worker --loglevel=info

# Start the sync scheduler
celery -A pipeline.worker beat --loglevel=info
```

### Step 7: Verify with a Test Query

```bash
curl -X POST http://localhost:8000/api/query \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query": "how many CLI scripts are in Sprint 24?"}'
```

Expected response:
```json
{
  "summary": "47 CLI scripts found in Sprint 24. 31 have passing test coverage, 16 have no tests.",
  "data": {
    "total_clis": 47,
    "covered": 31,
    "uncovered": 16
  },
  "export_url": "/api/export/cli-sprint24-report.xlsx",
  "query_id": "qry_abc123"
}
```

---

## 12. Phased Delivery Roadmap

### Phase 1 — MVP (Months 1–4)

**Goal:** Solve the original problem (CLI/script discovery and sprint reporting)

- [ ] Git connector (GitHub / GitLab / Bitbucket)
- [ ] Jira connector (sprints, tickets, status)
- [ ] TestRail / Excel connector (test results)
- [ ] Development module
- [ ] QA module
- [ ] Basic NL query engine
- [ ] Excel/CSV export
- [ ] Web UI with simple query box
- [ ] Basic RBAC (Developer / Manager roles)

**Success metric:** Manager can ask "which CLIs are in Sprint 24?" and get an Excel report in under 30 seconds.

---

### Phase 2 — Expand (Months 5–8)

**Goal:** Cover HR, Finance, Admin; add live dashboards

- [ ] BambooHR / Workday connector
- [ ] Payroll ERP connector (encrypted HR partition)
- [ ] ServiceNow / license management connector
- [ ] HR module
- [ ] Finance module
- [ ] Admin module
- [ ] Live dashboard with KPI tiles and charts
- [ ] Scheduled email reports
- [ ] Slack bot integration (query via Slack)
- [ ] All department roles in RBAC

**Success metric:** HR manager can run a headcount + leave report without touching Excel manually.

---

### Phase 3 — Enterprise (Months 9–14)

**Goal:** Full cross-domain intelligence, enterprise-grade scale and compliance

- [ ] Cross-domain queries (join Dev + HR + QA in one query)
- [ ] Vector search (semantic "find scripts similar to this one")
- [ ] Deployment module (Jenkins, GitHub Actions, Kubernetes)
- [ ] PDF branded report generation
- [ ] REST API for external BI tools (Power BI, Tableau)
- [ ] Webhooks for real-time triggers
- [ ] SOC 2 audit readiness
- [ ] GDPR data subject request handling
- [ ] Full audit log dashboard
- [ ] Multi-tenant support (multiple organizations)

---

## 13. Key Risks & How to Handle Them

| Risk | Impact | Mitigation |
|---|---|---|
| API rate limits on Jira/GitHub | Sync delays | Implement exponential backoff; spread syncs across time windows |
| HR/payroll data leak | Critical | Hard partition with separate encryption key; audit every access |
| LLM misinterprets a query | Wrong data returned | Always show the interpreted query to user before executing; allow correction |
| Large repos slow to index | Slow first sync | Incremental sync after initial; use `git log --since` for updates |
| Connector token expiry | Silent data gaps | Monitor token expiry, alert 7 days before; auto-refresh where OAuth supports it |
| Schema drift in source systems | Ingest failures | Version your entity schema; add schema validation with alerts on unexpected fields |
| Employee queries privacy | Legal exposure | Enforce RBAC strictly; log all HR queries; get legal review before launch |

---

*Document version 1.0 — Generated for EDIP Architecture Planning*
*Review this document with your security and legal teams before connecting HR and Finance data sources.*