FROM node:20-alpine

# Install build deps for sharp (native bindings)
RUN apk add --no-cache python3 make g++ vips-dev

WORKDIR /app

# Copy package files first for better layer caching
COPY package.json ./
COPY pnpm-lock.yaml* ./

# Install pnpm and dependencies
RUN npm install -g pnpm && pnpm install --frozen-lockfile

# Copy source code
COPY . .

# Build TypeScript
RUN pnpm run build

# Create persistent directories
RUN mkdir -p data cache

# data/ holds the Telegram session + bot data (mount as volume to persist)
VOLUME ["/app/data"]

CMD ["node", "start.js"]
