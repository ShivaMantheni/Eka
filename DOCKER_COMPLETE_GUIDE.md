# 🐳 The Complete Docker Guide for Absolute Beginners

*From Zero to Docker Hero - Explained Like You're Teaching a Friend*

---

## 📦 1. What is Docker? (The Shipping Container Analogy)

### The Problem Docker Solves

Imagine you're a chef who created an amazing recipe. It works perfectly in your kitchen. But when you send the recipe to a restaurant in another city, they say:

- "We don't have this type of oven"
- "Our ingredients are different brands"
- "The temperature units are in Celsius, not Fahrenheit"

**This is exactly what happens with software:**
- "It works on my computer but not yours"
- "You have Python 3.10, I have Python 3.12"
- "Your operating system is different"

### Enter Docker: The Shipping Container of Software

**Before Shipping Containers (1950s):**
```
🚢 Ship arrives at port
👷 Workers unload thousands of different boxes, barrels, crates
📦 Different sizes, different handling methods
⏰ Takes weeks to unload
💸 Very expensive
```

**After Shipping Containers (1960s+):**
```
🚢 Ship arrives with standardized containers
🏗️ Crane lifts entire container
📦 Same container fits on ship, truck, or train
⏰ Takes hours to unload
💰 Much cheaper
```

**Docker Does This for Software:**

| Without Docker | With Docker |
|----------------|-------------|
| "Works on my machine" | Works everywhere the same way |
| Install Python, libraries, dependencies manually | Everything included in one package |
| Different setup for dev, test, production | Identical environment everywhere |
| Hours to set up new server | Minutes to deploy |

### Real-World Example

**Without Docker:**
```
Setting up application on new server:
1. Install Ubuntu 22.04
2. Install Python 3.12
3. Install 47 Python packages (hope versions match)
4. Install PostgreSQL
5. Configure everything
6. Fix errors for 6 hours
7. Finally works (maybe)
```

**With Docker:**
```
Setting up application on new server:
1. Install Docker
2. Run: docker-compose up
3. ✅ Application running (5 minutes)
```

> **How to Explain This to Someone Else:**
> Docker is like a shipping container for software. Just like a shipping container holds all your stuff and can go anywhere (ship, train, truck), a Docker container holds your entire application (code, dependencies, settings) and runs anywhere (your laptop, cloud server, anywhere). No more "it works on my machine" problems.

---

## 🧩 2. Docker Components - The Complete Ecosystem

Think of Docker like building a house. Here are all the parts:

### **🏗️ Docker Engine** - The Foundation

**What it is:** The core program that runs Docker on your computer.

**Analogy:** Like the **construction crew** that actually builds houses from blueprints.

**Components:**
- **Docker Daemon** (`dockerd`) - Background service that manages everything
- **Docker CLI** (`docker` command) - Your control panel to talk to the daemon
- **REST API** - How programs communicate with Docker

```bash
# Check if Docker Engine is running
sudo systemctl status docker

# Start Docker Engine
sudo systemctl start docker

# Version check
docker --version
# Output: Docker version 24.0.5, build ced0996
```

---

### **📜 Dockerfile** - The Recipe/Blueprint

**What it is:** A text file with instructions to build a Docker image.

**Analogy:** Like a **recipe card** with step-by-step cooking instructions.

**Example Dockerfile:**
```dockerfile
# Start with a base (like starting with a cake mix)
FROM python:3.12-slim

# Set working directory (like clearing your counter)
WORKDIR /app

# Copy recipe/requirements (like getting your ingredient list)
COPY requirements.txt .

# Install ingredients (like buying groceries)
RUN pip install -r requirements.txt

# Copy your actual code (like bringing your cooking utensils)
COPY . .

# What to do when container starts (like "bake at 350°F")
CMD ["python", "app.py"]
```

**Every line explained:**
- `FROM` - Starting point (base image)
- `WORKDIR` - Where to work inside the container
- `COPY` - Copy files from your computer to container
- `RUN` - Execute commands during build (happens once)
- `CMD` - Command to run when container starts (happens every time)

---

### **🖼️ Docker Image** - The Template/Blueprint

**What it is:** A snapshot/template of your application with everything it needs.

**Analogy:** Like a **frozen dinner** - everything prepared and packaged, just needs heating.

**Properties:**
- **Read-only** - Can't be changed (create new version instead)
- **Layered** - Built in layers like a cake
- **Portable** - Can be shared and run anywhere
- **Versioned** - Can have multiple versions with tags

```bash
# List all images on your computer
docker images
# or
docker image ls

# Output looks like:
REPOSITORY          TAG       IMAGE ID       CREATED        SIZE
python              3.12      1234abcd5678   2 weeks ago    500MB
eka-automation      latest    abcd1234efgh   1 hour ago     850MB
postgres            15        5678efgh9012   1 month ago    200MB
```

**Image naming format:**
```
repository/name:tag
└─────┬─────┘└┬─┘└┬┘
      │       │   │
      │       │   └─ Version (e.g., "latest", "v1.2.0", "prod")
      │       └───── Image name
      └───────────── Where it's stored (optional)

Examples:
python:3.12              → Official Python image, version 3.12
nginx:alpine             → Official Nginx, Alpine Linux version
myuser/myapp:v2.0        → Your app on Docker Hub, version 2.0
localhost:5000/app:dev   → Your private registry, dev version
```

---

### **📦 Docker Container** - The Running Instance

**What it is:** A running copy of an image.

**Analogy:** Like the **actual cooked meal** made from a recipe. The recipe (image) stays the same, but you can cook multiple meals (containers).

**Image vs Container:**
```
Image (Recipe)          Container (Cooked Meal)
├─ Static               ├─ Running/Active
├─ Template             ├─ Instance
├─ On disk              ├─ In memory
├─ Shareable            ├─ Temporary
└─ One recipe →         └─ Many meals
```

```bash
# Run a container from an image
docker run nginx
#     └─ image name

# List running containers
docker ps

# List ALL containers (running and stopped)
docker ps -a

# Output:
CONTAINER ID   IMAGE     COMMAND                  STATUS
abc123def456   nginx     "/docker-entrypoint…"   Up 5 minutes
```

**Container States:**
```
Created → Running → Paused → Stopped → Removed
   ↓         ↓         ↓         ↓         ↓
 Built    Active   Frozen   Inactive   Deleted
```

---

### **📚 Docker Registry** - The Library/Warehouse

**What it is:** A storage location for Docker images.

**Analogy:** Like **GitHub for Docker images** or a **library for recipes**.

**Types:**
1. **Docker Hub** (hub.docker.com) - Public registry (like GitHub)
2. **Private Registry** - Your own storage (like GitLab private repos)
3. **Cloud Registries** - AWS ECR, Google GCR, Azure ACR

```bash
# Pull (download) an image from registry
docker pull python:3.12
#           └─────┬────┘
#                 └─ This comes from Docker Hub by default

# Push (upload) your image to registry
docker push myusername/myapp:v1.0

# Login to registry
docker login
# or for private registry
docker login myregistry.com

# Tag an image before pushing
docker tag myapp:latest myusername/myapp:v1.0
```

---

### **🎼 Docker Compose** - The Orchestrator

**What it is:** A tool to run multiple containers together.

**Analogy:** Like a **restaurant manager** coordinating the kitchen, bar, and dining room.

**Why you need it:**
- Running one container: `docker run ...` (simple)
- Running 3+ containers: Need to coordinate them (complex)
- Docker Compose: One config file, one command

**docker-compose.yml example:**
```yaml
version: '3.8'

services:
  # Container 1: Web app
  web:
    build: .
    ports:
      - "8000:8000"
    depends_on:
      - db

  # Container 2: Database
  db:
    image: postgres:15
    environment:
      POSTGRES_PASSWORD: secret
    volumes:
      - db_data:/var/lib/postgresql/data

volumes:
  db_data:
```

```bash
# Start all containers
docker-compose up

# Start in background
docker-compose up -d

# Stop all containers
docker-compose down

# View logs
docker-compose logs
```

---

### **💾 Docker Volume** - Persistent Storage

**What it is:** A way to save data that survives when containers are deleted.

**Analogy:** Like a **USB drive** or **external hard drive** - plug into any computer and your data is there.

**The Problem:**
```
Container created → Write data → Container deleted → DATA LOST! 😱
```

**The Solution:**
```
Container created → Write to Volume → Container deleted → Volume keeps data ✅
New container created → Mount same Volume → Data still there! 🎉
```

**Types of Storage:**

| Type | Managed By | Use Case | Persistence |
|------|-----------|----------|-------------|
| **Volume** | Docker | Databases, app data | ✅ Survives container deletion |
| **Bind Mount** | You | Development (live code changes) | ✅ Survives container deletion |
| **tmpfs** | RAM | Temporary secrets | ❌ Lost on container stop |

```bash
# Create a named volume
docker volume create my_data

# List volumes
docker volume ls

# Run container with volume
docker run -v my_data:/app/data myapp
#          └────┬────┘└────┬───┘
#               │          └─ Path inside container
#               └─ Volume name

# Bind mount (map local folder)
docker run -v /home/user/code:/app myapp
#          └────────┬────────┘└─┬┘
#                   │           └─ Container path
#                   └─ Your computer path

# Remove unused volumes
docker volume prune
```

---

### **🌐 Docker Network** - Container Communication

**What it is:** How containers talk to each other.

**Analogy:** Like a **telephone system** or **office intercom** connecting different departments.

**Network Types:**

| Network Type | Description | Use Case |
|-------------|-------------|----------|
| **bridge** | Default, isolated network | Containers on same host |
| **host** | Uses host's network directly | Maximum performance |
| **none** | No network | Isolated containers |
| **custom** | User-defined bridge | Complex apps |

```bash
# Create custom network
docker network create my-network

# List networks
docker network ls

# Run container on specific network
docker run --network my-network nginx

# Connect running container to network
docker network connect my-network container_name

# Inspect network details
docker network inspect my-network
```

**Container Communication Example:**
```yaml
# docker-compose.yml
services:
  web:
    image: nginx
    networks:
      - frontend

  api:
    image: myapi
    networks:
      - frontend
      - backend

  db:
    image: postgres
    networks:
      - backend

networks:
  frontend:  # Web can talk to API
  backend:   # API can talk to DB, but Web cannot talk to DB
```

**How containers find each other:**
```bash
# Inside web container, can reach api container by name:
curl http://api:8000/users
#          └─┬─┘
#            └─ Container name becomes hostname!
```

