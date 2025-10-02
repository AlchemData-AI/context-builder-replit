# Quick Start Guide

## Complete Docker Setup (Recommended)

Single command to set up everything:

```bash
./setup_docker.sh
```

Choose option **7** for first-time setup.

This will:
1. ✅ Start PostgreSQL database
2. ✅ Start Neo4j graph database
3. ✅ Build and start your Node.js application
4. ✅ Run database migrations
5. ✅ Configure environment variables

### Access Your Services

- **Application**: http://localhost:17000
- **Neo4j Browser**: http://localhost:7474 (neo4j/password123)
- **PostgreSQL**: localhost:5432 (postgres/postgres)

### Daily Usage

```bash
# Start everything
docker compose up -d

# Stop everything
docker compose down

# View logs
docker compose logs -f

# Rebuild after code changes
docker compose build app && docker compose up -d app
```

## Architecture

```
┌─────────────────────────────────────────┐
│         Docker Compose Stack            │
├─────────────────────────────────────────┤
│                                         │
│  ┌─────────────┐  ┌──────────────┐    │
│  │ PostgreSQL  │  │   Neo4j      │    │
│  │  :5432      │  │  :7474/:7687 │    │
│  └─────────────┘  └──────────────┘    │
│         ▲                ▲              │
│         │                │              │
│         └────────┬───────┘              │
│                  │                      │
│         ┌────────▼────────┐            │
│         │  Node.js App    │            │
│         │    :17000       │            │
│         └─────────────────┘            │
│                                         │
└─────────────────────────────────────────┘
```

## Alternative Setup Methods

If you don't want to use Docker:

### PostgreSQL Only
```bash
./setup_postgres.sh
```

### Neo4j Only
```bash
./setup_neo4j.sh
```

Then run your app locally:
```bash
npm install
npm run dev
```

## Need Help?

See [SETUP.md](./SETUP.md) for detailed documentation.
