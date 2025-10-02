#!/bin/bash

set -e

echo "=== Alchemdata Docker Development Environment Setup ==="
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Check if Docker and Docker Compose are installed
check_docker() {
    if ! command -v docker &> /dev/null; then
        echo -e "${RED}✗ Docker is not installed${NC}"
        echo "Please install Docker from https://docker.com"
        exit 1
    fi
    echo -e "${GREEN}✓ Docker is installed${NC}"

    if ! docker compose version &> /dev/null && ! command -v docker-compose &> /dev/null; then
        echo -e "${RED}✗ Docker Compose is not installed${NC}"
        echo "Please install Docker Compose"
        exit 1
    fi
    echo -e "${GREEN}✓ Docker Compose is installed${NC}"
}

# Check if Docker daemon is running
check_docker_daemon() {
    if ! docker info &> /dev/null; then
        echo -e "${RED}✗ Docker daemon is not running${NC}"
        echo "Please start Docker and try again"
        exit 1
    fi
    echo -e "${GREEN}✓ Docker daemon is running${NC}"
}

# Function to use docker compose (handles both 'docker compose' and 'docker-compose')
docker_compose_cmd() {
    if docker compose version &> /dev/null; then
        docker compose "$@"
    else
        docker-compose "$@"
    fi
}

# Update or add environment variable to .env
update_or_add_env() {
    local key=$1
    local value=$2

    if [ -f .env ]; then
        if grep -q "^${key}=" .env; then
            # Update existing entry
            if [[ "$OSTYPE" == "darwin"* ]]; then
                sed -i '' "s|^${key}=.*|${key}=${value}|" .env
            else
                sed -i "s|^${key}=.*|${key}=${value}|" .env
            fi
        else
            # Append new entry
            echo "${key}=${value}" >> .env
        fi
    else
        # Create new .env file
        echo "${key}=${value}" >> .env
    fi
}

# Main setup
echo "Checking system..."
check_docker
check_docker_daemon

echo ""
echo "Choose an action:"
echo "1) Start all services (PostgreSQL + Neo4j + App)"
echo "2) Stop all services"
echo "3) Restart all services"
echo "4) View service logs"
echo "5) Rebuild and restart app container"
echo "6) Remove all services and data"
echo "7) Setup and start (first time setup)"
echo "8) Exit"
read -p "Enter choice [1-8]: " choice

