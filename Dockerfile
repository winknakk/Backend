# Stage 1: Builder
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package manifests and lockfile
COPY package*.json ./

# Install ALL dependencies (including devDependencies like typescript)
RUN npm ci

# Copy configuration and source files
COPY tsconfig.json ./
COPY src/ ./src
COPY prompts/ ./prompts
COPY agent-policies/ ./agent-policies

# Run TypeScript compilation
RUN npm run build

# Remove development packages, leaving only production dependencies
RUN npm prune --production

# Stage 2: Runner (Production Environment)
FROM node:20-alpine AS runner

WORKDIR /app

# Expose server port
EXPOSE 3000

# Set Node environment variables
ENV NODE_ENV=production

# Create persistent storage directories and assign permissions to the non-root 'node' user
RUN mkdir -p data/backups && chown -R node:node /app

# Copy verified production node_modules and compiled dist output
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/package.json ./package.json
COPY --from=builder --chown=node:node /app/prompts ./prompts
COPY --from=builder --chown=node:node /app/agent-policies ./agent-policies

# Enforce security hardening by switching execution context to non-root 'node' user
USER node

# Start Fastify server
CMD ["node", "dist/api/server.js"]
