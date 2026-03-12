import * as fs from 'fs'
import i18n from '../i18n/index.js'
import mime from 'mime-types'
import bigInt from 'big-integer'
import { chatData, log } from './data.js'
import { bot, BOT_NAME } from '../../index.js'
import { Catbox, Litterbox } from 'node-catbox'
import { getCachedUrl, setCachedUrl } from './urlCache.js'
import {
  MAX_DOWNLOADING,
  ADMIN_ID,
  CATBOX_TOKEN,
  LOG_CHANNEL_ID,
  DOWNLOAD_DC_ID,
  DOWNLOAD_WORKERS,
} from '../env.js'
import type { Api } from 'telegram'

// Queue for ordered log channel messages
interface LogQueueItem {
  index: number
  filePath: string
  url: string
  service: string
  result: string
}

interface LogQueueEntry {
  item: LogQueueItem
  resolve: () => void
}

const logQueue: Map<number, LogQueueEntry[]> = new Map()
const logProcessing: Map<number, boolean> = new Map()
const logSentIndices: Map<number, Set<number>> = new Map()

async function sendToLogChannel(chat: number, item: LogQueueItem) {
  if (!LOG_CHANNEL_ID) return

  // Init tracking structures for this chat
  if (!logSentIndices.has(chat)) {
    logSentIndices.set(chat, new Set())
  }
  if (!logQueue.has(chat)) {
    logQueue.set(chat, [])
  }

  const sentSet = logSentIndices.get(chat)!

  // Skip if already sent (dedup)
  if (sentSet.has(item.index)) {
    log(`[Log] Skipping duplicate index ${item.index} for chat ${chat}`)
    return
  }

  // Create a promise that resolves when THIS item is processed
  const itemDone = new Promise<void>(resolve => {
    const queue = logQueue.get(chat)!
    queue.push({ item, resolve })
    queue.sort((a, b) => a.item.index - b.item.index)
  })

  // Start processing loop if not already running
  if (!logProcessing.get(chat)) {
    logProcessing.set(chat, true)
    // Don't fire-and-forget: process inline so we catch late arrivals
    processLogQueue(chat)
  }

  // Wait until this specific item has been sent
  await itemDone
}

async function processLogQueue(chat: number) {
  const queue = logQueue.get(chat)!
  const sentSet = logSentIndices.get(chat)!

  while (queue.length > 0) {
    const entry = queue[0]

    // Dedup check
    if (sentSet.has(entry.item.index)) {
      queue.shift()
      entry.resolve()
      continue
    }

    try {
      const imageMsg = await bot
        .sendFile(LOG_CHANNEL_ID, {
          file: entry.item.filePath,
          caption: `Source: \`${entry.item.url}\`\nService: ${entry.item.service}\nResult: \`${entry.item.result}\``,
        })
        .catch(() => null)

      if (imageMsg) {
        await bot
          .sendFile(LOG_CHANNEL_ID, {
            file: entry.item.filePath,
            forceDocument: true,
            replyTo: imageMsg.id,
          })
          .catch(() => null)
      }

      sentSet.add(entry.item.index)

      // Delay to avoid flood
      await new Promise(resolve => setTimeout(resolve, 3000))
    } catch (e) {
      log(`Failed to send to log channel: ${e.message}`)
    }

    queue.shift()
    entry.resolve()
  }

  logProcessing.set(chat, false)
}

