#!/bin/bash

set -e

echo "=== PostgreSQL Local Setup for Alchemdata ==="
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if PostgreSQL is installed
check_postgres() {
    if command -v psql &> /dev/null; then
        echo -e "${GREEN}✓ PostgreSQL is installed${NC}"
        return 0
    else
        echo -e "${YELLOW}✗ PostgreSQL is not installed${NC}"
        return 1
    fi
}

# Check if Docker is installed
check_docker() {
    if command -v docker &> /dev/null; then
        echo -e "${GREEN}✓ Docker is installed${NC}"
        return 0
    else
        echo -e "${YELLOW}✗ Docker is not installed${NC}"
        return 1
    fi
}

# Setup with local PostgreSQL
setup_local_postgres() {
    echo ""
    echo "Setting up with local PostgreSQL..."

    # Start PostgreSQL service (Mac)
    if [[ "$OSTYPE" == "darwin"* ]]; then
        echo "Starting PostgreSQL service (macOS)..."
        brew services start postgresql 2>/dev/null || echo -e "${YELLOW}Note: Start PostgreSQL manually if needed${NC}"
    elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
        echo "Starting PostgreSQL service (Linux)..."
        sudo service postgresql start 2>/dev/null || echo -e "${YELLOW}Note: Start PostgreSQL manually if needed${NC}"
    fi

    # Wait a moment for PostgreSQL to start
    sleep 2

    # Create database
    echo "Creating database 'alchemdata_local'..."
    createdb alchemdata_local 2>/dev/null || psql postgres -c "CREATE DATABASE alchemdata_local;" 2>/dev/null || echo -e "${YELLOW}Database may already exist${NC}"

    # Get username
    DB_USER="${USER}"
    echo ""
    read -p "Enter PostgreSQL username (default: ${DB_USER}): " input_user
    DB_USER="${input_user:-$DB_USER}"

    # Get password
    read -sp "Enter PostgreSQL password (leave empty if no password): " DB_PASS
    echo ""

    # Construct DATABASE_URL
    if [ -z "$DB_PASS" ]; then
        DATABASE_URL="postgresql://${DB_USER}@localhost:5432/alchemdata_local"
    else
        DATABASE_URL="postgresql://${DB_USER}:${DB_PASS}@localhost:5432/alchemdata_local"
    fi
}

# Setup with Docker
setup_docker_postgres() {
    echo ""
    echo "Setting up PostgreSQL with Docker..."

    # Check if container already exists
    if docker ps -a | grep -q alchemdata-postgres; then
        echo -e "${YELLOW}Container 'alchemdata-postgres' already exists${NC}"
        read -p "Remove existing container and create new? (y/N): " remove_container
        if [[ $remove_container =~ ^[Yy]$ ]]; then
            docker rm -f alchemdata-postgres
        else
            echo "Using existing container..."
            docker start alchemdata-postgres 2>/dev/null || true
            DATABASE_URL="postgresql://postgres:mysecretpassword@localhost:5432/alchemdata_local"
            return 0
        fi
    fi

    # Get password
    read -sp "Enter PostgreSQL password for Docker (default: mysecretpassword): " DB_PASS
    echo ""
    DB_PASS="${DB_PASS:-mysecretpassword}"

    # Run Docker container
    echo "Starting PostgreSQL container..."
    docker run --name alchemdata-postgres \
      -e POSTGRES_PASSWORD="$DB_PASS" \
      -e POSTGRES_DB=alchemdata_local \
      -p 5432:5432 \
      -d postgres:15

    DATABASE_URL="postgresql://postgres:${DB_PASS}@localhost:5432/alchemdata_local"

    echo -e "${GREEN}✓ Docker container 'alchemdata-postgres' started${NC}"
    echo "  To stop: docker stop alchemdata-postgres"
    echo "  To start: docker start alchemdata-postgres"
}

# Main setup
echo "Checking system..."
check_postgres
HAS_POSTGRES=$?
check_docker
HAS_DOCKER=$?

echo ""
echo "Choose setup method:"
echo "1) Use local PostgreSQL"
echo "2) Use Docker (recommended)"
echo "3) Exit"
read -p "Enter choice [1-3]: " choice

case $choice in
    1)
        if [ $HAS_POSTGRES -ne 0 ]; then
            echo -e "${RED}PostgreSQL is not installed. Install it first:${NC}"
            echo "  Mac: brew install postgresql"
            echo "  Linux: sudo apt install postgresql"
            exit 1
        fi
        setup_local_postgres
        ;;
    2)
        if [ $HAS_DOCKER -ne 0 ]; then
            echo -e "${RED}Docker is not installed. Install it from docker.com${NC}"
            exit 1
        fi
        setup_docker_postgres
        ;;
    3)
        echo "Exiting..."
        exit 0
        ;;
    *)
        echo -e "${RED}Invalid choice${NC}"
        exit 1
        ;;
esac

# Create or update .env file
echo ""
echo "Updating .env file..."
if [ -f .env ]; then
    if grep -q "^DATABASE_URL=" .env; then
        # Update existing DATABASE_URL
        if [[ "$OSTYPE" == "darwin"* ]]; then
            sed -i '' "s|^DATABASE_URL=.*|DATABASE_URL=${DATABASE_URL}|" .env
        else
            sed -i "s|^DATABASE_URL=.*|DATABASE_URL=${DATABASE_URL}|" .env
        fi
        echo -e "${GREEN}✓ Updated DATABASE_URL in .env${NC}"
    else
        # Append DATABASE_URL
        echo "DATABASE_URL=${DATABASE_URL}" >> .env
        echo -e "${GREEN}✓ Added DATABASE_URL to .env${NC}"
    fi
else
    # Create new .env file
    echo "DATABASE_URL=${DATABASE_URL}" > .env
    echo -e "${GREEN}✓ Created .env with DATABASE_URL${NC}"
fi

# Run migrations
echo ""
read -p "Run database migrations now? (Y/n): " run_migrations
if [[ ! $run_migrations =~ ^[Nn]$ ]]; then
    echo "Installing dependencies..."
    npm install

    echo "Running migrations..."
    npm run db:push

    echo -e "${GREEN}✓ Migrations completed${NC}"
fi

echo ""
echo -e "${GREEN}=== Setup Complete ===${NC}"
echo ""
echo "DATABASE_URL: ${DATABASE_URL}"
echo ""
echo "Next steps:"
echo "  1. Start the app: npm run dev"
echo "  2. Note: You'll also need Neo4j for knowledge graph features"
echo ""
