# Eka Automation — Docker & Microservices Guide

## What Changed

| File / Folder | Change |
|---|---|
| `main.py` | `DATABASE_URL` reads from env — supports SQLite (dev) **or** PostgreSQL (Docker). Added `/health` endpoint. |
| `requirements.txt` | Added `psycopg2-binary` for PostgreSQL driver. |
| `Dockerfile` | New — builds the core monolith image (Python 3.11-slim). |
| `docker-compose.yml` | New — orchestrates all 6 containers. |
| `.env` / `.env.example` | New — DB credentials and secrets (never commit `.env`). |
| `nginx/nginx.conf` | New — API Gateway: routes each tab to its own service. |
| `services/execute-service/` | New — Execute Tab isolated service (port 8002). |
| `services/vs-service/` | New — VS Manager Tab isolated service (port 8003). |
| `services/hardware-service/` | New — Hardware Load Tab isolated service (port 8005). |
| `.gitignore` | Added `.env`, Docker volumes. |

---

## Container Flow

```
Browser (http://localhost)
        │
        ▼
┌─────────────────────────────────┐
│        NGINX  :80               │  ← Single entry point for all tabs
│        API Gateway              │
└──┬──────┬──────┬──────┬─────────┘
   │      │      │      │
   ▼      ▼      ▼      ▼
┌──────┐ ┌────────────┐ ┌────────┐ ┌──────────┐
│Core  │ │Execute Svc │ │VS Svc  │ │Hardware  │
│:8000 │ │:8002       │ │:8003   │ │Svc :8005 │
│      │ │            │ │        │ │          │
│Devs  │ │SpyTest     │ │virsh   │ │ONIE/     │
│Logs  │ │Scripts     │ │VM      │ │Telnet    │
│Term  │ │Log stream  │ │Lifecycle│ │Install  │
└──┬───┘ └─────┬──────┘ └───┬────┘ └────┬─────┘
   │           │             │           │
   └───────────┴─────────────┴───────────┘
                      │
                      ▼
           ┌──────────────────┐
           │   PostgreSQL     │
           │   :5432          │
           │  (shared DB for  │
           │   all services)  │
           └──────────────────┘
```

**Nginx Route Map:**

| URL Pattern | Goes To |
|---|---|
| `/` , `/static` | `eka-core:8000` (Dashboard, Devices, Logs, Terminal) |
| `/api/executions`, `/api/spytest`, `/ws/execution` | `eka-execute:8002` |
| `/api/vs` , `/ws/vs` | `eka-vs:8003` |
| `/api/hardware-load` | `eka-hardware:8005` |
| `/api/duts`, `/api/sessions`, `/ws` (PTY) | `eka-core:8000` |

---

## How to Run

### Prerequisites
- Install **Docker Desktop**: https://www.docker.com/products/docker-desktop/
- After install, ensure Docker is running (whale icon in taskbar).

### Step 1 — Configure secrets
```powershell
# Edit .env — change the password before first run
notepad .env
```
```env
POSTGRES_PASSWORD=your_strong_password_here
SECRET_KEY=your_random_32char_key_here
```

### Step 2 — Build all images
```powershell
# Run from Eka-master directory (takes ~10 min first time, cached after)
docker-compose build
```

### Step 3 — Start all services
```powershell
docker-compose up -d
```

### Step 4 — Verify all containers are healthy
```powershell
docker-compose ps
# All services should show "healthy" after ~30 seconds
```

### Step 5 — Open the app
```
http://localhost
```

### Useful Commands
```powershell
docker-compose logs -f eka-core        # Live logs — core app
docker-compose logs -f eka-execute     # Live logs — execute service
docker-compose stop eka-hardware       # Stop one service (others keep running!)
docker-compose restart eka-vs          # Restart just VS Manager
docker-compose down                    # Stop everything
docker-compose down -v                 # Stop + delete database volume (data loss!)
```

---

## How to Share / Deploy

### Option A — Share the code (Git)
```powershell
git add .
git commit -m "feat: Docker microservices + PostgreSQL"
git push
# Receiver runs: docker-compose up -d
```
> ⚠️ Never push `.env` — it contains passwords. Share it separately via a secure channel.

### Option B — Export as Docker images (no internet needed)
```powershell
# Save all images to a single tar file (~500 MB)
docker save eka-master-eka-core eka-master-eka-execute eka-master-eka-vs eka-master-eka-hardware -o eka_images.tar

# On the receiving machine:
docker load -i eka_images.tar
docker-compose up -d
```

### Option C — Push to Docker Hub / Private Registry
```powershell
docker tag eka-master-eka-core yourcompany/eka-core:1.0
docker push yourcompany/eka-core:1.0
# Update docker-compose.yml image: fields on receiving machine
```

---

## Fault Isolation — The Key Benefit

| Scenario | Before (Monolith) | After (Microservices) |
|---|---|---|
| Execute tab hangs | **All tabs crash** | Only Execute tab affected |
| Hardware Load crashes | **All tabs crash** | Only Hardware tab affected |
| VS Manager error | **All tabs crash** | Only VS Manager affected |
| DB write conflict | **SQLite blocks all** | PostgreSQL handles concurrent writes |

---

> **Local dev (no Docker):** App still works with SQLite as before — just run `python main.py`. Docker is only needed for the microservices architecture.