export async function transfer(msg: Api.Message) {
  if (msg.peerId.className !== 'PeerUser' || !msg.media) return

  const chat = msg.peerId.userId.toJSNumber()
  const lang = chatData[chat].lang

  if (chatData[chat].banned) return bot.sendMessage(chat, { message: i18n.t(lang, 'error_banned') })
  else if (chatData[chat].downloading >= MAX_DOWNLOADING && chat !== ADMIN_ID)
    return bot.sendMessage(chat, {
      message: i18n.t(lang, 'flood_protection', [MAX_DOWNLOADING.toString()]),
    })

  let file: Api.TypeDocument | Api.TypePhoto | Api.TypeWebDocument
  if (
    'document' in msg.media &&
    msg.media.document &&
    msg.media.document.className === 'Document'
  ) {
    file = msg.media.document
  } else if ('photo' in msg.media && msg.media.photo && msg.media.photo.className === 'Photo') {
    file = msg.media.photo
  } else {
    return bot.sendMessage(chat, {
      message: i18n.t(lang, 'error_unsupportedFileType'),
      replyTo: msg.id,
    })
  }
  const service = chatData[chat].service
  let fileSize: number,
    fileExt: string,
    fileName = randomString(),
    filePath: string

  if (file.className === 'Photo') {
    const lastSize = file.sizes[file.sizes.length - 1]

    if ('sizes' in lastSize) fileSize = lastSize.sizes.slice(-1)[0]
    else if ('size' in lastSize) fileSize = lastSize.size
    else {
      return bot.sendMessage(chat, {
        message: i18n.t(lang, 'error_unsupportedFileType'),
        replyTo: msg.id,
      })
    }
    fileExt = 'jpg'
  } else {
    fileSize = file.size.toJSNumber()
    if (file.mimeType === 'application/x-tgsticker') {
      fileExt = 'tgs'
      await bot.sendMessage(chat, {
        message: i18n.t(lang, 'animatedStickers'),
        parseMode: 'html',
        linkPreview: false,
      })
    } else fileExt = mime.extension(file.mimeType) as string
  }

  if (
    (service === 'Catbox' && fileSize > 200000000) ||
    (service === 'Litterbox' && fileSize > 1000000000)
  )
    return bot.sendMessage(chat, {
      message: i18n.t(lang, 'err_FileTooBig', [service]),
    })

  chatData[chat].downloading++

  const editMsg = await bot.sendMessage(chat, {
    message: i18n.t(lang, 'downloading'),
    replyTo: msg.id,
  })

  if (!fs.existsSync('./cache')) fs.mkdirSync('./cache')

  while (fs.existsSync(`./cache/${chat}_${fileName}.${fileExt}`)) fileName = randomString()
  filePath = `./cache/${chat}_${fileName}.${fileExt}`
  log(`Start downloading: ${filePath} (Size ${fileSize})...`)

  // Timeout for downloading each group of chunks
  let dlChunkTimeout: NodeJS.Timeout | undefined = undefined

  try {
    // The last time when the message is edited, in UNIX timestamp format
    let lastEditTime = Date.now()
    let lastDownloadSize = 0
    let downloadedBytes = 0
    const chunkSize = 4096 * 1024 // 4 MB
    const totalChunks = Math.ceil(fileSize / chunkSize)
    let downloadedChunks = 0

    while (downloadedChunks < totalChunks) {
      if (!bot.connected) await bot.connect()

      dlChunkTimeout = setTimeout(() => {
        throw new Error(i18n.t(lang, 'error_downloadTimeout'))
      }, 60 * 1000)

      let chunksToDownload = DOWNLOAD_WORKERS

      if (downloadedChunks + chunksToDownload > totalChunks) {
        chunksToDownload = totalChunks - downloadedChunks
      }
      // Download the file in chunks
      const chunks = await Promise.all(
        Array.from({ length: chunksToDownload }, (_, i) => {
          return bot
            .iterDownload({
              file: msg.media,
              requestSize: chunkSize,
              offset: bigInt(chunkSize * i + downloadedChunks * chunkSize),
              limit: 1,
              dcId: DOWNLOAD_DC_ID,
            })
            .collect()
        }),
      )
      clearTimeout(dlChunkTimeout)
      // Append the chunks to the file
      chunks.forEach(chunk => {
        fs.appendFileSync(filePath, chunk[0] as Buffer, { encoding: 'binary' })
        downloadedBytes += (chunk[0] as Buffer).length
      })
      downloadedChunks += chunksToDownload

      const now = Date.now()
      // Update the progress message every 3 seconds
      if (downloadedBytes && now - lastEditTime > 3000) {
        // Convert to MB
        const downloaded = +(downloadedBytes / 1000 / 1000).toFixed(2)
        const total = +(fileSize / 1000 / 1000).toFixed(2)
        const speed = +((downloaded - lastDownloadSize) / ((now - lastEditTime) / 1000)).toFixed(2)
        const percent = Math.round((downloaded / total) * 100)
        const text =
          i18n.t(lang, 'downloadProgress', [
            total.toString(),
            downloaded.toString(),
            speed.toString(),
            secToTime(Math.round((total - downloaded) / speed)),
          ]) + `\n\n<code>[${'●'.repeat(percent / 5.5)}${'○'.repeat(18 - percent / 5.5)}]</code>`
        lastEditTime = now
        lastDownloadSize = downloaded

        bot
          .editMessage(chat, {
            message: editMsg.id,
            text: text,
            parseMode: 'html',
          })
          .catch(() => {})
      }
    }

    log(`Downloaded: ${filePath} (Size ${fileSize})`)

    // Animated upload progress indicator
    let uploadFrame = 0
    const uploadInterval = setInterval(() => {
      uploadFrame++
      const animPos = uploadFrame % 20
      const bar = '░'.repeat(animPos) + '█' + '░'.repeat(19 - animPos)
      const dots = '.'.repeat((uploadFrame % 3) + 1)
      bot
        .editMessage(chat, {
          message: editMsg.id,
          text: `<b>📤 Uploading to ${service}${dots}</b>\n\n` +
            `📁 Size: ${(fileSize / 1000 / 1000).toFixed(2)} MB\n` +
            `<code>[${bar}]</code>`,
          parseMode: 'html',
        })
        .catch(() => {})
    }, 2000)

    // Upload to Catbox / Litterbox
    let result: string
    let validity: string

    try {
      if (service.toLowerCase() === 'catbox') {
        validity = '∞'
        const client = new Catbox(chatData[chat].token || CATBOX_TOKEN || '')
        result = await client.uploadFile({ path: filePath })
      } else {
        const lbe = chatData[chat].lbe
        const client = new Litterbox()

        validity = `${lbe} ${i18n.t(lang, lbe === 1 ? 'hour' : 'hours')}`
        result = await client.upload({
          path: filePath,
          duration: `${validity}h` as any,
        })
      }
    } finally {
      clearInterval(uploadInterval)
    }
    const text = i18n.t(lang, 'uploaded', [
      service,
      (fileSize / 1000 / 1000).toFixed(2),
      validity,
      result,
      BOT_NAME,
    ])
    try {
      await bot.sendMessage(chat, {
        message: text,
        linkPreview: false,
        replyTo: msg.id,
        parseMode: 'html',
      })
    } catch (e) {
      // If send message fails, try to reconnect and send again
      if (!bot.connected) await bot.connect()
      try {
        await bot.sendMessage(chat, {
          message: text,
          parseMode: 'html',
          linkPreview: false,
        })
      } catch (e) {
        await bot
          .sendMessage(chat, { message: i18n.t(lang, 'error') + `\n\nError info: ${e.message}` })
          .catch(() => null)
        log(`Download ${fileName} completed, but send message failed: ${e.message}`)
      }
    }
    chatData[chat].total++
    log(`Uploaded ${filePath} to ${service}`)
    if (LOG_CHANNEL_ID) {
      const logMsg = await bot
        .forwardMessages(LOG_CHANNEL_ID, {
          messages: msg.id,
          fromPeer: chat,
        })
        .catch(() => null)
      if (logMsg) {
        await bot
          .sendMessage(LOG_CHANNEL_ID, {
            message: `From: \`${chat}\`\nService: ${service}\nResult: \`${result}\``,
            replyTo: logMsg[0].id,
          })
          .catch(() => null)

        // Also send as file/document
        await bot
          .sendFile(LOG_CHANNEL_ID, {
            file: filePath,
            forceDocument: true,
            replyTo: logMsg[0].id,
          })
          .catch(() => null)
      }
    }
  } catch (e) {
    clearTimeout(dlChunkTimeout)
    await bot
      .sendMessage(chat, {
        message: i18n.t(lang, 'error') + `\n\nError info: ${e.message}`,
        replyTo: msg.id,
      })
      .catch(() => {})
    log(`Download ${filePath} failed: ${e.stack}`)
  } finally {
    if (fs.existsSync(filePath)) fs.rmSync(filePath)
    chatData[chat].downloading--
    bot.deleteMessages(chat, [editMsg.id], { revoke: true }).catch(() => null)
    log(`Finished transferring process for ${filePath}`)
  }
}

