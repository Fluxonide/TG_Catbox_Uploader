# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

# Copy package files
COPY package.json package-lock.json* ./

# Install dependencies using npm (more reliable in Docker)
RUN npm ci --include=dev

# Copy source
COPY . .

# Build TypeScript
RUN npm run build

# Runtime stage — minimal production image
FROM node:22-alpine

WORKDIR /app

# Copy package files
COPY package.json package-lock.json* ./

# Install only production dependencies
RUN npm ci --omit=dev

# Copy built artifacts from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/start.js ./

# Create cache and data directories
RUN mkdir -p ./cache ./data

# Start via compiled JS
CMD ["node", "start.js"]
