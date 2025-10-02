#!/bin/bash

set -e

echo "=== Neo4j Local Setup for Alchemdata ==="
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

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

# Check if Neo4j is installed locally
check_neo4j() {
    if command -v neo4j &> /dev/null; then
        echo -e "${GREEN}✓ Neo4j is installed locally${NC}"
        return 0
    else
        echo -e "${YELLOW}✗ Neo4j is not installed locally${NC}"
        return 1
    fi
}

# Setup with Docker
setup_docker_neo4j() {
    echo ""
    echo "Setting up Neo4j with Docker..."

    # Check if container already exists
    if docker ps -a | grep -q alchemdata-neo4j; then
        echo -e "${YELLOW}Container 'alchemdata-neo4j' already exists${NC}"
        read -p "Remove existing container and create new? (y/N): " remove_container
        if [[ $remove_container =~ ^[Yy]$ ]]; then
            docker rm -f alchemdata-neo4j
        else
            echo "Using existing container..."
            docker start alchemdata-neo4j 2>/dev/null || true
            NEO4J_PASSWORD="password123"
            return 0
        fi
    fi

    # Get password
    read -sp "Enter Neo4j password (default: password123): " NEO4J_PASSWORD
    echo ""
    NEO4J_PASSWORD="${NEO4J_PASSWORD:-password123}"

    # Run Docker container
    echo "Starting Neo4j container..."
    docker run --name alchemdata-neo4j \
      -p 7474:7474 -p 7687:7687 \
      -e NEO4J_AUTH=neo4j/${NEO4J_PASSWORD} \
      -e NEO4J_PLUGINS='["apoc"]' \
      -d neo4j:5

    echo -e "${GREEN}✓ Docker container 'alchemdata-neo4j' started${NC}"
    echo ""
    echo "  Neo4j Browser: ${BLUE}http://localhost:7474${NC}"
    echo "  Username: neo4j"
    echo "  Password: ${NEO4J_PASSWORD}"
    echo ""
    echo "  To stop: docker stop alchemdata-neo4j"
    echo "  To start: docker start alchemdata-neo4j"
    echo "  To remove: docker rm -f alchemdata-neo4j"
}

# Setup with local Neo4j
setup_local_neo4j() {
    echo ""
    echo "Setting up with local Neo4j..."

    if [[ "$OSTYPE" == "darwin"* ]]; then
        if ! command -v neo4j &> /dev/null; then
            echo -e "${YELLOW}Neo4j not installed. Installing via Homebrew...${NC}"
            read -p "Install Neo4j with Homebrew? (Y/n): " install_neo4j
            if [[ ! $install_neo4j =~ ^[Nn]$ ]]; then
                brew install neo4j
            else
                echo -e "${RED}Cannot proceed without Neo4j installed${NC}"
                exit 1
            fi
        fi
        echo "Starting Neo4j..."
        neo4j start
    elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
        if ! command -v neo4j &> /dev/null; then
            echo -e "${YELLOW}Neo4j not installed. Install it manually:${NC}"
            echo "  wget -O - https://debian.neo4j.com/neotechnology.gpg.key | sudo apt-key add -"
            echo "  echo 'deb https://debian.neo4j.com stable latest' | sudo tee /etc/apt/sources.list.d/neo4j.list"
            echo "  sudo apt update"
            echo "  sudo apt install neo4j"
            exit 1
        fi
        echo "Starting Neo4j..."
        sudo systemctl start neo4j
    fi

    # Get password
    read -sp "Enter Neo4j password (default: password123): " NEO4J_PASSWORD
    echo ""
    NEO4J_PASSWORD="${NEO4J_PASSWORD:-password123}"

    echo -e "${GREEN}✓ Neo4j service started${NC}"
    echo ""
    echo "  Neo4j Browser: ${BLUE}http://localhost:7474${NC}"
    echo "  Username: neo4j"
    echo "  Password: ${NEO4J_PASSWORD}"
}