// Generates a random string with length e
function randomString(e = 8) {
  const t = 'ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678',
    a = t.length
  let n = ''
  for (let i = 0; i < e; i++) n += t.charAt(Math.floor(Math.random() * a))
  return n
}

function secToTime(sec: number) {
  if (!isFinite(sec) || sec < 0) return '00:00:00'
  const hour = Math.floor(sec / 3600)
  const min = Math.floor((sec - hour * 3600) / 60)
  const secs = sec - hour * 3600 - min * 60

  return [
    hour.toString().padStart(2, '0'),
    min.toString().padStart(2, '0'),
    secs.toString().padStart(2, '0'),
  ].join(':')
}

function buildProgressBar(percent: number, length = 20): string {
  const clamped = Math.max(0, Math.min(100, percent))
  const filled = Math.round((clamped / 100) * length)
  return '█'.repeat(filled) + '░'.repeat(length - filled)
}

export async function transferFromURL(msg: Api.Message) {
  if (msg.peerId.className !== 'PeerUser' || !msg.message) return

  const chat = msg.peerId.userId.toJSNumber()
  const lang = chatData[chat].lang

  if (chatData[chat].banned) return bot.sendMessage(chat, { message: i18n.t(lang, 'error_banned') })

  // Extract all URLs from message
  const urlRegex = /https?:\/\/[^\s]+/g
  const urls = msg.message.match(urlRegex) || []

  if (urls.length === 0) return

  const startTime = Date.now()

  // Send initial message
  const statusMsg = await bot.sendMessage(chat, {
    message: `<b>📥 Batch Upload</b>\n\n0/${urls.length} completed\n<code>[${buildProgressBar(0)}]</code> 0%\n⏱ ETA: calculating...`,
    replyTo: msg.id,
    parseMode: 'html',
  })

  let completed = 0
  let failed = 0
  const results: Array<{ index: number; result: string | null }> = []
  const failedUrls: Array<{ index: number; url: string; error: string }> = []
  let lastUpdateTime = 0

  // Concurrency limit: process up to N URLs at once, but stagger start times
  const concurrency = chat === ADMIN_ID ? Math.min(MAX_DOWNLOADING, 4) : Math.min(MAX_DOWNLOADING, 3)
  const staggerDelayMs = 1500 // delay between starting each concurrent download

  // Update progress message helper
  const updateProgress = async (force = false) => {
    const now = Date.now()
    if (!force && now - lastUpdateTime < 3000) return
    lastUpdateTime = now

    const totalProcessed = completed + failed
    const progress = Math.round((totalProcessed / urls.length) * 100)
    const elapsed = (now - startTime) / 1000
    const avgTimePerUrl = totalProcessed > 0 ? elapsed / totalProcessed : 0
    const remaining = urls.length - totalProcessed
    const eta = totalProcessed > 0 ? Math.round(avgTimePerUrl * remaining) : 0

    const activeCount = Math.min(concurrency, urls.length - totalProcessed)

    let text = `<b>📥 Batch Upload</b>\n\n`
    text += `✅ ${completed} | ❌ ${failed} | 📊 ${totalProcessed}/${urls.length}\n`
    text += `<code>[${buildProgressBar(progress)}]</code> ${progress}%\n`
    text += `⏱ ETA: <code>${secToTime(eta)}</code> | ⚡ ${activeCount} active`

    if (failedUrls.length > 0) {
      const failedList = failedUrls
        .sort((a, b) => a.index - b.index)
        .map(f => `${f.index + 1}. <code>${f.url}</code>\n   ⚠️ ${f.error}`)
        .join('\n')
      text += `\n\n<b>❌ Failed:</b>\n${failedList}`
    }

    await bot
      .editMessage(chat, {
        message: statusMsg.id,
        text,
        parseMode: 'html',
        linkPreview: false,
      })
      .catch(() => {})
  }

  // Process with controlled concurrency using a semaphore pattern
  const processUrl = async (url: string, urlIndex: number) => {
    try {
      const result = await transferSingleURL(msg, url, urlIndex + 1, urls.length, statusMsg.id)
      if (result) {
        completed++
        results.push({ index: urlIndex, result })
      } else {
        failed++
        failedUrls.push({ index: urlIndex, url, error: 'Failed to process (file too big or empty)' })
      }
    } catch (error) {
      failed++
      failedUrls.push({ index: urlIndex, url, error: error.message || 'Unknown error' })
    }
    await updateProgress()
  }

  // Semaphore-based concurrency control with staggered starts
  let activeCount = 0
  let nextIndex = 0
  const allDone = new Promise<void>(resolve => {
    const tryStartNext = () => {
      while (activeCount < concurrency && nextIndex < urls.length) {
        const idx = nextIndex++
        activeCount++
        // Stagger start: add delay based on position within the concurrent batch
        const staggerDelay = (activeCount - 1) * staggerDelayMs
        setTimeout(() => {
          processUrl(urls[idx], idx).finally(() => {
            activeCount--
            if (completed + failed === urls.length) {
              resolve()
            } else {
              tryStartNext()
            }
          })
        }, staggerDelay)
      }
    }
    tryStartNext()
  })

  // Periodic progress update while processing
  const progressInterval = setInterval(() => {
    updateProgress()
  }, 5000)

  await allDone
  clearInterval(progressInterval)

  // Final update with summary
  const totalElapsed = (Date.now() - startTime) / 1000

  let finalText = `<b>✅ Batch Upload Complete!</b>\n\n`
  finalText += `📊 ${completed}/${urls.length} successful${failed > 0 ? ` | ❌ ${failed} failed` : ''}\n`
  finalText += `⏱ Total time: <code>${secToTime(Math.round(totalElapsed))}</code>\n`

  // Only show failed URLs
  if (failedUrls.length > 0) {
    const failedList = failedUrls
      .sort((a, b) => a.index - b.index)
      .map(f => `${f.index + 1}. <code>${f.url}</code>\n   ⚠️ ${f.error}`)
      .join('\n')
    finalText += `\n<b>❌ Failed:</b>\n${failedList}`
  }

  await bot
    .editMessage(chat, {
      message: statusMsg.id,
      text: finalText,
      parseMode: 'html',
      linkPreview: false,
    })
    .catch(() => {})

  log(`Batch upload for chat ${chat}: ${completed} success, ${failed} failed, ${urls.length} total in ${Math.round(totalElapsed)}s`)
}

