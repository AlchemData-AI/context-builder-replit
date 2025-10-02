# Context Builder - Setup & Run Guide

## Prerequisites

- Docker & Docker Compose installed
- Git (optional, for version control)
- Terminal/Command line access

## Quick Start (Recommended)

### 1. Initial Setup

```bash
# Run the setup script
./setup_docker.sh

# Choose option 7 (Setup and start - first time setup)
# Enter passwords when prompted (or use defaults)
# Optionally enter your Gemini API key
```

**What this does:**
- Builds PostgreSQL container (port 5432)
- Builds Neo4j container (ports 7474, 7687)
- Builds Node.js app container (port 17000)
- Runs database migrations
- Creates `.env` file with credentials

### 2. Access Services

- **Application:** http://localhost:17000
- **Neo4j Browser:** http://localhost:7474
- **PostgreSQL:** localhost:5432

### 3. Default Credentials

**PostgreSQL:**
- Host: `postgres` (from Docker) or `localhost` (from host machine)
- Port: `5432`
- Database: `alchemdata_local`
- Username: `postgres`
- Password: `postgres`

**Neo4j:**
- URI (from Docker): `neo4j://neo4j:7687`
- URI (from host): `neo4j://localhost:7687`
- Browser: http://localhost:7474
- Username: `neo4j`
- Password: `password123`

## Setting Up Connections in the App

### Create PostgreSQL Connection

```bash
curl 'http://localhost:17000/api/connections' \
  -H 'Content-Type: application/json' \
  --data-raw '{
    "name": "my_postgres_db",
    "type": "postgresql",
    "config": {
      "host": "your-host.com",
      "port": 5432,
      "database": "your_database",
      "user": "your_username",
      "password": "your_password"
    }
  }'
```

**Important:** For Azure PostgreSQL, SSL is auto-enabled

### Create Neo4j Connection

```bash
curl 'http://localhost:17000/api/connections' \
  -H 'Content-Type: application/json' \
  --data-raw '{
    "name": "my_neo4j",
    "type": "neo4j",
    "config": {
      "uri": "neo4j://neo4j:7687",
      "username": "neo4j",
      "password": "password123"
    }
  }'
```

**Important:** Use `neo4j://neo4j:7687` (not `localhost`) when app runs in Docker

### Create Gemini Connection

```bash
curl 'http://localhost:17000/api/connections' \
  -H 'Content-Type: application/json' \
  --data-raw '{
    "name": "gemini_ai",
    "type": "gemini",
    "config": {
      "apiKey": "YOUR_GEMINI_API_KEY"
    }
  }'
```

Get API key from: https://makersuite.google.com/app/apikey

### Test Connection

```bash
curl -X POST 'http://localhost:17000/api/connections/{CONNECTION_ID}/test'
```

## Daily Usage

### Start Everything

```bash
docker compose up -d
```

### Stop Everything

```bash
docker compose down
```

### View Logs

```bash
# All services
docker compose logs -f

# App only
docker compose logs -f app

# Specific service
docker compose logs -f postgres
docker compose logs -f neo4j
```

### Restart After Code Changes

```bash
# Restart app only
docker compose restart app

# Rebuild and restart
docker compose build app && docker compose up -d app
```

### Clean Start (Remove All Data)

```bash
docker compose down -v
./setup_docker.sh  # Choose option 7
```

## Manual Setup (Without Docker)

### PostgreSQL Setup

```bash
./setup_postgres.sh
# Choose option 1 (local) or 2 (Docker)
```

### Neo4j Setup

```bash
./setup_neo4j.sh
# Choose option 1 (Docker), 2 (local), or 3 (Desktop)
```

### Run Application Locally

```bash
npm install
npm run db:push
npm run dev
```

**Environment variables needed in `.env`:**
```env
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/alchemdata_local
NEO4J_URI=neo4j://localhost:7687
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=password123
NEO4J_DATABASE=neo4j
NEO4J_USE_CANONICAL_KEYS=true
GEMINI_API_KEY=your_gemini_api_key
```

## Troubleshooting

### Port Already in Use

```bash
# Check what's using the port
lsof -i :17000
lsof -i :5432
lsof -i :7687

# Kill the process or change ports in docker-compose.yml
```

### Database Connection Failed

```bash
# Check if containers are running
docker compose ps

# Check container logs
docker compose logs postgres
docker compose logs neo4j

# Verify environment variables
docker compose exec app env | grep -E "DATABASE|NEO4J"
```

### App Not Starting

```bash
# View app logs
docker compose logs app

# Restart app
docker compose restart app

# Rebuild if dependencies changed
docker compose build app --no-cache
docker compose up -d app
```

### Neo4j Connection Fails from App

- **Problem:** Using `neo4j://localhost:7687` in connection config
- **Solution:** Use `neo4j://neo4j:7687` (Docker service name)
- From your browser/host machine: Use `localhost`
- From app container: Use service name `neo4j`

### PostgreSQL Connection Needs SSL

- For Azure PostgreSQL, SSL is auto-enabled
- For other hosts with SSL, it's auto-detected
- Connection will fail with "no encryption" error if SSL is needed but not used

### Clear Data

```bash
# Clear all connections
docker compose exec -T postgres psql -U postgres -d alchemdata_local -c "TRUNCATE TABLE connections CASCADE;"

# Clear all jobs
docker compose exec -T postgres psql -U postgres -d alchemdata_local -c "TRUNCATE TABLE analysis_jobs CASCADE;"

# Clear all data (nuclear option)
docker compose down -v
```

## Useful Commands

### Database Access

```bash
# Access PostgreSQL
docker compose exec postgres psql -U postgres -d alchemdata_local

# Run SQL query
docker compose exec -T postgres psql -U postgres -d alchemdata_local -c "SELECT * FROM connections;"
```

### Container Management

```bash
# View running containers
docker compose ps

# Stop specific service
docker compose stop app

# Remove containers (keeps data)
docker compose down

# Remove containers and volumes (deletes data)
docker compose down -v
```

### Development

```bash
# Watch app logs
docker compose logs -f app

# Rebuild after package.json changes
docker compose build app
docker compose up -d app

# Run migrations
docker compose exec app npm run db:push

# Access app container shell
docker compose exec app sh
```

## Architecture

```
┌─────────────────────────────────────────────────┐
│           Docker Compose Stack                  │
├─────────────────────────────────────────────────┤
│                                                 │
│  ┌──────────────┐  ┌───────────────┐          │
│  │  PostgreSQL  │  │    Neo4j      │          │
│  │   :5432      │  │  :7474/:7687  │          │
│  └──────────────┘  └───────────────┘          │
│         ▲                  ▲                    │
│         │                  │                    │
│         └─────────┬────────┘                    │
│                   │                             │
│          ┌────────▼─────────┐                  │
│          │   Node.js App    │                  │
│          │     :17000       │                  │
│          └──────────────────┘                  │
│                   │                             │
└───────────────────┼─────────────────────────────┘
                    │
                    ▼
             External APIs
           (Gemini, Azure, etc)
```

## API Endpoints

- `GET /api/connections` - List all connections
- `POST /api/connections` - Create connection
- `POST /api/connections/:id/test` - Test connection
- `GET /api/databases` - List databases for a connection
- `POST /api/analyze/:databaseId` - Analyze database schema

## Notes

- Duplicate connection names are prevented (case-insensitive)
- Database unique constraint enforces `(userId, name)` uniqueness
- SSL is auto-enabled for Azure PostgreSQL hosts
- Neo4j uses `neo4j://neo4j:7687` from Docker, `neo4j://localhost:7687` from host
- Default Node version: 22 (alpine)