> **How to Explain This to Someone Else:**
> Docker has several parts working together. The **Dockerfile** is your recipe, the **Image** is like a frozen dinner made from that recipe, and the **Container** is the hot meal running on your plate. **Docker Compose** is like a restaurant manager running the whole kitchen, **Volumes** are USB drives to save your data, and **Networks** are phone lines so containers can talk to each other.

---

## 🔄 3. How Docker Works - Full Lifecycle & Main Commands

### The Complete Journey: From Code to Running App

```
Step 1: Write Code          Step 2: Create Recipe       Step 3: Build Image
┌─────────────┐            ┌─────────────┐            ┌─────────────┐
│   app.py    │            │ Dockerfile  │            │ Docker      │
│  styles.css │  ─────────>│             │ ─────────> │   Build     │
│ config.json │            │ Instructions│            │  Process    │
└─────────────┘            └─────────────┘            └─────────────┘
   Your Code                  Recipe                       ↓
                                                           ↓
Step 4: Push to Registry    Step 5: Pull from Registry  Step 6: Run Container
┌─────────────┐            ┌─────────────┐            ┌─────────────┐
│ Docker Hub  │<──────────│ Other Server│            │  Running    │
│ myapp:v1.0  │           │ docker pull │ ─────────> │ Application │
│             │           │             │            │  Port 8000  │
└─────────────┘            └─────────────┘            └─────────────┘
   Storage                    Download                   Live!
```

### 🎯 Core Docker Commands - The Essential 10

---

#### **1. `docker pull` - Download an Image**

**Purpose:** Download an image from a registry to your computer.

```bash
docker pull IMAGE[:TAG]
#           └─┬─┘ └┬─┘
#             │    └─ Version (optional, defaults to 'latest')
#             └─ Image name

# Examples:
docker pull nginx
# Downloads: nginx:latest (latest version)

docker pull python:3.12
# Downloads: python version 3.12 specifically

docker pull postgres:15-alpine
# Downloads: postgres version 15, Alpine Linux flavor
```

**What happens:**
1. Contacts Docker Hub (or specified registry)
2. Downloads image layers one by one
3. Stores in local image cache
4. Ready to run!

**Flags:**
```bash
# Pull all tags of an image
docker pull -a nginx

# Pull from specific registry
docker pull myregistry.com:5000/myapp:v1.0

# Pull quietly (less output)
docker pull -q nginx
```

---

#### **2. `docker run` - Start a Container**

**Purpose:** Create and start a new container from an image.

**This is THE most important command!**

```bash
docker run [OPTIONS] IMAGE [COMMAND]
#          └───┬───┘ └─┬─┘ └───┬──┘
#              │       │       └─ Command to run inside container (optional)
#              │       └─ Image to use
#              └─ Configuration options

# Basic run
docker run nginx
# Creates and starts Nginx web server

# Run with a name
docker run --name my-webserver nginx
#          └────────┬──────────┘
#                   └─ Give it a friendly name

# Run in background (detached mode)
docker run -d nginx
#          └┬┘
#           └─ -d = detached (runs in background)

# Run with port mapping
docker run -p 8080:80 nginx
#          └────┬────┘
#               └─ host_port:container_port
# Access at: http://localhost:8080

# Run with volume
docker run -v my_data:/app/data myapp
#          └──────┬──────────────┘
#                 └─ volume_name:container_path

# Run with environment variable
docker run -e DATABASE_URL=postgres://localhost myapp
#          └─────────┬──────────────────────────┘
#                    └─ -e KEY=VALUE

# Run interactively (for debugging)
docker run -it ubuntu bash
#          └┬┘ └───┘ └──┘
#           │   │     └─ Command to run
#           │   └─ Image
#           └─ -i (interactive) + -t (terminal)

# Run with automatic removal
docker run --rm nginx
#          └─┬┘
#            └─ Remove container when it stops

# Run with resource limits
docker run --memory="512m" --cpus="1.5" nginx
#          └───────┬──────┘ └─────┬────┘
#                  │               └─ CPU cores (1.5 cores)
#                  └─ RAM limit (512 megabytes)

# Complex example (all together)
docker run -d \
  --name my-app \
  -p 8000:8000 \
  -v app_data:/data \
  -e API_KEY=secret123 \
  --restart unless-stopped \
  myapp:v1.0

# Explanation:
# -d                    → Run in background
# --name my-app         → Name it "my-app"
# -p 8000:8000         → Map port 8000
# -v app_data:/data    → Mount volume
# -e API_KEY=secret123 → Set environment variable
# --restart unless-stopped → Auto-restart if crashes
# myapp:v1.0           → Image to run
```

**Common Options:**

| Flag | What It Does | Example |
|------|--------------|---------|
| `-d` | Run in background (detached) | `docker run -d nginx` |
| `-p` | Map port (host:container) | `docker run -p 8080:80 nginx` |
| `-v` | Mount volume | `docker run -v data:/app nginx` |
| `-e` | Set environment variable | `docker run -e DB_HOST=postgres nginx` |
| `--name` | Give container a name | `docker run --name web nginx` |
| `-it` | Interactive terminal | `docker run -it ubuntu bash` |
| `--rm` | Remove when stopped | `docker run --rm nginx` |
| `--restart` | Restart policy | `docker run --restart always nginx` |

---

#### **3. `docker build` - Create an Image**

**Purpose:** Build a Docker image from a Dockerfile.

```bash
docker build [OPTIONS] PATH
#            └───┬───┘ └─┬┘
#                │       └─ Where Dockerfile is located
#                └─ Build options

# Basic build (looks for ./Dockerfile)
docker build .

# Build with tag/name
docker build -t myapp:v1.0 .
#            └──────┬──────┘
#                   └─ -t = tag (name:version)

# Build with specific Dockerfile
docker build -f Dockerfile.prod -t myapp:prod .
#            └────────┬─────────┘
#                     └─ Use Dockerfile.prod instead of Dockerfile

# Build with build arguments
docker build --build-arg VERSION=1.2.0 -t myapp .
#            └──────────────┬──────────────┘
#                           └─ Pass variable to Dockerfile

# Build without cache (fresh build)
docker build --no-cache -t myapp .
#            └────┬─────┘
#                 └─ Don't use cached layers

# Build with target stage (multi-stage builds)
docker build --target production -t myapp .
#            └────────┬────────┘
#                     └─ Build only 'production' stage

# Complex example
docker build \
  -t myapp:v2.0 \
  -t myapp:latest \
  --build-arg ENV=prod \
  --no-cache \
  -f Dockerfile.prod \
  .

# Explanation:
# -t myapp:v2.0         → Tag as version 2.0
# -t myapp:latest       → Also tag as latest
# --build-arg ENV=prod  → Set ENV=prod during build
# --no-cache            → Force rebuild everything
# -f Dockerfile.prod    → Use specific Dockerfile
# .                     → Build context (current directory)
```

**What happens during build:**
```
1. Read Dockerfile
2. Execute each instruction (FROM, RUN, COPY, etc.)
3. Create a layer for each instruction
4. Cache layers for future builds
5. Tag final image
6. Ready to run!
```

---

#### **4. `docker ps` - List Containers**

**Purpose:** Show running containers (or all containers).

```bash
# List running containers
docker ps

# Output:
CONTAINER ID   IMAGE     COMMAND       CREATED        STATUS         PORTS                    NAMES
abc123def456   nginx     "nginx..."    5 minutes ago  Up 5 minutes   0.0.0.0:8080->80/tcp    web
789ghi012jkl   postgres  "postgres..." 1 hour ago     Up 1 hour      5432/tcp                db

# List ALL containers (including stopped)
docker ps -a
#         └┬┘
#          └─ -a = all

# List only container IDs
docker ps -q
#         └┬┘
#          └─ -q = quiet (IDs only)

# List with size information
docker ps -s
#         └┬┘
#          └─ -s = size

# List last N containers
docker ps -n 5
#         └──┬┘
#            └─ Last 5 containers

# Filter by status
docker ps --filter "status=exited"
#         └─────────┬────────────┘
#                   └─ Show only stopped containers

# Filter by name
docker ps --filter "name=web"

# Custom format output
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
#         └────────────────────┬──────────────────────┘
#                               └─ Custom columns

# Useful aliases to add to .bashrc:
alias dps='docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}"'
```

---

#### **5. `docker stop` - Stop a Container**

**Purpose:** Gracefully stop a running container.

```bash
docker stop CONTAINER
#           └───┬───┘
#               └─ Container ID or name

# Stop by name
docker stop web

# Stop by ID
docker stop abc123def456

# Stop multiple containers
docker stop web db redis

# Stop with timeout (default 10 seconds)
docker stop -t 30 web
#           └──┬─┘
#              └─ Wait 30 seconds before force kill

# Stop all running containers
docker stop $(docker ps -q)
#           └──────┬───────┘
#                  └─ Get all container IDs

# What happens:
# 1. Sends SIGTERM (graceful shutdown signal)
# 2. Waits for timeout (default 10s)
# 3. If still running, sends SIGKILL (force stop)
```

**stop vs kill:**
```bash
# Graceful stop (recommended)
docker stop web
# App gets time to cleanup, save data, close connections

# Force kill (emergency only)
docker kill web
# Immediately terminates, no cleanup
```

---

#### **6. `docker rm` - Remove a Container**

**Purpose:** Delete a stopped container.

```bash
docker rm CONTAINER
#         └───┬───┘
#             └─ Container ID or name

# Remove stopped container
docker rm web

# Force remove running container
docker rm -f web
#         └┬┘
#          └─ -f = force (stops and removes)

# Remove multiple containers
docker rm web db redis

# Remove all stopped containers
docker rm $(docker ps -aq)
#         └─────┬──────┘
#               └─ All container IDs

# Better way: prune
docker container prune
# Removes all stopped containers

# Remove with volumes
docker rm -v web
#         └┬┘
#          └─ -v = also remove anonymous volumes
```

---

#### **7. `docker logs` - View Container Output**

**Purpose:** See what's happening inside a container.

```bash
docker logs CONTAINER
#           └───┬───┘
#               └─ Container ID or name

# View logs
docker logs web

# Follow logs (like tail -f)
docker logs -f web
#           └┬┘
#            └─ -f = follow (live stream)

# Last N lines
docker logs --tail 100 web
#           └─────┬────┘
#                 └─ Last 100 lines

# Logs since timestamp
docker logs --since 2024-04-21T10:00:00 web

# Logs since duration ago
docker logs --since 10m web
#           └────┬─────┘
#                └─ Last 10 minutes

# With timestamps
docker logs -t web
#           └┬┘
#            └─ -t = timestamps

# Combination (common)
docker logs -f --tail 50 web
# Follow logs, starting from last 50 lines
```