# Setup with Neo4j Desktop
setup_desktop_neo4j() {
    echo ""
    echo -e "${BLUE}=== Neo4j Desktop Setup ===${NC}"
    echo ""
    echo "1. Download Neo4j Desktop from: https://neo4j.com/download/"
    echo "2. Install and open Neo4j Desktop"
    echo "3. Create a new project"
    echo "4. Click 'Add Database' → 'Create a Local DBMS'"
    echo "5. Set a password and start the database"
    echo ""

    read -p "Press Enter when you've completed the setup..."
    echo ""

    # Get password
    read -sp "Enter the password you set in Neo4j Desktop: " NEO4J_PASSWORD
    echo ""

    echo -e "${GREEN}✓ Neo4j Desktop setup noted${NC}"
    echo ""
    echo "  Neo4j Browser: ${BLUE}http://localhost:7474${NC}"
    echo "  Bolt URI: neo4j://localhost:7687"
    echo "  Username: neo4j"
    echo "  Password: ${NEO4J_PASSWORD}"
}

# Main setup
echo "Checking system..."
check_docker
HAS_DOCKER=$?
check_neo4j
HAS_NEO4J=$?

echo ""
echo "Choose setup method:"
echo "1) Use Docker (recommended - easiest)"
echo "2) Use local Neo4j installation"
echo "3) Use Neo4j Desktop (GUI)"
echo "4) Exit"
read -p "Enter choice [1-4]: " choice

case $choice in
    1)
        if [ $HAS_DOCKER -ne 0 ]; then
            echo -e "${RED}Docker is not installed. Install it from docker.com${NC}"
            exit 1
        fi
        setup_docker_neo4j
        ;;
    2)
        setup_local_neo4j
        ;;
    3)
        setup_desktop_neo4j
        ;;
    4)
        echo "Exiting..."
        exit 0
        ;;
    *)
        echo -e "${RED}Invalid choice${NC}"
        exit 1
        ;;
esac

# Default Neo4j password if not set
NEO4J_PASSWORD="${NEO4J_PASSWORD:-password123}"

# Neo4j environment variables
NEO4J_URI="neo4j://localhost:7687"
NEO4J_USERNAME="neo4j"
NEO4J_DATABASE="neo4j"
NEO4J_USE_CANONICAL_KEYS="true"

# Create or update .env file
echo ""
echo "Updating .env file..."

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

update_or_add_env "NEO4J_URI" "$NEO4J_URI"
update_or_add_env "NEO4J_USERNAME" "$NEO4J_USERNAME"
update_or_add_env "NEO4J_PASSWORD" "$NEO4J_PASSWORD"
update_or_add_env "NEO4J_DATABASE" "$NEO4J_DATABASE"
update_or_add_env "NEO4J_USE_CANONICAL_KEYS" "$NEO4J_USE_CANONICAL_KEYS"

echo -e "${GREEN}✓ Updated Neo4j configuration in .env${NC}"

# Test connection
echo ""
read -p "Test Neo4j connection? (Y/n): " test_connection
if [[ ! $test_connection =~ ^[Nn]$ ]]; then
    echo ""
    echo "Waiting for Neo4j to be ready..."
    sleep 5

    echo "Opening Neo4j Browser..."
    if command -v open &> /dev/null; then
        open http://localhost:7474
    elif command -v xdg-open &> /dev/null; then
        xdg-open http://localhost:7474
    else
        echo "Please open http://localhost:7474 in your browser"
    fi

    echo ""
    echo "To test, run this query in Neo4j Browser:"
    echo -e "${BLUE}CREATE (n:Test {name: \"Hello\"}) RETURN n${NC}"
fi

echo ""
echo -e "${GREEN}=== Setup Complete ===${NC}"
echo ""
echo "Neo4j Configuration:"
echo "  URI: ${NEO4J_URI}"
echo "  Username: ${NEO4J_USERNAME}"
echo "  Password: ${NEO4J_PASSWORD}"
echo "  Database: ${NEO4J_DATABASE}"
echo ""
echo "Next steps:"
echo "  1. Make sure PostgreSQL is also set up (run ./setup_postgres.sh)"
echo "  2. Add your GEMINI_API_KEY to .env if needed"
echo "  3. Start the app: npm run dev"
echo ""
