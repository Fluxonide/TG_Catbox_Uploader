# Build stage
FROM node:22-alpine AS builder

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install dependencies (production + dev for build step)
RUN pnpm install --frozen-lockfile

# Copy source
COPY . .

# Build TypeScript
RUN pnpm run build

# Remove dev dependencies to keep image lean
RUN pnpm prune --prod

# Runtime stage — minimal production image
FROM node:22-alpine

WORKDIR /app

# Copy only production artifacts from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/start.js ./

# Create cache and data directories
RUN mkdir -p ./cache ./data

# Start via compiled JS
CMD ["node", "start.js"]