---

#### **8. `docker exec` - Run Command in Running Container**

**Purpose:** Execute a command inside a running container.

```bash
docker exec [OPTIONS] CONTAINER COMMAND
#           └───┬───┘ └───┬───┘ └──┬──┘
#               │         │        └─ Command to run
#               │         └─ Running container
#               └─ Options

# Run single command
docker exec web ls /app
#           └─┘ └──┬──┘
#               │   └─ Command
#               └─ Container

# Interactive shell (most common)
docker exec -it web bash
#           └┬┘ └─┘ └──┘
#            │   │   └─ Shell to open
#            │   └─ Container
#            └─ -i (interactive) + -t (terminal)

# Run as specific user
docker exec -u root web apt-get update
#           └───┬──┘
#               └─ Run as root user

# Run with environment variables
docker exec -e DEBUG=true web python script.py

# Run in specific directory
docker exec -w /app/logs web cat error.log
#           └────┬─────┘
#                └─ Working directory

# Common use cases:
# Debug running container
docker exec -it web bash

# Check process list
docker exec web ps aux

# View file contents
docker exec web cat /etc/nginx/nginx.conf

# Run database commands
docker exec db psql -U postgres -c "SELECT * FROM users"
```

---

#### **9. `docker images` - List Images**

**Purpose:** Show all Docker images on your system.

```bash
# List all images
docker images

# or
docker image ls

# Output:
REPOSITORY      TAG       IMAGE ID       CREATED        SIZE
nginx           latest    abc123def456   2 weeks ago    142MB
python          3.12      def456ghi789   1 month ago    500MB
myapp           v1.0      ghi789jkl012   1 hour ago     850MB

# List with digests
docker images --digests

# List only image IDs
docker images -q

# Filter by repository
docker images nginx

# Filter by tag
docker images python:3.12

# Show all layers (intermediate images)
docker images -a

# Format output
docker images --format "table {{.Repository}}\t{{.Tag}}\t{{.Size}}"
```

---

#### **10. `docker-compose up/down` - Manage Multi-Container Apps**

**Purpose:** Start/stop all services defined in docker-compose.yml

```bash
# Start all services
docker-compose up

# Start in background
docker-compose up -d
#                 └┬┘
#                  └─ Detached mode

# Rebuild images before starting
docker-compose up --build

# Start specific service
docker-compose up web

# Scale a service
docker-compose up --scale web=3
#                 └──────┬──────┘
#                        └─ Run 3 instances of 'web'

# Stop all services
docker-compose down

# Stop and remove volumes
docker-compose down -v
#                   └┬┘
#                    └─ Remove named volumes

# Stop and remove images
docker-compose down --rmi all

# Restart services
docker-compose restart

# Restart specific service
docker-compose restart web

# View logs
docker-compose logs

# Follow logs
docker-compose logs -f

# View logs for specific service
docker-compose logs -f web
```

> **How to Explain This to Someone Else:**
> Docker commands follow a simple pattern: `docker [action] [what]`. Want to run something? `docker run`. Want to stop it? `docker stop`. Want to see logs? `docker logs`. The most important commands are: `pull` (download), `build` (create), `run` (start), `ps` (list), `stop` (stop), `rm` (delete), `exec` (go inside), and `logs` (see output).

---

## 🔍 4. Deep Dive on Each Component with Real Examples

### 📝 Dockerfile Deep Dive

**A Complete Real-World Dockerfile:**

```dockerfile
# ============================================================================
# Multi-stage Dockerfile for Python FastAPI Application
# ============================================================================

# -----------------------------------------------------------------------------
# Stage 1: Build Stage (compile dependencies)
# -----------------------------------------------------------------------------
FROM python:3.12-slim AS builder
# AS builder → name this stage so we can reference it later

# Set environment variables
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1
# PYTHONUNBUFFERED=1 → See output immediately
# PYTHONDONTWRITEBYTECODE=1 → Don't create .pyc files
# PIP_NO_CACHE_DIR=1 → Don't cache pip downloads (saves space)

# Install system dependencies needed for building
RUN apt-get update && apt-get install -y \
    gcc \
    g++ \
    libpq-dev \
    && rm -rf /var/lib/apt/lists/*
# gcc, g++ → C compilers (some Python packages need them)
# libpq-dev → PostgreSQL library
# rm -rf /var/lib/apt/lists/* → Clean up to reduce image size

# Create virtual environment
RUN python -m venv /opt/venv
# /opt/venv → Standard location for virtual environments

# Activate virtual environment
ENV PATH="/opt/venv/bin:$PATH"
# Now all python/pip commands use the venv

# Copy and install Python dependencies
COPY requirements.txt .
RUN pip install --upgrade pip && \
    pip install -r requirements.txt

# -----------------------------------------------------------------------------
# Stage 2: Runtime Stage (final lean image)
# -----------------------------------------------------------------------------
FROM python:3.12-slim AS runtime
# Start fresh with clean slim image (discards compilers from stage 1)

# Create non-root user for security
RUN useradd -m -u 1000 appuser && \
    mkdir -p /app && \
    chown appuser:appuser /app
# -m → Create home directory
# -u 1000 → User ID
# Don't run as root for security!

# Copy virtual environment from builder stage
COPY --from=builder /opt/venv /opt/venv
#     └────┬─────┘
#          └─ Take from 'builder' stage

# Set environment
ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONUNBUFFERED=1

# Set working directory
WORKDIR /app

# Copy application code
COPY --chown=appuser:appuser . .
# --chown → Set owner to appuser (not root)

# Switch to non-root user
USER appuser

# Expose port
EXPOSE 8000
# Documentation only - doesn't actually open port

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD python -c "import requests; requests.get('http://localhost:8000/health')"
# --interval → How often to check
# --timeout → How long to wait
# --start-period → Grace period on startup
# --retries → How many failures before unhealthy

# Run application
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
# CMD is default command (can be overridden)
# Use JSON array format for cleaner execution
```

**Dockerfile Instructions Reference:**

| Instruction | Purpose | Example |
|-------------|---------|---------|
| `FROM` | Base image to start from | `FROM python:3.12` |
| `RUN` | Execute command during build | `RUN pip install flask` |
| `CMD` | Default command when container starts | `CMD ["python", "app.py"]` |
| `ENTRYPOINT` | Command that always runs | `ENTRYPOINT ["python"]` |
| `COPY` | Copy files from host to image | `COPY . /app` |
| `ADD` | Like COPY but can extract archives | `ADD file.tar.gz /app` |
| `WORKDIR` | Set working directory | `WORKDIR /app` |
| `ENV` | Set environment variable | `ENV DEBUG=true` |
| `EXPOSE` | Document which port to use | `EXPOSE 8000` |
| `VOLUME` | Create mount point | `VOLUME /data` |
| `USER` | Set user for following commands | `USER appuser` |
| `ARG` | Build-time variable | `ARG VERSION=1.0` |
| `LABEL` | Add metadata | `LABEL version="1.0"` |

**CMD vs ENTRYPOINT:**

```dockerfile
# Example 1: CMD only
CMD ["python", "app.py"]
# Can be overridden completely

# Example 2: ENTRYPOINT only
ENTRYPOINT ["python"]
# Always runs python, but you can pass arguments

# Example 3: Both together (best practice)
ENTRYPOINT ["python"]
CMD ["app.py"]
# Always runs: python app.py
# But can override CMD part: docker run myimage other.py
```

---

### 🖼️ Docker Image Deep Dive

**Understanding Image Layers:**

Every instruction in Dockerfile creates a layer:

```dockerfile
FROM ubuntu:22.04          # Layer 1: Base OS (80MB)
RUN apt-get update         # Layer 2: Package lists (30MB)
RUN apt-get install python # Layer 3: Python (100MB)
COPY app.py /app/          # Layer 4: Your code (1MB)
                           # Total: 211MB
```

**Image layers are cached:**
```bash
# First build
docker build -t myapp:v1 .
# Takes 5 minutes, builds all layers

# Change app.py, rebuild
docker build -t myapp:v2 .
# Takes 10 seconds! Layers 1-3 are cached, only rebuilds layer 4

# Change Dockerfile RUN instruction
docker build -t myapp:v3 .
# Takes 5 minutes again, cache invalidated from that point on
```

**Best practice: Order matters!**
```dockerfile
# ❌ BAD - Code changes invalidate pip install
FROM python:3.12
COPY . /app                    # Changes often
RUN pip install -r requirements.txt  # Reinstalls every time!

# ✅ GOOD - Dependencies cached separately
FROM python:3.12
COPY requirements.txt /app/    # Changes rarely
RUN pip install -r requirements.txt  # Cached!
COPY . /app                    # Changes often, but doesn't affect previous layers
```

**Inspect image layers:**
```bash
docker image history myapp:v1

# Output:
IMAGE          CREATED BY                                      SIZE
abc123def456   CMD ["python" "app.py"]                        0B
def456ghi789   COPY . /app                                    1MB
ghi789jkl012   RUN pip install -r requirements.txt            150MB
jkl012mno345   COPY requirements.txt /app                     1KB
mno345pqr678   FROM python:3.12                               500MB
```

---

### 📦 Docker Container Deep Dive

**Container Lifecycle:**

```
╔═══════════════════════════════════════════════════════════╗
║                  Container States                          ║
╠═══════════════════════════════════════════════════════════╣
║                                                            ║
║    docker run         docker pause      docker stop       ║
║  ┌─────────┐        ┌─────────┐      ┌─────────┐        ║
║  │ Created │───────>│ Running │─────>│ Paused  │        ║
║  └─────────┘        └────┬────┘      └────┬────┘        ║
║       │                  │                 │              ║
║       │                  │                 │              ║
║       │                  │ docker unpause  │              ║
║       │                  │<────────────────┘              ║
║       │                  │                                ║
║       │                  │ docker stop                    ║
║       │                  ▼                                ║
║       │             ┌─────────┐                           ║
║       └────────────>│ Stopped │                           ║
║                     └────┬────┘                           ║
║                          │                                ║
║                          │ docker start                   ║
║                          │                                ║
║                          ▼                                ║
║                     ┌─────────┐                           ║
║                     │ Running │                           ║
║                     └────┬────┘                           ║
║                          │                                ║
║                          │ docker rm                      ║
║                          ▼                                ║
║                     ┌─────────┐                           ║
║                     │ Removed │                           ║
║                     └─────────┘                           ║
║                                                            ║
╚═══════════════════════════════════════════════════════════╝
```

**Detailed container commands:**