case $choice in
    1)
        echo ""
        echo "Starting services..."
        docker_compose_cmd up -d
        echo -e "${GREEN}✓ Services started${NC}"
        echo ""
        echo "PostgreSQL: localhost:5432"
        echo "Neo4j Browser: ${BLUE}http://localhost:7474${NC}"
        echo "Neo4j Bolt: localhost:7687"
        echo "Application: ${BLUE}http://localhost:17000${NC}"
        ;;
    2)
        echo ""
        echo "Stopping services..."
        docker_compose_cmd down
        echo -e "${GREEN}✓ Services stopped${NC}"
        ;;
    3)
        echo ""
        echo "Restarting services..."
        docker_compose_cmd restart
        echo -e "${GREEN}✓ Services restarted${NC}"
        ;;
    4)
        echo ""
        echo "Viewing logs (Ctrl+C to exit)..."
        docker_compose_cmd logs -f
        ;;
    5)
        echo ""
        echo "Rebuilding app container..."
        docker_compose_cmd build app
        echo "Restarting app..."
        docker_compose_cmd up -d app
        echo -e "${GREEN}✓ App container rebuilt and restarted${NC}"
        ;;
    6)
        echo ""
        echo -e "${YELLOW}WARNING: This will remove all data!${NC}"
        read -p "Are you sure? (yes/N): " confirm
        if [[ $confirm == "yes" ]]; then
            echo "Removing services and data..."
            docker_compose_cmd down -v
            echo -e "${GREEN}✓ Services and data removed${NC}"
        else
            echo "Cancelled"
        fi
        ;;
    7)
        echo ""
        echo "=== First Time Setup ==="
        echo ""

        # Get custom passwords or use defaults
        read -sp "Enter PostgreSQL password (default: postgres): " POSTGRES_PASSWORD
        echo ""
        POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-postgres}"

        read -sp "Enter Neo4j password (default: password123): " NEO4J_PASSWORD
        echo ""
        NEO4J_PASSWORD="${NEO4J_PASSWORD:-password123}"

        # Update docker-compose.yml if custom passwords are provided
        if [ "$POSTGRES_PASSWORD" != "postgres" ] || [ "$NEO4J_PASSWORD" != "password123" ]; then
            echo ""
            echo "Note: To use custom passwords, update docker-compose.yml manually or use default passwords"
            echo "Using default passwords for this setup..."
            POSTGRES_PASSWORD="postgres"
            NEO4J_PASSWORD="password123"
        fi

        # Create .env file with all required variables
        echo ""
        echo "Creating .env file..."

        update_or_add_env "DATABASE_URL" "postgresql://postgres:${POSTGRES_PASSWORD}@localhost:5432/alchemdata_local"
        update_or_add_env "NEO4J_URI" "neo4j://localhost:7687"
        update_or_add_env "NEO4J_USERNAME" "neo4j"
        update_or_add_env "NEO4J_PASSWORD" "${NEO4J_PASSWORD}"
        update_or_add_env "NEO4J_DATABASE" "neo4j"
        update_or_add_env "NEO4J_USE_CANONICAL_KEYS" "true"

        echo -e "${GREEN}✓ .env file updated${NC}"

        # Ask about Gemini API key
        echo ""
        read -p "Do you have a Gemini API key? (y/N): " has_gemini
        if [[ $has_gemini =~ ^[Yy]$ ]]; then
            read -p "Enter your Gemini API key: " GEMINI_KEY
            update_or_add_env "GEMINI_API_KEY" "${GEMINI_KEY}"
        else
            echo -e "${YELLOW}Note: Add GEMINI_API_KEY to .env later for AI features${NC}"
        fi

        # Build and start services
        echo ""
        echo "Building and starting Docker services..."
        docker_compose_cmd build
        docker_compose_cmd up -d

        echo ""
        echo "Waiting for services to be ready..."
        sleep 15

        # Check if services are healthy
        echo "Checking PostgreSQL..."
        docker_compose_cmd exec -T postgres pg_isready -U postgres || echo -e "${YELLOW}PostgreSQL may still be starting...${NC}"

        echo "Checking Neo4j..."
        curl -s http://localhost:7474 > /dev/null && echo -e "${GREEN}✓ Neo4j is ready${NC}" || echo -e "${YELLOW}Neo4j may still be starting...${NC}"

        echo "Checking Application..."
        sleep 5
        curl -s http://localhost:17000 > /dev/null && echo -e "${GREEN}✓ App is ready${NC}" || echo -e "${YELLOW}App may still be starting...${NC}"

        echo ""
        echo -e "${GREEN}=== Setup Complete ===${NC}"
        echo ""
        echo "Services running:"
        echo "  PostgreSQL:"
        echo "    Host: localhost:5432"
        echo "    Database: alchemdata_local"
        echo "    Username: postgres"
        echo "    Password: ${POSTGRES_PASSWORD}"
        echo ""
        echo "  Neo4j:"
        echo "    Browser: ${BLUE}http://localhost:7474${NC}"
        echo "    Bolt: neo4j://localhost:7687"
        echo "    Username: neo4j"
        echo "    Password: ${NEO4J_PASSWORD}"
        echo ""
        echo "  Application:"
        echo "    URL: ${BLUE}http://localhost:17000${NC}"
        echo ""
        echo "Useful commands:"
        echo "  View logs: docker compose logs -f"
        echo "  View app logs: docker compose logs -f app"
        echo "  Stop services: docker compose down"
        echo "  Restart: docker compose restart"
        echo "  Rebuild app: docker compose build app && docker compose up -d app"
        echo ""

        # Open Neo4j Browser and App
        if command -v open &> /dev/null; then
            open http://localhost:7474
            open http://localhost:17000
        elif command -v xdg-open &> /dev/null; then
            xdg-open http://localhost:7474
            xdg-open http://localhost:17000
        fi
        ;;
    8)
        echo "Exiting..."
        exit 0
        ;;
    *)
        echo -e "${RED}Invalid choice${NC}"
        exit 1
        ;;
esac

echo ""
