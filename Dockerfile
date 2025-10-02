FROM node:22-alpine

# Install dependencies for building native modules
RUN apk add --no-cache python3 make g++

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./
COPY yarn.lock* ./

# Install dependencies
RUN if [ -f yarn.lock ]; then yarn install --frozen-lockfile; \
    else npm ci; fi

# Copy application files
COPY . .

# Build the application (if needed)
RUN if [ -f tsconfig.json ]; then npm run build || true; fi

# Expose port
EXPOSE 17000

# Start the application
CMD ["npm", "run", "dev"]