```bash
# Create container without starting
docker create nginx
# Returns: abc123def456 (container ID)

# Start created container
docker start abc123def456

# Pause running container (freeze)
docker pause abc123def456
# All processes frozen, no CPU usage

# Unpause
docker unpause abc123def456

# Restart container
docker restart abc123def456

# Rename container
docker rename old_name new_name

# Attach to running container (see output)
docker attach abc123def456

# Copy files to/from container
docker cp myfile.txt abc123def456:/app/
docker cp abc123def456:/app/logs/error.log ./

# Get container statistics
docker stats abc123def456
# Shows: CPU%, MEM%, NET I/O, BLOCK I/O

# Inspect container (full details)
docker inspect abc123def456
# Returns JSON with all container information

# Export container filesystem
docker export abc123def456 > container.tar

# Create image from container
docker commit abc123def456 myapp:snapshot
```

---

### 💾 Docker Volume Deep Dive

**Three types of mounts:**

```bash
# 1. Named Volume (managed by Docker)
docker run -v mydata:/app/data nginx
#          └───┬───┘└────┬────┘
#              │         └─ Container path
#              └─ Volume name

# 2. Bind Mount (your filesystem)
docker run -v /home/user/code:/app nginx
#          └───────┬─────────┘└─┬┘
#                  │            └─ Container path
#                  └─ Absolute path on your computer

# 3. tmpfs (RAM, temporary)
docker run --tmpfs /tmp nginx
```

**Volume management:**

```bash
# Create volume
docker volume create mydata

# List volumes
docker volume ls

# Inspect volume
docker volume inspect mydata
# Output:
[
    {
        "Name": "mydata",
        "Driver": "local",
        "Mountpoint": "/var/lib/docker/volumes/mydata/_data",
        "Scope": "local"
    }
]

# Remove volume
docker volume rm mydata

# Remove all unused volumes
docker volume prune

# Backup volume
docker run --rm \
  -v mydata:/data \
  -v $(pwd):/backup \
  ubuntu \
  tar czf /backup/mydata-backup.tar.gz /data

# Restore volume
docker run --rm \
  -v mydata:/data \
  -v $(pwd):/backup \
  ubuntu \
  tar xzf /backup/mydata-backup.tar.gz -C /
```

**Real-world example:**

```yaml
# docker-compose.yml
version: '3.8'

services:
  web:
    image: nginx
    volumes:
      # Bind mount for development (live reload)
      - ./website:/usr/share/nginx/html

  app:
    build: .
    volumes:
      # Named volume for database files
      - db_data:/var/lib/postgresql/data
      # Bind mount for logs (easy access)
      - ./logs:/app/logs

  cache:
    image: redis
    volumes:
      # tmpfs for temporary cache (fast, not persistent)
      - type: tmpfs
        target: /data

volumes:
  db_data:  # Define named volume
```

> **How to Explain This to Someone Else:**
> A Dockerfile is like a recipe with step-by-step instructions. Each step creates a "layer" like stacking pancakes. These layers are cached, so if you only change the top pancake, you don't remake the whole stack. Images are read-only templates, containers are running copies of those templates, and volumes are external storage that survives even when containers are deleted.

---

## 🔄 5. Updating an App in Docker - Full Workflow

### Scenario: You Fixed a Bug in Your Code

**Current state:**
```
Running container: myapp:v1.0
Your code: main.py (updated with bug fix)
Need to: Get new code running in production
```

### **Complete Update Workflow:**

#### **Step 1: Update Code**
```bash
# Edit your code
vim main.py
# Fix bug, save file
```

#### **Step 2: Test Locally (Development Mode)**
```bash
# For quick testing, use bind mount
docker run -v $(pwd):/app myapp:v1.0

# Changes are live! No rebuild needed
# This is for DEVELOPMENT ONLY
```

#### **Step 3: Rebuild Image (Production)**
```bash
# Build new image with updated code
docker build -t myapp:v1.1 .
#            └────┬─────┘
#                 └─ New version number

# Tag as latest too
docker tag myapp:v1.1 myapp:latest
```

**What happens during build:**
```
[+] Building 45.2s (12/12) FINISHED
 => [1/6] FROM python:3.12-slim                    ✓ (cached)
 => [2/6] WORKDIR /app                             ✓ (cached)
 => [3/6] COPY requirements.txt .                  ✓ (cached)
 => [4/6] RUN pip install -r requirements.txt      ✓ (cached)
 => [5/6] COPY . /app                              ✓ NEW! (2.3s)
 => [6/6] CMD ["python", "main.py"]                ✓ (cached)
 => => naming to myapp:v1.1                        ✓

Only step 5 rebuilt (your code changed)
```

#### **Step 4: Stop Old Container**
```bash
# Stop and remove old version
docker stop myapp-container
docker rm myapp-container

# Or force remove running container
docker rm -f myapp-container
```

#### **Step 5: Start New Container**
```bash
# Run new version
docker run -d \
  --name myapp-container \
  -p 8000:8000 \
  -v mydata:/app/data \
  myapp:v1.1

# Verify it's running
docker ps

# Check logs
docker logs -f myapp-container
```

#### **Step 6: Zero-Downtime Update (Advanced)**

**Problem:** Steps 4 & 5 cause downtime!

**Solution: Rolling update**
```bash
# 1. Start new container on different port
docker run -d \
  --name myapp-new \
  -p 8001:8000 \
  myapp:v1.1

# 2. Test new container
curl http://localhost:8001/health
# ✅ Working!

# 3. Update load balancer / proxy to point to new container
# (Nginx, HAProxy, etc.)

# 4. Stop old container
docker stop myapp-old

# 5. Rename new container
docker rename myapp-new myapp-container
```

### **Using Docker Compose for Updates:**

```bash
# Update code, then:
docker-compose up -d --build

# What this does:
# 1. Rebuilds image (only changed layers)
# 2. Recreates containers with new image
# 3. Minimal downtime (few seconds)

# For zero-downtime with multiple replicas:
docker-compose up -d --scale web=3 --no-recreate
# Keeps old containers running while starting new ones
```

### **Complete Update Checklist:**

```
☐ 1. Edit code
☐ 2. Test locally (bind mount or localhost)
☐ 3. Commit changes to git
☐ 4. Build new image (docker build)
☐ 5. Tag with version (docker tag)
☐ 6. Push to registry (docker push) [optional]
☐ 7. Stop old container (docker stop)
☐ 8. Remove old container (docker rm)
☐ 9. Start new container (docker run)
☐ 10. Verify health (docker logs, curl health check)
☐ 11. Monitor for issues (docker stats)
```

> **How to Explain This to Someone Else:**
> When you update your code, you build a new Docker image (like creating a new version of your app), stop the old running container, and start a new container from the new image. For production, you'd use version numbers (v1.0, v1.1, etc.) to track changes. Docker Compose can automate this with one command: `docker-compose up -d --build`.

---

## 🏗️ 6. Building a New Image - Every Detail

### **Complete Build Process Explained:**

```bash
docker build [OPTIONS] PATH
```

### **The Build Context:**

**PATH** = Build context (folder with Dockerfile and files)

```bash
# Current directory
docker build .
#            └─ . = current folder

# Different directory
docker build /path/to/app

# URL (Git repository)
docker build https://github.com/user/repo.git

# Stdin (pipe Dockerfile)
docker build - < Dockerfile
```

**What's included in build context:**
```
Your folder:
├── Dockerfile         ✅ Sent to Docker
├── main.py           ✅ Sent to Docker
├── requirements.txt  ✅ Sent to Docker
├── data/             ✅ Sent to Docker
│   └── bigfile.db    ⚠️ Sent (even if not used!)
├── .git/             ⚠️ Sent (large!)
└── node_modules/     ⚠️ Sent (huge!)

Problem: Everything is sent to Docker daemon
Solution: .dockerignore file
```

### **.dockerignore File:**

```bash
# .dockerignore
# Like .gitignore for Docker

# Version control
.git
.gitignore

# Python
__pycache__
*.pyc
*.pyo
*.pyd
.Python
venv/
.venv/

# Node
node_modules/
npm-debug.log

# IDE
.vscode/
.idea/
*.swp

# OS files
.DS_Store
Thumbs.db

# Build artifacts
*.log
dist/
build/

# Secrets (never include!)
.env
*.key
*.pem

# Large files not needed
*.mp4
*.zip
data/*.db
```

### **Build Options - Complete Reference:**

```bash
# Basic build
docker build -t myapp:v1.0 .
#            └─────┬──────┘ └─ Build context
#                  └─ Tag (name:version)

# Multiple tags
docker build -t myapp:v1.0 -t myapp:latest -t myapp:stable .

# Custom Dockerfile name
docker build -f Dockerfile.production -t myapp:prod .
#            └────────┬──────────────┘
#                     └─ Use this file instead of "Dockerfile"

# Build arguments (variables)
docker build --build-arg VERSION=1.2.0 --build-arg ENV=prod -t myapp .

# Example Dockerfile using ARG:
# Dockerfile:
ARG VERSION=latest
FROM python:${VERSION}
ARG ENV=dev
ENV APP_ENV=${ENV}

# No cache (fresh build)
docker build --no-cache -t myapp .
# Useful when:
# - Debugging build issues
# - Force re-download packages
# - Clearing old cache

# Pull base image first
docker build --pull -t myapp .
# Always get latest base image
# Good for: FROM python:latest

# Squash layers (experimental)
docker build --squash -t myapp .
# Combines all layers into one
# Pros: Smaller image
# Cons: Loses layer caching

# Target specific build stage
docker build --target production -t myapp:prod .

# Example multi-stage Dockerfile:
FROM node:18 AS build    # Stage 1: Build
RUN npm install && npm run build

FROM nginx:alpine AS production    # Stage 2: Serve
COPY --from=build /app/dist /usr/share/nginx/html

# Set custom build labels
docker build --label version=1.0 --label env=prod -t myapp .

# Limit memory during build
docker build --memory 2g --memory-swap 2g -t myapp .

# Build with specific platform (for cross-platform)
docker build --platform linux/amd64 -t myapp .
# Useful for:
# - M1 Mac building for Intel servers
# - Building ARM images on x86

# Progress output styles
docker build --progress=plain -t myapp .
# Options: auto, plain, tty

# Output build result to file
docker build -o type=tar,dest=myapp.tar .

# Build with secret (secure way)
docker build --secret id=mysecret,src=~/.ssh/id_rsa -t myapp .

# In Dockerfile:
RUN --mount=type=secret,id=mysecret \
    cat /run/secrets/mysecret
```

### **Build Output Explained:**

