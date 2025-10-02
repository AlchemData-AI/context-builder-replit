# Local Development Setup

Three ways to set up your local development environment:

## Option 1: Docker Compose (Recommended - All-in-One)

**Easiest setup - runs PostgreSQL, Neo4j, and your Node.js app all in Docker containers**

```bash
./setup_docker.sh
```

Choose option `7` for first-time setup. This will:
- Build and start PostgreSQL, Neo4j, and App containers
- Create and configure `.env` file
- Run database migrations automatically
- Open Neo4j Browser and Application

**Services:**
- Application: `http://localhost:17000`
- PostgreSQL: `localhost:5432`
- Neo4j Browser: `http://localhost:7474`
- Neo4j Bolt: `localhost:7687`

**Default Credentials:**
- PostgreSQL: `postgres/postgres`
- Neo4j: `neo4j/password123`

**Useful Commands:**
```bash
./setup_docker.sh              # Interactive menu
docker compose up -d           # Start all services
docker compose down            # Stop all services
docker compose logs -f         # View all logs
docker compose logs -f app     # View app logs only
docker compose restart app     # Restart app only
docker compose build app       # Rebuild app after code changes
```

**Development Workflow:**
- Code changes are automatically synced to the container
- The app runs with hot-reload enabled
- To rebuild after dependency changes: `docker compose build app && docker compose up -d app`

---

## Option 2: Individual Setup Scripts

### PostgreSQL Setup
```bash
./setup_postgres.sh
```

Choose from:
1. Local PostgreSQL installation
2. Docker container

### Neo4j Setup
```bash
./setup_neo4j.sh
```

Choose from:
1. Docker container (recommended)
2. Local installation
3. Neo4j Desktop (GUI)

---

## Option 3: Manual Setup

See the comments in the setup scripts for manual installation instructions.

---

## Environment Variables

After setup, your `.env` should contain:

```env
# PostgreSQL (use localhost for local setup, postgres for Docker)
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/alchemdata_local

# Neo4j (use localhost for local setup, neo4j for Docker)
NEO4J_URI=neo4j://localhost:7687
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=password123
NEO4J_DATABASE=neo4j
NEO4J_USE_CANONICAL_KEYS=true

# Google Gemini (add your own key)
GEMINI_API_KEY=your_gemini_api_key_here
```

**Note:** When using Docker Compose (Option 1), the app container automatically uses correct hostnames (`postgres:5432` and `neo4j:7687`) via docker-compose.yml environment variables. The `.env` file is for local development reference.

---

## Running the Application

### With Docker (Option 1)
```bash
./setup_docker.sh  # Choose option 7 for first time, option 1 to start
```

### Without Docker (Options 2 or 3)
```bash
npm install
npm run dev
```

---

## Troubleshooting

### Docker services won't start
```bash
# Check Docker is running
docker info

# View logs
docker compose logs -f

# Restart services
docker compose restart
```

### Port conflicts
If ports 5432, 7474, or 7687 are in use:
- Stop conflicting services
- Or modify ports in `docker-compose.yml`

### Database connection errors
```bash
# Check services are running
docker compose ps

# Verify environment variables
cat .env

# Test PostgreSQL connection
docker compose exec postgres psql -U postgres -d alchemdata_local
```

### Reset everything
```bash
./setup_docker.sh  # Choose option 5 to remove all data
```