# Deployment Guide

This bot can be deployed on Railway, Render, or any platform that supports Docker/Node.js.

## Railway Deployment

Railway is configured via `railway.toml`.

### Quick Deploy

1. Fork this repository
2. Go to [Railway](https://railway.app)
3. Click "New Project" → "Deploy from GitHub repo"
4. Select your forked repository
5. Add environment variables (see below)
6. Deploy!

### Environment Variables

Required:

- `API_ID` - Telegram API ID from https://my.telegram.org
- `API_HASH` - Telegram API Hash
- `BOT_TOKEN` - Bot token from @BotFather
- `STRING_SESSION` - User session string (run locally first to generate)
- `ADMIN_ID` - Your Telegram user ID

Optional:

- `CATBOX_TOKEN` - Catbox.moe API token (for permanent uploads)
- `LOG_CHANNEL_ID` - Channel ID for logging uploads
- `MAX_DOWNLOADING` - Max concurrent downloads per user (default: 3)
- `DOWNLOAD_WORKERS` - Download chunk workers (default: 4)
- `DOWNLOAD_DC_ID` - Telegram DC for downloads (default: 4)
- `PARALLEL_DOWNLOADS` - Parallel batch downloads (default: 5)
- `BOT_NAME` - Bot display name (default: Catbox Uploader)

## Render Deployment

Render is configured via `render.yaml`.

### Quick Deploy

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy)

Or manually:

1. Fork this repository
2. Go to [Render](https://render.com)
3. Click "New" → "Blueprint"
4. Connect your GitHub repository
5. Render will detect `render.yaml` automatically
6. Fill in environment variables
7. Deploy!

### Notes for Render

- Deployed as a "worker" service (background process, no HTTP server needed)
- Free tier has 750 hours/month (enough for 24/7 operation)
- No cold starts for worker services (always running)
- Persistent disk not included in free tier (cache is ephemeral)

## Docker Deployment

For any platform supporting Docker:

```bash
# Build
docker build -t tg-catbox-uploader .

# Run
docker run -d \
  --name tg-catbox-uploader \
  --env-file .env \
  -v $(pwd)/cache:/app/cache \
  -v $(pwd)/data:/app/data \
  tg-catbox-uploader
```

## Docker Compose

```bash
docker-compose up -d
```

The `docker-compose.yml` is already configured with volume mounts for cache and data persistence.

## Manual Deployment (VPS/Local)

```bash
# Install dependencies
npm install

# Build
npm run build

# Start
node start.js
```

Make sure to create a `.env` file with all required variables (see `.env.example`).

## Generating STRING_SESSION

Run the bot locally once to generate your session string:

```bash
npm install
npm start
```

Follow the prompts to log in with your Telegram account. The session string will be saved to `data/session.txt`. Copy this value to your `STRING_SESSION` environment variable.

## Health Checks

The bot runs as a background worker and doesn't expose an HTTP server:

- **Railway**: Uses process monitoring (no HTTP needed)
- **Render**: Deployed as "worker" service (no health checks required)

## Troubleshooting

### Bot not responding

- Check logs for connection errors
- Verify `STRING_SESSION` is valid
- Ensure `BOT_TOKEN` is correct

### Downloads failing

- Check `DOWNLOAD_DC_ID` (try 1, 2, 4, or 5)
- Verify network connectivity
- Check disk space in cache directory

### Log uploads not working

- Verify `LOG_CHANNEL_ID` is correct
- Ensure bot is admin in the log channel
- Check bot has permission to send messages

## Platform Comparison

| Feature            | Railway         | Render        | Docker |
| ------------------ | --------------- | ------------- | ------ |
| Free Tier          | $5 credit/month | 750 hrs/month | N/A    |
| Auto-deploy        | ✅              | ✅            | Manual |
| Persistent Storage | ✅              | ❌ (paid)     | ✅     |
| Cold Starts        | ❌              | ❌            | ❌     |
| Setup Difficulty   | Easy            | Easy          | Medium |

## Recommendations

- **Railway**: Best for 24/7 operation with persistent storage
- **Render**: Good for 24/7 operation, no cold starts for worker services
- **Docker**: Best for VPS/self-hosted with full control
