import { TelegramClient, type Api } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { LogLevel } from 'telegram/extensions/Logger.js'
import { CallbackQuery } from 'telegram/events/CallbackQuery.js'
import { NewMessage } from 'telegram/events/index.js'
import { loadBotData, log, cleanupOrphanTransferTasks } from './src/handler/data.js'
import { API_ID, API_HASH, BOT_TOKEN } from './src/env.js'
import { handleCallbackQuery } from './src/handler/callbackQuery.js'
import { handleMessage } from './src/handler/message.js'

const stringSession = new StringSession(
  existsSync('./data/.session') ? readFileSync('./data/.session', 'utf-8') : '',
)

log('Login to Telegram...')

export const bot = new TelegramClient(stringSession, API_ID, API_HASH, {
  connectionRetries: 5,
  useWSS: false,
  autoReconnect: true,
})

loadBotData()
bot.setLogLevel(LogLevel.INFO)
bot.addEventHandler(handleMessage, new NewMessage({}))
bot.addEventHandler(handleCallbackQuery, new CallbackQuery())
await bot.start({
  botAuthToken: BOT_TOKEN,
})
await bot.connect()

cleanupOrphanTransferTasks()

export const BOT_NAME = ((await bot.getMe()) as Api.User).username!

writeFileSync('./data/.session', bot.session.save() as unknown as string)
log('Launched successfully.')

// Simple HTTP server for health checks (Render requirement)
if (process.env.PORT) {
  const http = await import('http')
  const PORT = parseInt(process.env.PORT)

  const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/health') {
      const totalSeconds = process.uptime()
      const days = Math.floor(totalSeconds / 86400)
      const hours = Math.floor((totalSeconds % 86400) / 3600)
      const minutes = Math.floor((totalSeconds % 3600) / 60)
      const seconds = (totalSeconds % 60).toFixed(3)
      const uptime = `${days} days ${hours} hours ${minutes} min ${seconds} s`

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          status: 'ok',
          bot: BOT_NAME,
          connected: bot.connected,
          uptime,
        }),
      )
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('Not Found')
    }
  })

  server.listen(PORT, () => {
    log(`Health check server listening on port ${PORT}`)
  })
}

process
  .on('unhandledRejection', (reason, promise) => {
    console.error(reason, 'Unhandled Rejection at', promise)
  })
  .on('uncaughtException', error => {
    console.error(error, 'Uncaught Exception thrown')
  })