```bash
$ docker build -t myapp:v1.0 .

[+] Building 45.2s (12/12) FINISHED
# [+] Building → Build in progress
# 45.2s → Total time
# (12/12) → 12 steps, all finished

 => [internal] load build definition from Dockerfile          0.1s
 # Loading Dockerfile

 => => transferring dockerfile: 234B                          0.0s
 # Sending Dockerfile to Docker daemon

 => [internal] load .dockerignore                             0.1s
 # Loading .dockerignore file

 => => transferring context: 89B                              0.0s
 # Sending .dockerignore to daemon

 => [internal] load metadata for docker.io/library/python:3.12-slim  1.2s
 # Checking for base image updates

 => [1/6] FROM python:3.12-slim@sha256:abc123...              0.0s
 # Using cached base image (already downloaded)

 => [internal] load build context                             0.2s
 # Loading your files

 => => transferring context: 2.34MB                           0.1s
 # Sending your code to daemon

 => CACHED [2/6] WORKDIR /app                                 0.0s
 # Using cached layer

 => CACHED [3/6] COPY requirements.txt .                      0.0s
 # Using cached layer

 => CACHED [4/6] RUN pip install -r requirements.txt          0.0s
 # Using cached layer (dependencies haven't changed)

 => [5/6] COPY . /app                                         0.8s
 # NEW! Your code changed, rebuilding this layer

 => [6/6] CMD ["python", "main.py"]                           0.1s
 # Setting default command

 => exporting to image                                        2.1s
 # Saving final image

 => => exporting layers                                       2.0s
 # Writing layers to disk

 => => writing image sha256:def456...                         0.0s
 # Assigning image ID

 => => naming to docker.io/library/myapp:v1.0                 0.0s
 # Tagging image
```

### **Multi-Stage Build (Advanced):**

**Problem:** Build tools increase image size

```dockerfile
# ❌ BAD: Single stage (large image ~1.5GB)
FROM node:18
WORKDIR /app
COPY package*.json ./
RUN npm install           # Includes dev dependencies
COPY . .
RUN npm run build
# Final image includes node_modules, build tools, source code
```

```dockerfile
# ✅ GOOD: Multi-stage (small image ~100MB)

# Stage 1: Build (temporary, discarded)
FROM node:18 AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

# Stage 2: Production (final image)
FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
# Only copies built files, not build tools!
```

**Build specific stage:**
```bash
# Build only stage 1 (for testing build process)
docker build --target builder -t myapp:builder .

# Build final stage (default)
docker build -t myapp:prod .
```

### **Troubleshooting Build Issues:**

```bash
# Build fails? Get detailed output
docker build --progress=plain --no-cache -t myapp .

# Run build step-by-step (debugging)
# Dockerfile:
FROM python:3.12
RUN echo "Step 1"
RUN apt-get update    # FAILS HERE
RUN pip install flask

# Check last successful layer:
docker run -it <last-working-layer-id> bash

# Fix, then rebuild:
docker build --no-cache -t myapp .
```

> **How to Explain This to Someone Else:**
> Building an image means Docker reads your Dockerfile line by line, executing each instruction and creating layers. Each layer is cached, so if you only change your code (not dependencies), the rebuild is fast. Use `.dockerignore` to exclude files you don't need (like node_modules or .git), and use multi-stage builds to keep your final image small by discarding build tools.

---

## 🏷️ 7. Versioning - Tags & Overwriting

### **Understanding Docker Tags:**

**Format:** `repository/name:tag`

```bash
# Full format
myuser/myapp:v1.0.0
└──┬──┘└─┬─┘└──┬──┘
   │     │     └─ Tag (version)
   │     └─ Repository/Image name
   └─ User/Organization (Docker Hub)

# Local image (no user)
myapp:v1.0

# Default tag
myapp
# Actually: myapp:latest
```

### **Tag Strategies:**

#### **1. Semantic Versioning (Recommended)**
```bash
# Major.Minor.Patch
docker build -t myapp:1.0.0 .    # First release
docker build -t myapp:1.0.1 .    # Bug fix
docker build -t myapp:1.1.0 .    # New feature
docker build -t myapp:2.0.0 .    # Breaking change

# Also tag as latest
docker tag myapp:2.0.0 myapp:latest
```

#### **2. Date-Based Versioning**
```bash
# Format: YYYYMMDD
docker build -t myapp:20240421 .

# With time
docker build -t myapp:20240421-1430 .

# With git commit
docker build -t myapp:20240421-abc123 .
```

#### **3. Environment-Based**
```bash
docker build -t myapp:dev .
docker build -t myapp:staging .
docker build -t myapp:production .
```

#### **4. Git-Based**
```bash
# Use git commit hash
GIT_HASH=$(git rev-parse --short HEAD)
docker build -t myapp:$GIT_HASH .

# Use git branch
GIT_BRANCH=$(git branch --show-current)
docker build -t myapp:$GIT_BRANCH .

# Use git tag
docker build -t myapp:$(git describe --tags) .
```

### **Tagging Operations:**

```bash
# Build with multiple tags at once
docker build \
  -t myapp:v2.0.0 \
  -t myapp:v2.0 \
  -t myapp:v2 \
  -t myapp:latest \
  .

# Tag existing image
docker tag myapp:v2.0.0 myapp:stable

# Tag for multiple registries
docker tag myapp:v1.0 localhost:5000/myapp:v1.0
docker tag myapp:v1.0 gcr.io/myproject/myapp:v1.0
docker tag myapp:v1.0 myuser/myapp:v1.0

# List all tags for an image
docker images myapp
# Output:
REPOSITORY   TAG      IMAGE ID       CREATED
myapp        v2.0.0   abc123def456   1 hour ago
myapp        v2.0     abc123def456   1 hour ago
myapp        v2       abc123def456   1 hour ago
myapp        latest   abc123def456   1 hour ago
# Same IMAGE ID = same image, different tags
```

### **Overwriting vs New Version:**

#### **Scenario 1: Overwrite "latest" (Common)**
```bash
# Today
docker build -t myapp:latest .
docker push myapp:latest

# Tomorrow (with updates)
docker build -t myapp:latest .    # OVERWRITES old latest
docker push myapp:latest          # Old latest is gone

# Result:
# - Latest always has newest code ✅
# - Can't rollback easily ❌
```

#### **Scenario 2: New Version Every Time (Recommended)**
```bash
# Build version 1.0
docker build -t myapp:v1.0 -t myapp:latest .
docker push myapp:v1.0
docker push myapp:latest

# Build version 1.1
docker build -t myapp:v1.1 -t myapp:latest .
docker push myapp:v1.1
docker push myapp:latest

# Result:
# - v1.0 still exists (can rollback) ✅
# - latest updated to v1.1 ✅
# - Full history preserved ✅
```

### **Best Practices:**

```bash
# ✅ GOOD: Version + Latest
docker build -t myapp:v1.2.3 -t myapp:latest .

# ✅ GOOD: Immutable versions
docker build -t myapp:v1.0.0 .
# Never rebuild v1.0.0, create v1.0.1 instead

# ✅ GOOD: Include git hash for traceability
GIT_HASH=$(git rev-parse --short HEAD)
docker build -t myapp:v1.0.0-$GIT_HASH -t myapp:v1.0.0 .

# ❌ BAD: Only using 'latest'
docker build -t myapp:latest .
# No version history!

# ❌ BAD: Reusing version numbers
docker build -t myapp:v1.0.0 .
# Later...
docker build -t myapp:v1.0.0 .  # Don't overwrite!
```

### **Removing Tags:**

```bash
# Remove tag (doesn't delete image if other tags exist)
docker rmi myapp:old-version

# Force remove
docker rmi -f myapp:old-version

# Remove all tags for an image
docker images myapp -q | xargs docker rmi

# Remove untagged images (dangling)
docker image prune

# Remove all unused images
docker image prune -a
```

### **Registry Operations:**

```bash
# Push specific version
docker push myapp:v1.2.3

# Push all tags of an image
docker push --all-tags myapp

# Pull specific version
docker pull myapp:v1.2.3

# Pull and retag
docker pull myapp:v1.0.0
docker tag myapp:v1.0.0 myapp:rollback
docker run myapp:rollback
```

### **Complete Versioning Workflow:**

```bash
#!/bin/bash
# release.sh - Complete release script

# Get version from user
read -p "Version (e.g., 1.2.3): " VERSION

# Get git info
GIT_HASH=$(git rev-parse --short HEAD)
GIT_BRANCH=$(git branch --show-current)
BUILD_DATE=$(date +%Y%m%d)

# Build with multiple tags
docker build \
  -t myapp:v$VERSION \
  -t myapp:v$VERSION-$GIT_HASH \
  -t myapp:latest \
  --label version=$VERSION \
  --label git-hash=$GIT_HASH \
  --label build-date=$BUILD_DATE \
  .

# Push all versions
docker push myapp:v$VERSION
docker push myapp:v$VERSION-$GIT_HASH
docker push myapp:latest

# Tag in git
git tag -a v$VERSION -m "Release version $VERSION"
git push origin v$VERSION

echo "✅ Released version $VERSION"
echo "   - Docker: myapp:v$VERSION"
echo "   - Git: v$VERSION"
echo "   - Hash: $GIT_HASH"
```

> **How to Explain This to Someone Else:**
> Docker tags are like version numbers or labels for images. You can have multiple tags pointing to the same image. Best practice is to use version numbers (v1.0.0, v1.0.1, etc.) and also tag as "latest" so people can always get the newest version. Never overwrite version numbers - create a new version instead. This way you can easily rollback if something breaks.

---

## 🚀 8. Bringing Up Servers - Docker Compose Complete Guide

### **Docker Compose Basics:**

**What is it?** A tool to define and run multi-container applications.

**Why use it?** Running multiple related containers manually is tedious:

```bash
# Without Compose (manual) 😫
docker network create myapp-network
docker run -d --name db --network myapp-network -e POSTGRES_PASSWORD=secret postgres
docker run -d --name redis --network myapp-network redis
docker run -d --name web --network myapp-network -p 8000:8000 --link db myapp
# Repeat for every server restart...

# With Compose (automated) 😊
docker-compose up
# One command starts everything!
```

### **docker-compose.yml Structure:**