async function transferSingleURL(
  msg: Api.Message,
  url: string,
  current: number,
  total: number,
  statusMsgId: number,
): Promise<string | null> {
  if (msg.peerId.className !== 'PeerUser') return null
  const chat = msg.peerId.userId.toJSNumber()
  const service = chatData[chat].service
  let filePath = ''

  chatData[chat].downloading++

  // Check URL Cache first
  const cachedCatboxUrl = getCachedUrl(url)

  if (!fs.existsSync('./cache')) fs.mkdirSync('./cache')

  try {
    // Download file from URL with retry logic and exponential backoff
    let response!: Response
    const maxRetries = 5
    let lastError: Error | null = null

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 60000) // 60s timeout per request

        response = await fetch(url, {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'image/*,video/*,*/*',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive',
          },
          signal: controller.signal,
        })
        clearTimeout(timeout)

        if (!response.ok) {
          if (response.status === 503 || response.status === 429 || response.status === 408) {
            // Rate limited, service unavailable, or timeout — retry with exponential backoff
            const delay = Math.min(2000 * Math.pow(2, attempt - 1), 30000) // 2s, 4s, 8s, 16s, 30s
            log(`[${current}/${total}] HTTP ${response.status} for ${url}, retry ${attempt}/${maxRetries} after ${delay}ms`)
            if (attempt < maxRetries) {
              await new Promise(resolve => setTimeout(resolve, delay))
              continue
            }
          }
          throw new Error(`HTTP ${response.status}: ${response.statusText}`)
        }
        break // success
      } catch (e) {
        lastError = e
        if (attempt < maxRetries) {
          const delay = Math.min(2000 * Math.pow(2, attempt - 1), 30000)
          log(`[${current}/${total}] Fetch error for ${url}: ${e.message}, retry ${attempt}/${maxRetries} after ${delay}ms`)
          await new Promise(resolve => setTimeout(resolve, delay))
        } else {
          throw lastError
        }
      }
    }

    // Get file size from Content-Length header
    const contentLength = response.headers.get('content-length')
    const fileSize = contentLength ? parseInt(contentLength) : 0

    // Check file size limits
    if (fileSize > 0) {
      if (
        (service === 'Catbox' && fileSize > 200000000) ||
        (service === 'Litterbox' && fileSize > 1000000000)
      ) {
        log(`[${current}/${total}] File too big: ${url} (${fileSize} bytes)`)
        // Log to channel even for oversized files
        if (LOG_CHANNEL_ID) {
          await sendFailedToLogChannel(chat, current, url, service, `File too big (${(fileSize / 1000000).toFixed(2)} MB)`)
        }
        return null
      }
    }

    // Try to get original filename from URL
    const urlPath = new URL(url).pathname
    let originalName = urlPath.split('/').pop()

    // If it lacks an extension, fallback to Content-Type extension
    if (!originalName || !originalName.includes('.')) {
      const contentType = response.headers.get('content-type')
      let ext = 'bin'
      if (contentType) {
        const foundExt = mime.extension(contentType)
        if (foundExt) ext = foundExt
      }
      originalName = originalName ? `${originalName}.${ext}` : `${randomString()}.${ext}`
    } else {
      try {
        originalName = decodeURIComponent(originalName)
      } catch (e) {
        // Ignored if decode fails
      }
    }

    const uniqueDir = `./cache/${chat}_${randomString()}`
    fs.mkdirSync(uniqueDir, { recursive: true })
    filePath = `${uniqueDir}/${originalName}`

    log(`[${current}/${total}] Start downloading from URL: ${url} to ${filePath}...`)

    // Download file with streaming
    const reader = response.body?.getReader()
    if (!reader) throw new Error('Failed to get response body reader')

    const fileStream = fs.createWriteStream(filePath)

    let downloadedBytes = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      fileStream.write(value)
      downloadedBytes += value.length
    }

    fileStream.end()
    await new Promise<void>((resolve, reject) => {
      fileStream.on('finish', () => resolve())
      fileStream.on('error', reject)
    })

    const finalFileSize = fs.statSync(filePath).size
    log(`[${current}/${total}] Downloaded from URL: ${filePath} (Size ${finalFileSize})`)

    // Check final file size
    if (
      (service === 'Catbox' && finalFileSize > 200000000) ||
      (service === 'Litterbox' && finalFileSize > 1000000000)
    ) {
      log(`[${current}/${total}] Final file too big: ${filePath} (${finalFileSize} bytes)`)
      if (LOG_CHANNEL_ID) {
        await sendFailedToLogChannel(chat, current, url, service, `File too big (${(finalFileSize / 1000000).toFixed(2)} MB)`)
      }
      return null
    }

    // Upload to Catbox / Litterbox with retry and animated progress
    let result!: string
    let isCached = false

    if (cachedCatboxUrl) {
      log(`[${current}/${total}] URL already uploaded, skipping Catbox: ${url} -> ${cachedCatboxUrl}`)
      result = cachedCatboxUrl
      isCached = true
    } else {
      let uploadRetries = 3
      let uploadFrame = 0
      const uploadInterval = setInterval(async () => {
        uploadFrame++
        const animPos = uploadFrame % 20
        const bar = '░'.repeat(animPos) + '█' + '░'.repeat(19 - animPos)
        const dots = '.'.repeat((uploadFrame % 3) + 1)

        await bot
          .editMessage(chat, {
            message: statusMsgId,
            text: `<b>📥 Batch Upload</b>\n\n` +
              `<b>📤 Uploading ${current}/${total} to ${service}${dots}</b>\n` +
              `📁 Size: ${(finalFileSize / 1000 / 1000).toFixed(2)} MB\n` +
              `<code>[${bar}]</code>`,
            parseMode: 'html',
            linkPreview: false,
          })
          .catch(() => {})
      }, 2000)

      try {
        while (uploadRetries > 0) {
          try {
            if (service.toLowerCase() === 'catbox') {
              const client = new Catbox(chatData[chat].token || CATBOX_TOKEN || '')
              result = await client.uploadFile({ path: filePath })
            } else {
              const lbe = chatData[chat].lbe
              const client = new Litterbox()
              result = await client.upload({
                path: filePath,
                duration: `${lbe}h` as any,
              })
            }
            break
          } catch (e) {
            uploadRetries--
            if (uploadRetries > 0) {
              log(`[${current}/${total}] Upload failed, retrying... (${e.message})`)
              await new Promise(resolve => setTimeout(resolve, 3000))
            } else {
              throw new Error(`Upload failed after retries: ${e.message}`)
            }
          }
        }
      } finally {
        clearInterval(uploadInterval)
      }
    }

    const resultLine = `<code>${current}.</code> <a href="${result}">${(finalFileSize / 1000 / 1000).toFixed(2)} MB${isCached ? ' (Cached)' : ''}</a> (<a href="${url}">src</a>)`

    chatData[chat].total++
    log(`[${current}/${total}] Processed ${filePath} from URL for ${service}: ${result}`)

    // Save to cache for deduplication
    if (!isCached) setCachedUrl(url, result)

    // Queue log channel message to maintain order
    if (LOG_CHANNEL_ID) {
      await sendToLogChannel(chat, {
        index: current,
        filePath,
        url,
        service,
        result,
      })
    }

    // Clean up file after sending to log
    if (filePath && fs.existsSync(filePath)) {
      fs.rmSync(filePath)
      const dir = filePath.substring(0, filePath.lastIndexOf('/'))
      if (dir && dir !== './cache' && fs.existsSync(dir)) {
        try { fs.rmdirSync(dir) } catch (_) {}
      }
    }

    return resultLine
  } catch (e) {
    log(`[${current}/${total}] Download from URL ${url} failed: ${e.stack}`)

    // Log failed downloads to the log channel too
    if (LOG_CHANNEL_ID) {
      await sendFailedToLogChannel(chat, current, url, service, e.message || 'Unknown error')
    }

    throw e
  } finally {
    // Clean up file on error
    if (filePath && fs.existsSync(filePath)) {
      try { fs.rmSync(filePath) } catch (_) {}
      const dir = filePath.substring(0, filePath.lastIndexOf('/'))
      if (dir && dir !== './cache' && fs.existsSync(dir)) {
        try { fs.rmdirSync(dir) } catch (_) {}
      }
    }
    chatData[chat].downloading--
    log(`[${current}/${total}] Finished transferring process from URL`)
  }
}

// Send failed download info to log channel
async function sendFailedToLogChannel(chat: number, index: number, url: string, service: string, error: string) {
  if (!LOG_CHANNEL_ID) return
  try {
    await bot
      .sendMessage(LOG_CHANNEL_ID, {
        message: `❌ <b>Failed Upload</b>\nFrom: <code>${chat}</code>\nURL: <code>${url}</code>\nService: ${service}\nError: <code>${error}</code>\nIndex: ${index}`,
        parseMode: 'html',
      })
      .catch(() => null)
    // Add delay to avoid flood
    await new Promise(resolve => setTimeout(resolve, 1500))
  } catch (e) {
    log(`Failed to send error log to channel: ${e.message}`)
  }
}
