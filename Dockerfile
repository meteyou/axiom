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
    sudo \
    gosu \
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

# Configure npm global prefix to persist packages in /data volume
ENV NPM_CONFIG_PREFIX=/data/npm-global
ENV PATH="/data/npm-global/bin:${PATH}"

# Create data directories
RUN mkdir -p /data/db /data/config /data/memory/daily /data/skills /data/npm-global /workspace

# Save baseline package snapshot for auto-tracking agent-installed packages
RUN dpkg-query -W -f='${Package}\n' | sort -u > /etc/dpkg-base-packages.txt

# Install apt hook to auto-track packages installed at runtime
COPY track-packages.sh /usr/local/bin/track-packages.sh
RUN chmod +x /usr/local/bin/track-packages.sh \
    && echo 'DPkg::Post-Invoke {"/usr/local/bin/track-packages.sh";};' \
       > /etc/apt/apt.conf.d/99track-packages

# Create non-root agent user with /workspace as home
ARG USERNAME=agent
ARG USER_UID=1000
ARG USER_GID=1000
RUN groupadd --gid ${USER_GID} ${USERNAME} \
    && useradd --uid ${USER_UID} --gid ${USER_GID} -d /workspace ${USERNAME} -s /bin/bash \
    && echo "${USERNAME} ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/${USERNAME} \
    && chmod 0440 /etc/sudoers.d/${USERNAME} \
    && chown -R ${USER_UID}:${USER_GID} /workspace /data

# Copy entrypoint
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

ENTRYPOINT ["/entrypoint.sh"]