```yaml
version: '3.8'  # Compose file format version

# Define all services (containers)
services:

  # Service 1: Web Application
  web:
    build: .                      # Build from Dockerfile in current dir
    # or
    image: myapp:v1.0            # Use existing image

    container_name: myapp-web     # Custom name (optional)

    ports:
      - "8000:8000"              # host:container
      - "8443:443"

    environment:                  # Environment variables
      - DEBUG=true
      - DATABASE_URL=postgres://db:5432/mydb
    # or
    env_file:
      - .env                     # Load from file

    volumes:
      - ./code:/app              # Bind mount
      - app_data:/data           # Named volume

    depends_on:                   # Start order
      - db
      - redis

    restart: unless-stopped       # Restart policy

    networks:
      - frontend
      - backend

    command: python manage.py runserver  # Override CMD

    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8000/health"]
      interval: 30s
      timeout: 10s
      retries: 3

  # Service 2: Database
  db:
    image: postgres:15
    environment:
      POSTGRES_USER: myuser
      POSTGRES_PASSWORD: mypassword
      POSTGRES_DB: mydb
    volumes:
      - postgres_data:/var/lib/postgresql/data
    networks:
      - backend

  # Service 3: Cache
  redis:
    image: redis:7-alpine
    networks:
      - backend

# Define networks
networks:
  frontend:
    driver: bridge
  backend:
    driver: bridge

# Define volumes
volumes:
  app_data:
  postgres_data:
```

### **Docker Compose Commands:**

#### **Starting Services:**

```bash
# Start all services (foreground)
docker-compose up
# Shows logs from all containers
# Ctrl+C stops everything

# Start in background (detached)
docker-compose up -d
#                 └┬┘
#                  └─ Daemon mode

# Start specific services
docker-compose up web db
# Only starts 'web' and 'db' (+ their dependencies)

# Build images before starting
docker-compose up --build
# Rebuilds images even if they exist

# Recreate containers (even if not changed)
docker-compose up --force-recreate

# Don't start dependent services
docker-compose up --no-deps web
# Starts 'web' only, not 'db' or 'redis'

# Scale services (multiple instances)
docker-compose up --scale web=3
# Runs 3 instances of 'web' service

# Remove orphan containers
docker-compose up --remove-orphans
# Removes containers not defined in current compose file

# Pull images before starting
docker-compose up --pull always

# Timeout for startup
docker-compose up --timeout 30
```

#### **Stopping Services:**

```bash
# Stop all services (graceful)
docker-compose stop
# Sends SIGTERM, waits for shutdown

# Stop specific services
docker-compose stop web

# Stop with timeout
docker-compose stop -t 30
# Wait 30 seconds before force kill

# Stop and remove containers
docker-compose down
# Removes containers and networks

# Stop, remove, and delete volumes
docker-compose down -v
#                   └┬┘
#                    └─ Remove named volumes

# Stop, remove, and delete images
docker-compose down --rmi all
# all = remove all images
# local = remove only images built locally

# Remove only stopped containers
docker-compose rm
# Asks for confirmation

# Force remove (no confirmation)
docker-compose rm -f
```

#### **Restarting Services:**

```bash
# Restart all services
docker-compose restart

# Restart specific service
docker-compose restart web

# Restart with timeout
docker-compose restart -t 30 web
```

#### **Pausing/Unpausing:**

```bash
# Pause all services (freeze)
docker-compose pause
# Processes suspended, no CPU usage

# Pause specific service
docker-compose pause web

# Unpause
docker-compose unpause
docker-compose unpause web
```

### **Viewing Status & Logs:**

```bash
# List running services
docker-compose ps

# Output:
Name               Command               State   Ports
---------------------------------------------------------
myapp-web          python app.py        Up      0.0.0.0:8000->8000/tcp
myapp-db           postgres             Up      5432/tcp
myapp-redis        redis-server         Up      6379/tcp

# View logs (all services)
docker-compose logs

# Follow logs (live stream)
docker-compose logs -f

# Logs from specific service
docker-compose logs -f web

# Last N lines
docker-compose logs --tail=100 web

# Logs since timestamp
docker-compose logs --since 2024-04-21T10:00:00

# Logs with timestamps
docker-compose logs -t

# Top (process list)
docker-compose top

# Statistics (CPU, memory)
docker-compose stats
```

### **Executing Commands:**

```bash
# Run command in running service
docker-compose exec web bash
#                   └─┬┘ └──┘
#                     │   └─ Command
#                     └─ Service name

# Run as different user
docker-compose exec -u root web apt-get update

# Run one-off command (creates new container)
docker-compose run web python manage.py migrate
#                   └─┬┘
#                     └─ Service name

# Run without starting dependent services
docker-compose run --no-deps web pytest

# Run and remove container when done
docker-compose run --rm web python script.py
```

### **Building & Pulling:**

```bash
# Build all services
docker-compose build

# Build specific service
docker-compose build web

# Build with no cache
docker-compose build --no-cache

# Build with parallel
docker-compose build --parallel

# Pull all images
docker-compose pull

# Pull specific service
docker-compose pull db

# Push images to registry
docker-compose push
```

### **Configuration & Validation:**

```bash
# Validate compose file
docker-compose config
# Shows merged configuration (includes .env files)

# Validate syntax only
docker-compose config --quiet
# Returns exit code 0 if valid

# Convert to canonical format
docker-compose config > docker-compose-canonical.yml

# Show service names
docker-compose config --services

# Show volumes
docker-compose config --volumes
```

### **Advanced Compose Features:**

#### **Multiple Compose Files:**

```bash
# Base configuration
# docker-compose.yml
version: '3.8'
services:
  web:
    image: myapp
    ports:
      - "8000:8000"

# Production overrides
# docker-compose.prod.yml
version: '3.8'
services:
  web:
    environment:
      - DEBUG=false
    restart: always

# Use both files (prod overrides base)
docker-compose -f docker-compose.yml -f docker-compose.prod.yml up

# Development
docker-compose -f docker-compose.yml -f docker-compose.dev.yml up
```

#### **Environment Variables:**

```bash
# .env file
DATABASE_URL=postgres://localhost/mydb
DEBUG=true
SECRET_KEY=mysecret123

# docker-compose.yml
services:
  web:
    environment:
      - DATABASE_URL=${DATABASE_URL}
      - DEBUG=${DEBUG}
      - SECRET_KEY=${SECRET_KEY}

# Use different env file
docker-compose --env-file .env.prod up
```

#### **Extending Services:**

```yaml
# docker-compose.yml
version: '3.8'

services:
  web:
    extends:
      file: common-services.yml
      service: webapp
    environment:
      - SPECIFIC_VAR=value

# common-services.yml
version: '3.8'

services:
  webapp:
    build: .
    volumes:
      - ./code:/app
```

### **Complete Workflow Example:**

```bash
# 1. First time setup
docker-compose up -d --build
# Builds images, creates network, starts containers

# 2. View logs
docker-compose logs -f

# 3. Make code changes
vim app/main.py

# 4. Restart to apply changes
docker-compose restart web

# 5. Run database migrations
docker-compose exec web python manage.py migrate

# 6. Check status
docker-compose ps

# 7. Debugging
docker-compose exec web bash

# 8. Update with new image
docker-compose pull
docker-compose up -d

# 9. Scale for load
docker-compose up -d --scale web=5

# 10. Cleanup
docker-compose down -v
```

### **Production Deployment:**

```yaml
# docker-compose.prod.yml
version: '3.8'

services:
  web:
    image: myapp:v1.2.3  # Specific version, not 'latest'
    restart: always      # Always restart on failure
    deploy:
      replicas: 3        # Run 3 instances
      resources:
        limits:
          cpus: '0.50'
          memory: 512M
        reservations:
          cpus: '0.25'
          memory: 256M
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s

  db:
    image: postgres:15
    restart: always
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./backups:/backups  # Backup location
    environment:
      POSTGRES_PASSWORD_FILE: /run/secrets/db_password
    secrets:
      - db_password

secrets:
  db_password:
    file: ./secrets/db_password.txt

volumes:
  postgres_data:
    driver: local
```

> **How to Explain This to Someone Else:**
> Docker Compose is like a coordinator for multiple containers. You write one YAML file describing all your containers (web server, database, cache), then use `docker-compose up` to start everything at once. It creates networks so containers can talk, manages volumes for data, and handles the startup order. When you're done, `docker-compose down` stops and cleans up everything.

---

## 🐛 9. Debugging Broken Containers - Complete Troubleshooting Guide

### **Common Scenarios & Solutions:**

---

### **Problem 1: Container Won't Start**

**Symptom:**
```bash
$ docker ps
CONTAINER ID   IMAGE   COMMAND   CREATED   STATUS   PORTS   NAMES
# Empty! No containers running
```

**Diagnosis:**

```bash
# Check all containers (including stopped)
docker ps -a

# Output shows:
CONTAINER ID   IMAGE     STATUS
abc123def456   myapp     Exited (1) 10 seconds ago

# Container starts then immediately exits
```

**Step 1: Check logs**
```bash
docker logs abc123def456

# Common errors:
# Error 1: "python: can't open file 'app.py': No such file"
# Solution: COPY command in Dockerfile wrong

# Error 2: "ModuleNotFoundError: No module named 'flask'"
# Solution: requirements.txt not installed

# Error 3: "Permission denied"
# Solution: File permissions wrong or running as wrong user
```

**Step 2: Try running interactively**
```bash
# Override CMD, open shell instead
docker run -it myapp bash
# or
docker run -it myapp sh

# Now inside container, manually run command:
$ ls /app
# Check if files exist

$ python app.py
# See actual error message

$ cat requirements.txt
# Verify dependencies
```

**Step 3: Check Dockerfile**
```dockerfile
# Common mistake:
FROM python:3.12
WORKDIR /app
CMD ["python", "app.py"]  # ❌ app.py not copied!

# Fix:
FROM python:3.12
WORKDIR /app
COPY . /app              # ✅ Copy files first!
CMD ["python", "app.py"]
```

---

### **Problem 2: Container Running But Not Working**

**Symptom:**
```bash
$ docker ps
# Container shows as "Up" but app doesn't work
$ curl http://localhost:8000
# Connection refused or timeout
```

**Diagnosis:**

**Step 1: Check if process is actually running**
```bash
# Execute ps inside container
docker exec myapp ps aux

# Look for your app process
USER  PID  %CPU  %MEM  COMMAND
root    1   0.0   0.1  python app.py  # ✅ Running!
# or
root    1   0.0   0.0  bash           # ❌ Shell running, not app!
```

**Step 2: Check port binding**
```bash
docker ps
# Look at PORTS column:

# ❌ Bad: 8000/tcp
# Port is exposed inside container but not mapped to host

# ✅ Good: 0.0.0.0:8000->8000/tcp
# Port 8000 inside container mapped to port 8000 on host

# Fix:
docker run -p 8000:8000 myapp
#          └────┬─────┘
#               └─ host:container
```

