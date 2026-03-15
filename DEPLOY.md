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

- Deployed as a "web" service with health check endpoint at `/health`
- Free tier has 750 hours/month (enough for 24/7 operation)
- Service will spin down after 15 minutes of inactivity on free tier
- First request after spin-down takes ~30 seconds to wake up
- Persistent disk not included in free tier (cache is ephemeral)
- Use external monitoring (like Pulsetic) to prevent spin-down

## Uptime Monitoring with Pulsetic

To keep your Render service alive 24/7 on the free tier, use [Pulsetic](https://pulsetic.com) for uptime monitoring:

### Setup Steps

1. Deploy your bot to Render and copy the service URL (e.g., `https://tg-catbox-uploader.onrender.com`)
2. Sign up for a free [Pulsetic](https://pulsetic.com) account
3. Create a new monitor:
   - **URL**: `https://your-service.onrender.com/health`
   - **Check Interval**: 5 minutes (free tier allows 1-minute checks)
   - **Method**: GET
   - **Expected Status**: 200
4. Save and activate the monitor

### How It Works

- Pulsetic pings your `/health` endpoint every 5 minutes
- This prevents Render from spinning down your service due to inactivity
- The health endpoint returns bot status: `{ status: 'ok', bot: 'YourBotName', connected: true, uptime: 12345 }`
- You'll also get alerts if your bot goes down

### Alternative Monitoring Services

- [UptimeRobot](https://uptimerobot.com) - Free, 50 monitors, 5-minute intervals
- [Cronitor](https://cronitor.io) - Free tier available
- [Better Uptime](https://betteruptime.com) - Free for 10 monitors
- [Freshping](https://www.freshworks.com/website-monitoring/) - Free, unlimited checks

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

The bot exposes a simple HTTP health check endpoint when `PORT` environment variable is set:

- **Endpoint**: `/health` or `/`
- **Response**: `{ status: 'ok', bot: 'BotName', connected: true, uptime: 12345 }`
- **Railway**: Uses process monitoring (HTTP server optional)
- **Render**: Requires HTTP server for web services (health check at `/health`)

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
| Cold Starts        | ❌              | ✅ (15 min)   | ❌     |
| Uptime Monitoring  | Optional        | Recommended   | Manual |
| Setup Difficulty   | Easy            | Easy          | Medium |

## Recommendations

- **Railway**: Best for 24/7 operation with persistent storage
- **Render**: Good for 24/7 operation, no cold starts for worker services
- **Docker**: Best for VPS/self-hosted with full control
