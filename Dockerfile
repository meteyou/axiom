FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV NODE_VERSION=22

# Install system packages
RUN apt-get update && apt-get install -y \
    git \
    python3 \
    python3-pip \
    curl \
    wget \
    build-essential \
    jq \
    ca-certificates \
    gnupg \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js
RUN curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Verify installations
RUN node --version && npm --version && git --version && python3 --version && jq --version

# Create app directory
WORKDIR /app

# Copy package files first for better caching
COPY package.json package-lock.json* ./
COPY packages/core/package.json packages/core/
COPY packages/telegram/package.json packages/telegram/
COPY packages/web-backend/package.json packages/web-backend/
COPY packages/web-frontend/package.json packages/web-frontend/

# Install dependencies
RUN npm install

# Copy source code
COPY . .

# Build all packages
RUN npm run build

# Create data directories
RUN mkdir -p /data/db /data/config /data/memory/daily /data/skills /workspace

# Copy entrypoint
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

ENTRYPOINT ["/entrypoint.sh"]