**Step 3: Check if app is listening on correct interface**
```bash
docker exec myapp netstat -tlnp

# Output:
Proto  Local Address   State      PID/Program
tcp    127.0.0.1:8000  LISTEN     1/python    # ❌ Only listening on localhost!
tcp    0.0.0.0:8000    LISTEN     1/python    # ✅ Listening on all interfaces

# Fix in app:
# ❌ Bad:
app.run(host='127.0.0.1', port=8000)

# ✅ Good:
app.run(host='0.0.0.0', port=8000)
```

**Step 4: Check firewall/network**
```bash
# Test from inside container
docker exec myapp curl http://localhost:8000
# Works? ✅ App is fine, problem is external

# Test from host
curl http://localhost:8000
# Doesn't work? Check firewall

# Check Docker network
docker network inspect bridge
# Verify container is on network
```

---

### **Problem 3: Out of Memory / Resources**

**Symptom:**
```bash
$ docker logs myapp
# Shows: Killed
# or container just stops randomly
```

**Diagnosis:**

```bash
# Check container resource usage
docker stats myapp

CONTAINER  CPU %  MEM USAGE / LIMIT   MEM %
myapp      2.5%   512MB / 512MB      100%    # ❌ Hit memory limit!

# Solution 1: Increase memory limit
docker run -m 1g myapp  # 1 gigabyte

# Solution 2: Find memory leak
docker exec myapp top
# Look for processes using lots of memory

# Solution 3: Check logs for memory errors
docker logs myapp | grep -i "memory\|oom\|killed"
```

---

### **Problem 4: Container Can't Reach Database**

**Symptom:**
```bash
$ docker logs web
# Error: Could not connect to database at localhost:5432
```

**Diagnosis:**

**Step 1: Check if database container is running**
```bash
docker ps | grep postgres
# Is it running? If not, start it
docker start postgres-container
```

**Step 2: Check network connectivity**
```bash
# Test from web container
docker exec web ping db
# PING db (172.18.0.2): 56 data bytes
# ✅ Can reach!

# or
docker exec web curl http://db:5432
# ✅ Port open!

# Can't ping? Check network:
docker network inspect bridge
# Are both containers on same network?
```

**Step 3: Check connection string**
```bash
# ❌ Wrong: localhost
DATABASE_URL=postgres://localhost:5432/mydb

# ✅ Right: container name
DATABASE_URL=postgres://db:5432/mydb
#                      └┬┘
#                       └─ Use container name or service name

# In docker-compose:
services:
  web:
    environment:
      - DATABASE_URL=postgres://db:5432/mydb
                               # └─ Service name from compose file
  db:
    image: postgres
```

---

### **Problem 5: File/Volume Permission Errors**

**Symptom:**
```bash
$ docker logs web
# Error: Permission denied: '/data/file.db'
```

**Diagnosis:**

```bash
# Check file permissions inside container
docker exec web ls -la /data

# Output:
drwxr-xr-x  root root  /data           # ❌ Owned by root
-rw-r--r--  root root  /data/file.db

# But app runs as user 'appuser'

# Solution 1: Change ownership in Dockerfile
FROM python:3.12
RUN useradd -m appuser
WORKDIR /app
COPY --chown=appuser:appuser . .
USER appuser

# Solution 2: Fix volume permissions
docker run -v mydata:/data -e USER_ID=$(id -u) myapp

# Solution 3: Use --user flag
docker run --user $(id -u):$(id -g) myapp
```

---

### **Problem 6: Build Fails**

**Symptom:**
```bash
$ docker build -t myapp .
ERROR: failed to solve: process "/bin/sh -c pip install -r requirements.txt" did not complete successfully
```

**Diagnosis:**

```bash
# Step 1: Build with verbose output
docker build --progress=plain --no-cache -t myapp .

# Step 2: Check which layer failed
# Output shows:
#8 [4/6] RUN pip install -r requirements.txt
#8 ERROR: Could not find a version that satisfies the requirement numpy==1.26.0

# Step 3: Test command manually
docker run -it python:3.12 bash
# Inside container:
$ pip install -r requirements.txt
# See actual error

# Common build errors:

# Error 1: Network timeout
# Solution: Increase timeout
docker build --network host -t myapp .

# Error 2: Insufficient disk space
# Solution: Clean up
docker system prune -a

# Error 3: Dependency conflicts
# Solution: Update requirements.txt
pip install --upgrade pip
pip install -r requirements.txt

# Error 4: Platform mismatch (M1 Mac vs Intel)
# Solution: Build for specific platform
docker build --platform linux/amd64 -t myapp .
```

---

### **Complete Debugging Checklist:**

```bash
# 1. Check if container is running
docker ps -a

# 2. View logs
docker logs container_name
docker logs -f container_name  # Follow live

# 3. Inspect container details
docker inspect container_name | less

# 4. Check resource usage
docker stats container_name

# 5. Execute shell inside container
docker exec -it container_name bash

# 6. Check network
docker network inspect bridge
docker exec container_name ping other_container

# 7. Check volumes
docker volume inspect volume_name
docker exec container_name ls -la /mount/path

# 8. Check ports
docker port container_name
netstat -tlnp | grep :8000

# 9. Check environment variables
docker exec container_name env

# 10. Check processes
docker exec container_name ps aux

# 11. Check disk space
docker system df
df -h

# 12. View real-time events
docker events

# 13. Check Docker daemon logs
journalctl -u docker -f
# or
tail -f /var/log/docker.log
```

---

### **Useful Debugging Commands:**

```bash
# Start container with shell (override CMD)
docker run -it --entrypoint bash myapp

# Keep container running even if main process fails
docker run -it --entrypoint tail myapp -f /dev/null

# Run container with more verbose logging
docker run -e DEBUG=true -e LOG_LEVEL=DEBUG myapp

# Copy files out of container for inspection
docker cp container_name:/app/logs/error.log ./

# Export container filesystem for analysis
docker export container_name > container.tar
tar -xf container.tar

# Compare running container with image
docker diff container_name
# Shows files added/changed/deleted

# Save container state as new image
docker commit container_name debug_snapshot

# Restart container with different settings
docker update --restart=always container_name
```

---

### **Advanced Debugging:**

```bash
# Enter container namespace (expert level)
docker inspect --format '{{.State.Pid}}' container_name
# Returns: 12345
nsenter -t 12345 -n netstat -tlnp

# Debug network traffic
docker run --rm --net container:myapp nicolaka/netshoot tcpdump

# Debug DNS resolution
docker exec myapp cat /etc/resolv.conf
docker exec myapp nslookup db

# Check mounted volumes
docker inspect -f '{{ range .Mounts }}{{ .Source }} -> {{ .Destination }}{{ "\n" }}{{ end }}' container_name
```

> **How to Explain This to Someone Else:**
> When a Docker container breaks, follow this process: 1) Check `docker logs` to see error messages, 2) Use `docker exec -it container bash` to go inside and poke around, 3) Check if ports are mapped correctly with `docker ps`, 4) Verify the container can reach other services with `docker exec container ping other_service`. Most problems are either port mapping issues, wrong connection strings (use container names, not localhost), or permission problems.

---

## ➕ 10. Adding a New Container to Existing Setup

### **Scenario: Add Redis Cache to Existing App**

**Current setup:**
```yaml
# docker-compose.yml (before)
version: '3.8'

services:
  web:
    build: .
    ports:
      - "8000:8000"
    environment:
      - DATABASE_URL=postgres://db:5432/mydb

  db:
    image: postgres:15
    environment:
      POSTGRES_PASSWORD: secret
    volumes:
      - postgres_data:/var/lib/postgresql/data

volumes:
  postgres_data:
```

---

### **Step-by-Step: Adding Redis**

#### **Step 1: Update docker-compose.yml**

```yaml
# docker-compose.yml (after)
version: '3.8'

services:
  web:
    build: .
    ports:
      - "8000:8000"
    environment:
      - DATABASE_URL=postgres://db:5432/mydb
      - REDIS_URL=redis://redis:6379/0        # ← NEW!
    depends_on:                                # ← NEW!
      - db
      - redis                                  # ← NEW!

  db:
    image: postgres:15
    environment:
      POSTGRES_PASSWORD: secret
    volumes:
      - postgres_data:/var/lib/postgresql/data

  # ← NEW SERVICE!
  redis:
    image: redis:7-alpine                      # Official Redis image
    ports:
      - "6379:6379"                           # Optional: expose port
    volumes:
      - redis_data:/data                      # Persist cache (optional)
    command: redis-server --appendonly yes    # Enable persistence
    healthcheck:                              # Check if Redis is ready
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5

volumes:
  postgres_data:
  redis_data:                                 # ← NEW!
```

#### **Step 2: Update Application Code**

```python
# app.py (before)
from flask import Flask
import psycopg2

app = Flask(__name__)
db = psycopg2.connect(os.getenv('DATABASE_URL'))

@app.route('/')
def index():
    # Always queries database
    result = db.execute("SELECT * FROM users")
    return render_template('index.html', users=result)
```

```python
# app.py (after)
from flask import Flask
import psycopg2
import redis                                  # ← NEW!
import os

app = Flask(__name__)
db = psycopg2.connect(os.getenv('DATABASE_URL'))
cache = redis.from_url(os.getenv('REDIS_URL'))  # ← NEW!

@app.route('/')
def index():
    # Try cache first                         # ← NEW!
    cached = cache.get('users')
    if cached:
        return render_template('index.html', users=cached)

    # Not in cache, query database
    result = db.execute("SELECT * FROM users")

    # Store in cache for 5 minutes           # ← NEW!
    cache.setex('users', 300, result)

    return render_template('index.html', users=result)
```

#### **Step 3: Update requirements.txt**

```txt
# requirements.txt (before)
flask==3.0.0
psycopg2-binary==2.9.9

# requirements.txt (after)
flask==3.0.0
psycopg2-binary==2.9.9
redis==5.0.1                                  # ← NEW!
```

#### **Step 4: Rebuild and Deploy**

```bash
# Stop current containers
docker-compose down

# Rebuild with new dependencies
docker-compose build

# Start all services (including new Redis)
docker-compose up -d

# Verify all containers running
docker-compose ps
# Should show: web, db, redis all "Up"

# Check logs
docker-compose logs -f redis
# Should see: "Ready to accept connections"

# Test connection
docker-compose exec web python -c "import redis; r = redis.from_url('redis://redis:6379'); print(r.ping())"
# Should print: True
```

---

### **Another Example: Adding Nginx Reverse Proxy**

**Adding Nginx in front of application:**

```yaml
# docker-compose.yml
version: '3.8'

services:
  # NEW: Nginx as reverse proxy
  nginx:
    image: nginx:alpine
    ports:
      - "80:80"                    # Public port
      - "443:443"                  # HTTPS
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
      - ./static:/var/www/static:ro
    depends_on:
      - web
    networks:
      - frontend

  # Application (no longer exposed directly)
  web:
    build: .
    # ports:                       # ← REMOVE direct exposure
    #   - "8000:8000"
    networks:
      - frontend
      - backend

  db:
    image: postgres:15
    networks:
      - backend

networks:
  frontend:    # Nginx and Web
  backend:     # Web and DB (Nginx cannot access DB)
```

**Create nginx.conf:**

```nginx
# nginx.conf
events {
    worker_connections 1024;
}

http {
    upstream web {
        server web:8000;    # Points to 'web' service
    }

    server {
        listen 80;

        # Static files served by Nginx
        location /static/ {
            alias /var/www/static/;
        }

        # Dynamic requests proxied to app
        location / {
            proxy_pass http://web;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
        }
    }
}
```

```bash
# Deploy
docker-compose up -d

# Access via Nginx
curl http://localhost/
# Nginx forwards to web container internally
```

---

### **Adding Monitoring (Prometheus + Grafana)**

```yaml
version: '3.8'

services:
  web:
    build: .
    environment:
      - METRICS_PORT=9090
    # ... existing config ...

  # NEW: Prometheus (metrics collector)
  prometheus:
    image: prom/prometheus:latest
    ports:
      - "9090:9090"
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml
      - prometheus_data:/prometheus
    command:
      - '--config.file=/etc/prometheus/prometheus.yml'
      - '--storage.tsdb.path=/prometheus'

  # NEW: Grafana (metrics visualization)
  grafana:
    image: grafana/grafana:latest
    ports:
      - "3000:3000"
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=admin
    volumes:
      - grafana_data:/var/lib/grafana
    depends_on:
      - prometheus

volumes:
  prometheus_data:
  grafana_data:
```

**Create prometheus.yml:**

```yaml
# prometheus.yml
global:
  scrape_interval: 15s

scrape_configs:
  - job_name: 'web-app'
    static_configs:
      - targets: ['web:9090']
```

---

### **Common Patterns When Adding Services:**

#### **Pattern 1: Adding a Message Queue (RabbitMQ)**

```yaml
services:
  rabbitmq:
    image: rabbitmq:3-management
    ports:
      - "5672:5672"    # AMQP
      - "15672:15672"  # Management UI
    environment:
      - RABBITMQ_DEFAULT_USER=admin
      - RABBITMQ_DEFAULT_PASS=secret
    volumes:
      - rabbitmq_data:/var/lib/rabbitmq

volumes:
  rabbitmq_data:
```

#### **Pattern 2: Adding a Worker (Background Jobs)**

```yaml
services:
  web:
    build: .
    command: python manage.py runserver

  worker:
    build: .                           # Same image as web
    command: celery -A myapp worker    # Different command
    depends_on:
      - rabbitmq
      - db
```

#### **Pattern 3: Adding a Frontend (React)**

```yaml
services:
  frontend:
    build: ./frontend
    volumes:
      - ./frontend:/app
      - /app/node_modules    # Anonymous volume for node_modules
    command: npm start
    ports:
      - "3000:3000"

  api:
    build: ./backend
    ports:
      - "8000:8000"
```

---

### **Testing the New Service:**

```bash
# 1. Verify service started
docker-compose ps redis
# STATE should be "Up"

# 2. Check logs
docker-compose logs -f redis

# 3. Test connectivity from app
docker-compose exec web ping redis

# 4. Test functionality
docker-compose exec web python -c "
import redis
r = redis.from_url('redis://redis:6379')
r.set('test', 'value')
print(r.get('test'))
"
# Should print: b'value'

# 5. Check resource usage
docker-compose stats redis

# 6. Verify environment variables
docker-compose exec web env | grep REDIS
# Should show: REDIS_URL=redis://redis:6379/0
```

---

### **Rollback if Issues:**

```bash
# Remove new service
docker-compose stop redis
docker-compose rm redis

# Revert docker-compose.yml changes
git checkout docker-compose.yml

# Restart existing services
docker-compose up -d
```

> **How to Explain This to Someone Else:**
> To add a new container, edit your docker-compose.yml and add a new service entry with the image name, ports, and environment variables. Update your application code to connect to the new service using the service name (e.g., `redis://redis:6379`). Then run `docker-compose up -d` to start the new container alongside your existing ones. Docker Compose will create the networks and connections automatically.

---

## 📚 Quick Reference Cheat Sheet

### **Top 20 Docker Commands Every Beginner Needs:**

```bash
# ============================================================================
# IMAGES
# ============================================================================

# 1. Download an image
docker pull nginx:latest

# 2. List all images
docker images

# 3. Build an image from Dockerfile
docker build -t myapp:v1.0 .

# 4. Remove an image
docker rmi myapp:v1.0

# 5. Tag an image
docker tag myapp:v1.0 myapp:latest

# ============================================================================
# CONTAINERS
# ============================================================================

# 6. Run a container
docker run -d -p 8080:80 --name web nginx

# 7. List running containers
docker ps

# 8. List all containers (including stopped)
docker ps -a

# 9. Stop a container
docker stop web

# 10. Start a stopped container
docker start web

# 11. Restart a container
docker restart web

# 12. Remove a container
docker rm web

# 13. View container logs
docker logs -f web

# 14. Execute command in running container
docker exec -it web bash

# ============================================================================
# DOCKER COMPOSE
# ============================================================================

# 15. Start all services
docker-compose up -d

# 16. Stop all services
docker-compose down

# 17. View service logs
docker-compose logs -f

# 18. Restart a service
docker-compose restart web

# ============================================================================
# CLEANUP
# ============================================================================

# 19. Remove unused containers, networks, images
docker system prune

# 20. Remove everything (including volumes)
docker system prune -a --volumes
```

---

### **Docker CLI Quick Reference:**

| Action | Command | Example |
|--------|---------|---------|
| **Download image** | `docker pull IMAGE` | `docker pull nginx` |
| **Run container** | `docker run -d -p HOST:CONTAINER IMAGE` | `docker run -d -p 8080:80 nginx` |
| **List containers** | `docker ps [-a]` | `docker ps -a` |
| **Stop container** | `docker stop CONTAINER` | `docker stop web` |
| **Remove container** | `docker rm CONTAINER` | `docker rm web` |
| **View logs** | `docker logs [-f] CONTAINER` | `docker logs -f web` |
| **Execute command** | `docker exec -it CONTAINER CMD` | `docker exec -it web bash` |
| **Build image** | `docker build -t NAME:TAG PATH` | `docker build -t myapp:v1 .` |
| **List images** | `docker images` | `docker images` |
| **Remove image** | `docker rmi IMAGE` | `docker rmi myapp:v1` |

---

### **Docker Compose Quick Reference:**

| Action | Command | Example |
|--------|---------|---------|
| **Start services** | `docker-compose up [-d]` | `docker-compose up -d` |
| **Stop services** | `docker-compose down` | `docker-compose down` |
| **View logs** | `docker-compose logs [-f]` | `docker-compose logs -f web` |
| **Restart service** | `docker-compose restart SERVICE` | `docker-compose restart web` |
| **Scale service** | `docker-compose up --scale SERVICE=N` | `docker-compose up --scale web=3` |
| **Build images** | `docker-compose build` | `docker-compose build` |
| **Execute command** | `docker-compose exec SERVICE CMD` | `docker-compose exec web bash` |
| **List services** | `docker-compose ps` | `docker-compose ps` |

---

### **Dockerfile Quick Reference:**

```dockerfile
# Start with base image
FROM python:3.12-slim

# Set environment variables
ENV PYTHONUNBUFFERED=1

# Set working directory
WORKDIR /app

# Copy files
COPY requirements.txt .
COPY . /app

# Run commands during build
RUN pip install -r requirements.txt

# Expose port (documentation only)
EXPOSE 8000

# Create volume mount point
VOLUME /data

# Set default user
USER appuser

# Default command
CMD ["python", "app.py"]
```

---

### **Common docker run Flags:**

| Flag | Purpose | Example |
|------|---------|---------|
| `-d` | Run in background | `docker run -d nginx` |
| `-p` | Map port | `docker run -p 8080:80 nginx` |
| `--name` | Give container a name | `docker run --name web nginx` |
| `-v` | Mount volume | `docker run -v data:/app nginx` |
| `-e` | Set environment variable | `docker run -e DEBUG=true nginx` |
| `-it` | Interactive terminal | `docker run -it ubuntu bash` |
| `--rm` | Remove after stop | `docker run --rm nginx` |
| `--restart` | Restart policy | `docker run --restart always nginx` |
| `-m` | Memory limit | `docker run -m 512m nginx` |
| `--network` | Connect to network | `docker run --network my-net nginx` |

---

### **Troubleshooting Commands:**

```bash
# View detailed container info
docker inspect container_name

# View resource usage
docker stats container_name

# View container processes
docker top container_name

# View changes to filesystem
docker diff container_name

# View port mappings
docker port container_name

# View networks
docker network ls

# View volumes
docker volume ls

# System information
docker info

# System disk usage
docker system df

# Real-time events
docker events
```

---

## 🎓 Final Tips for Beginners

### **Key Concepts to Remember:**

1. **Image = Template, Container = Running Instance**
   - One image can create many containers
   - Like a recipe (image) can make many cakes (containers)

2. **Volumes Persist, Containers Don't**
   - Always use volumes for important data
   - Containers can be deleted anytime

3. **Use docker-compose for Multiple Containers**
   - Don't run multiple `docker run` commands
   - One YAML file, one command

4. **Version Your Images**
   - Don't just use `:latest`
   - Use version numbers: `myapp:v1.0.0`

5. **Containers Are Disposable**
   - Design apps to be stateless
   - Store state in databases or volumes, not containers

### **Best Practices:**

```bash
# ✅ GOOD
docker run -d --name web -p 8080:80 -v data:/var/lib/mysql mysql:8.0

# ❌ BAD
docker run mysql
# No name, no version, no volume - data will be lost!
```

---

**You now have a complete reference for Docker!** Bookmark this guide and use it whenever you need to:
- Understand what Docker is and how it works
- Build and run containers
- Debug problems
- Update your applications
- Work with multiple containers using Docker Compose

**Next Steps:**
1. Practice building a simple app with Docker
2. Try docker-compose with web + database
3. Learn about Docker Swarm or Kubernetes for production

Happy Dockerizing! 🐳
