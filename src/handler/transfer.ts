import * as fs from 'fs'
import i18n from '../i18n/index.js'
import mime from 'mime-types'
import bigInt from 'big-integer'
import sharp from 'sharp'

// Disable sharp's internal cache to prevent memory buildup during batch processing
sharp.cache(false)
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
  MAX_CACHE_MB,
} from '../env.js'
import type { Api } from 'telegram'

// ─── Global Flood Gate ───────────────────────────────────────────────────────
// When ANY Telegram API call triggers a FloodWaitError, ALL outgoing calls
// must pause until the flood penalty expires. This prevents cascading penalties
// that escalate to 7600s+ bans.
let floodPauseUntil = 0

/**
 * Extract flood wait seconds from various error formats.
 * Returns the wait duration in seconds, or null if not a flood error.
 */
export function getFloodWaitSeconds(e: any): number | null {
  if (!e) return null
  // gramjs FloodWaitError has .seconds
  if (e.seconds && (e.errorMessage === 'FLOOD' || e.name === 'FloodWaitError')) {
    return e.seconds
  }
  // Check error message for flood mentions
  if (typeof e.message === 'string') {
    if (e.message.includes('Flood')) {
      // Try to extract seconds from message like "Sleeping for 30s on flood wait"
      const match = e.message.match(/(\d+)s?\s*(?:on\s+)?flood/i) ||
        e.message.match(/flood.*?(\d+)/i)
      return match ? parseInt(match[1]) : 30 // default 30s if we can't parse
    }
  }
  if (e.errorMessage === 'FLOOD') return e.seconds || 30
  return null
}

/**
 * Set a global flood pause. ALL API calls will wait until this expires.
 */
export function setFloodPause(seconds: number) {
  const pauseUntil = Date.now() + (seconds * 1000) + 2000 // extra 2s safety buffer
  if (pauseUntil > floodPauseUntil) {
    floodPauseUntil = pauseUntil
    log(`[FloodGate] ⚠️ Flood detected! Pausing ALL API calls for ${seconds + 2}s`)
  }
}

/**
 * Wait until the global flood gate allows API calls.
 * Must be called before every Telegram API call.
 */
export async function waitForFloodGate(): Promise<void> {
  const now = Date.now()
  if (floodPauseUntil > now) {
    const waitMs = floodPauseUntil - now
    log(`[FloodGate] Waiting ${Math.ceil(waitMs / 1000)}s before next API call...`)
    await new Promise(resolve => setTimeout(resolve, waitMs))
  }
}

/**
 * Check if we are currently in a flood pause.
 */
export function isFloodPaused(): boolean {
  return Date.now() < floodPauseUntil
}

// Queue for ordered log channel messages
interface LogQueueItem {
  chat: number
  index: number
  url: string
  service: string
  result: string | null
  filePath: string
  imageMsg: Api.Message | null
  resolve: () => void
  cleanupFilePath?: string // File path to delete after log is sent (for parallel mode)
  cleanupDir?: string // Directory to remove after file cleanup
  isBatch?: boolean // True if part of a batch operation (URL list), false for single file uploads
}

const logQueue: LogQueueItem[] = []
let globalLogProcessing = false

export function getLogQueueStatus(chat: number): { pending: number; processing: boolean } {
  const pending = logQueue.filter(item => item.chat === chat).length
  return { pending, processing: globalLogProcessing }
}

// Create a compressed preview for large images
async function createCompressedPreview(filePath: string, maxSize = 1280): Promise<string | null> {
  try {
    const previewPath = filePath.replace(/\.(jpg|jpeg|png|webp)$/i, '_preview.jpg')

    // First attempt: 1280px, Quality 65, sRGB
    await sharp(filePath)
      .resize(maxSize, maxSize, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .withMetadata({ density: 72 }) // keep basic metadata
      .toColorspace('srgb') // enforce sRGB color profile
      .jpeg({
        quality: 65,
        progressive: false,
        mozjpeg: true, // Use mozjpeg for better compression
      })
      .toFile(previewPath)

    let previewSize = fs.statSync(previewPath).size

    // If preview is still > 1MB (1048576 bytes), forcibly reduce quality and resolution
    // The user requested 300KB - 1MB
    let currentQuality = 65
    let currentSize = maxSize

    while (previewSize > 1000000 && currentQuality > 20) {
      currentQuality -= 15
      currentSize = Math.floor(currentSize * 0.8) // Reduce resolution slightly too

      log(
        `[Log] Preview size ${(previewSize / 1000 / 1000).toFixed(2)} MB is > 1MB. Retrying with size ${currentSize}px, quality ${currentQuality}...`,
      )

      await sharp(filePath)
        .resize(currentSize, currentSize, {
          fit: 'inside',
          withoutEnlargement: true,
        })
        .toColorspace('srgb')
        .jpeg({
          quality: currentQuality,
          progressive: false,
          mozjpeg: true,
        })
        .toFile(previewPath)

      previewSize = fs.statSync(previewPath).size
    }

    log(`[Log] Created preview: ${(previewSize / 1000 / 1000).toFixed(2)} MB`)

    return previewPath
  } catch (e) {
    log(`[Log] Failed to create preview: ${e.message}`)
    return null
  }
}

async function sendToLogChannel(chat: number, item: Omit<LogQueueItem, 'chat'>) {
  if (!LOG_CHANNEL_ID) {
    item.resolve() // Resolve immediately if no log channel
    return
  }

  log(`[Log] Adding to queue: ${item.url} (index ${item.index}) for chat ${chat}`)

  // Add to global queue
  logQueue.push({ chat, ...item })

  // Sort by chat and index to maintain local order but process whatever is ready
  logQueue.sort((a, b) => {
    if (a.chat !== b.chat) return 0
    return a.index - b.index
  })

  log(`[Log] Global Queue size: ${logQueue.length}`)

  // Start processing loop if not already running
  if (!globalLogProcessing) {
    globalLogProcessing = true
    log(`[Log] Starting global log queue processor`)
    // Process queue in background
    processLogQueue().catch(e => log(`Log queue error: ${e.message}`))
  }
}

async function processLogQueue() {
  log(`[Log] Processing global log queue, length: ${logQueue.length}`)

  while (logQueue.length > 0) {
    // Ensure sorted continuously
    logQueue.sort((a, b) => {
      if (a.chat !== b.chat) return 0
      return a.index - b.index
    })

    const item = logQueue[0]
    const chat = item.chat

    // Check if batch was cancelled
    const progressState = chatData[chat]?.batchProgress
    if (progressState?.isCancelled) {
      log(`[Log] Batch cancelled, removing item for chat ${chat}`)
      logQueue.shift()
      item.resolve()
      if (item.cleanupFilePath && fs.existsSync(item.cleanupFilePath)) {
        try { fs.rmSync(item.cleanupFilePath) } catch (_) { }
        if (item.cleanupDir && item.cleanupDir !== './cache' && fs.existsSync(item.cleanupDir)) {
          try { fs.rmdirSync(item.cleanupDir) } catch (_) { }
        }
      }
      continue
    }

    log(`[Log] Processing item: ${item.url} (index ${item.index}) for chat ${chat}`)

    if (!item.url.startsWith('tg-file-') && item.filePath && !fs.existsSync(item.filePath)) {
      log(`[Log] File no longer exists, skipping: ${item.filePath}`)
      logQueue.shift()
      item.resolve()
      continue
    }

    // ── Wait for any active flood pause before processing this item ──
    await waitForFloodGate()

    try {
      if (item.url.startsWith('tg-file-') && item.imageMsg) {
        // Direct media upload: forward the original message
        let fwdMsg: Api.Message | null = null
        await waitForFloodGate()
        const fwdResult = await bot
          .forwardMessages(LOG_CHANNEL_ID, {
            messages: item.imageMsg.id,
            fromPeer: chat,
          })
          .catch((e) => {
            const floodSec = getFloodWaitSeconds(e)
            if (floodSec) setFloodPause(floodSec)
            return null
          })
        if (fwdResult && fwdResult.length > 0) {
          fwdMsg = fwdResult[0] as Api.Message
        }

        if (fwdMsg) {
          await waitForFloodGate()
          await new Promise(resolve => setTimeout(resolve, 1500))
          await bot
            .sendMessage(LOG_CHANNEL_ID, {
              message: `Service: ${item.service}\nResult: \`${item.result}\``,
              replyTo: fwdMsg.id,
            })
            .catch((e) => {
              const floodSec = getFloodWaitSeconds(e)
              if (floodSec) setFloodPause(floodSec)
            })

          if (item.filePath && fs.existsSync(item.filePath)) {
            await waitForFloodGate()
            await new Promise(resolve => setTimeout(resolve, 1000))
            await bot
              .sendFile(LOG_CHANNEL_ID, {
                file: item.filePath,
                forceDocument: true,
                replyTo: fwdMsg.id,
              })
              .catch((e) => {
                const floodSec = getFloodWaitSeconds(e)
                if (floodSec) setFloodPause(floodSec)
              })
          }
        }
      } else {
        // URL upload: we have the downloaded file locally
        let captionStr = `Source: \`${item.url}\`\nService: ${item.service}\nResult: \`${item.result}\``

        log(
          `[Log] Sending URL upload to log channel: ${item.url}, file exists: ${item.filePath && fs.existsSync(item.filePath)}`,
        )

        if (item.filePath && fs.existsSync(item.filePath)) {
          const fileSize = fs.statSync(item.filePath).size
          const fileSizeMB = (fileSize / 1000 / 1000).toFixed(2)

          try {
            const uploadTimeout = fileSize > 10000000 ? 120000 : 60000
            let previewPath: string | null = null
            let imageMsg: Api.Message | null = null

            if (/\.(jpg|jpeg|png|webp)$/i.test(item.filePath)) {
              log(`[Log] Creating compressed preview...`)
              previewPath = await createCompressedPreview(item.filePath)
            }

            const fileToSend = previewPath || item.filePath
            let uploadRetries = 3
            let retryDelay = 2000

            while (uploadRetries > 0 && !imageMsg) {
              await waitForFloodGate()
              imageMsg = (await Promise.race([
                bot.sendFile(LOG_CHANNEL_ID, {
                  file: fileToSend,
                  caption: captionStr,
                  forceDocument: false,
                  attributes: [],
                }),
                new Promise((_, reject) =>
                  setTimeout(() => reject(new Error('Upload timeout')), uploadTimeout),
                ),
              ]).catch(e => {
                log(`[Log] Failed to send compressed photo: ${e.message}`)
                const floodSec = getFloodWaitSeconds(e)
                if (floodSec) {
                  setFloodPause(floodSec)
                  return null
                }
                if (
                  e.message.includes('AUTH_KEY_DUPLICATED') ||
                  e.message.includes('timeout') ||
                  e.message.includes('ECONNRESET') ||
                  e.message.includes('RPC_CALL_FAIL')
                ) {
                  return null
                }
                uploadRetries = 0
                return null
              })) as Api.Message | null

              if (!imageMsg && uploadRetries > 0) {
                uploadRetries--
                if (uploadRetries > 0) {
                  log(`[Log] Retrying photo upload... (${uploadRetries} left)`)
                  await new Promise(resolve => setTimeout(resolve, retryDelay))
                  retryDelay *= 2
                }
              }
            }

            if (!imageMsg && previewPath) {
              log(`[Log] Creating smaller preview (1024px)...`)
              if (fs.existsSync(previewPath)) fs.rmSync(previewPath)
              previewPath = await createCompressedPreview(item.filePath, 1024)

              if (previewPath) {
                uploadRetries = 3
                retryDelay = 2000
                while (uploadRetries > 0 && !imageMsg) {
                  await waitForFloodGate()
                  imageMsg = (await Promise.race([
                    bot.sendFile(LOG_CHANNEL_ID, {
                      file: previewPath,
                      caption: captionStr,
                      forceDocument: false,
                      attributes: [],
                    }),
                    new Promise((_, reject) =>
                      setTimeout(() => reject(new Error('Upload timeout')), uploadTimeout),
                    ),
                  ]).catch(e => {
                    log(`[Log] Failed to send smaller preview: ${e.message}`)
                    const floodSec = getFloodWaitSeconds(e)
                    if (floodSec) {
                      setFloodPause(floodSec)
                      return null
                    }
                    if (
                      e.message.includes('AUTH_KEY_DUPLICATED') ||
                      e.message.includes('timeout') ||
                      e.message.includes('ECONNRESET') ||
                      e.message.includes('RPC_CALL_FAIL')
                    ) {
                      return null
                    }
                    uploadRetries = 0
                    return null
                  })) as Api.Message | null

                  if (!imageMsg && uploadRetries > 0) {
                    uploadRetries--
                    if (uploadRetries > 0) {
                      log(`[Log] Retrying smaller preview upload... (${uploadRetries} left)`)
                      await new Promise(resolve => setTimeout(resolve, retryDelay))
                      retryDelay *= 2
                    }
                  }
                }
              }
            }

            if (!imageMsg) {
              log(`[Log] Sending as document (fallback)...`)
              uploadRetries = 3
              retryDelay = 2000
              while (uploadRetries > 0 && !imageMsg) {
                await waitForFloodGate()
                imageMsg = (await Promise.race([
                  bot.sendFile(LOG_CHANNEL_ID, {
                    file: fileToSend,
                    caption: captionStr,
                    forceDocument: true,
                    attributes: [],
                  }),
                  new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('Upload timeout')), uploadTimeout),
                  ),
                ]).catch(e => {
                  log(`[Log] Failed to send as document: ${e.message}`)
                  const floodSec = getFloodWaitSeconds(e)
                  if (floodSec) {
                    setFloodPause(floodSec)
                    return null
                  }
                  if (
                    e.message.includes('AUTH_KEY_DUPLICATED') ||
                    e.message.includes('timeout') ||
                    e.message.includes('ECONNRESET') ||
                    e.message.includes('RPC_CALL_FAIL')
                  ) {
                    return null
                  }
                  uploadRetries = 0
                  return null
                })) as Api.Message | null

                if (!imageMsg && uploadRetries > 0) {
                  uploadRetries--
                  if (uploadRetries > 0) {
                    log(`[Log] Retrying document fallback upload... (${uploadRetries} left)`)
                    await new Promise(resolve => setTimeout(resolve, retryDelay))
                    retryDelay *= 2
                  }
                }
              }
            }

            if (imageMsg) {
              // Delay between preview and document to avoid flood wait (messages.SendMedia limit is ~20/min)
              await new Promise(resolve => setTimeout(resolve, 3000))
              let docFilePath = item.filePath
              let renamedPath: string | null = null
              if (item.result && item.result !== 'Skipped') {
                try {
                  const catboxFilename = new URL(item.result).pathname.split('/').pop()
                  if (catboxFilename) {
                    const dir = item.filePath.substring(0, item.filePath.lastIndexOf('/'))
                    renamedPath = `${dir}/${catboxFilename}`
                    if (renamedPath !== item.filePath) {
                      fs.copyFileSync(item.filePath, renamedPath)
                      docFilePath = renamedPath
                    } else {
                      renamedPath = null
                    }
                  }
                } catch (_) { }
              }
              let docRetries = 3
              let docRetryDelay = 2000
              let docSent = false

              while (docRetries > 0 && !docSent) {
                await waitForFloodGate()
                await Promise.race([
                  bot.sendFile(LOG_CHANNEL_ID, {
                    file: docFilePath,
                    forceDocument: true,
                    replyTo: imageMsg.id,
                  }),
                  new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('Upload timeout')), uploadTimeout),
                  ),
                ]).then(() => {
                  docSent = true
                }).catch(async e => {
                  log(`[Log] Failed to send raw document: ${e.message}`)
                  const floodSec = getFloodWaitSeconds(e)
                  if (floodSec) {
                    setFloodPause(floodSec)
                    docRetries--
                  } else if (
                    e.message.includes('AUTH_KEY_DUPLICATED') ||
                    e.message.includes('timeout') ||
                    e.message.includes('ECONNRESET') ||
                    e.message.includes('RPC_CALL_FAIL')
                  ) {
                    docRetries--
                    if (docRetries > 0) {
                      await new Promise(resolve => setTimeout(resolve, docRetryDelay))
                      docRetryDelay *= 2
                    }
                  } else {
                    docRetries = 0
                  }
                })
              }
              if (renamedPath && renamedPath !== item.filePath && fs.existsSync(renamedPath)) {
                try { fs.rmSync(renamedPath) } catch (_) { }
              }
            } else {
              log(`[Log] File upload failed, sending caption only`)
              await waitForFloodGate()
              await bot
                .sendMessage(LOG_CHANNEL_ID, {
                  message: captionStr + `\n\n⚠️ File upload failed (${fileSizeMB} MB)`,
                })
                .catch((e) => {
                  const floodSec = getFloodWaitSeconds(e)
                  if (floodSec) setFloodPause(floodSec)
                })
            }

            if (previewPath && fs.existsSync(previewPath)) {
              fs.rmSync(previewPath)
            }
          } catch (e) {
            log(`[Log] Error uploading to log channel: ${e.message}`)
            const floodSec = getFloodWaitSeconds(e)
            if (floodSec) setFloodPause(floodSec)
            if (!floodSec) {
              await waitForFloodGate()
              await bot
                .sendMessage(LOG_CHANNEL_ID, {
                  message: captionStr + `\n\n⚠️ File upload error: ${e.message}`,
                })
                .catch(() => null)
            }
          }
        } else {
          await waitForFloodGate()
          await bot.sendMessage(LOG_CHANNEL_ID, { message: captionStr }).catch((e) => {
            const floodSec = getFloodWaitSeconds(e)
            if (floodSec) setFloodPause(floodSec)
          })
        }
      }

      log(`[Log] Successfully sent to log channel: ${item.url}`)

      // Delay between log items (flood gate handles emergencies, this spacing prevents Telegram limits)
      // We wait 4500ms to stay well under the ~20 messages/minute group send limit
      await new Promise(resolve => setTimeout(resolve, 4500))
    } catch (e) {
      log(`Failed to send to log channel: ${e.message || e}`)
      const floodSec = getFloodWaitSeconds(e)
      if (floodSec) setFloodPause(floodSec)
      if (!floodSec) {
        try {
          await waitForFloodGate()
          await bot
            .sendMessage(LOG_CHANNEL_ID, {
              message: `Source: \`${item.url}\`\nService: ${item.service}\nResult: \`${item.result}\`\n\n⚠️ Error: ${e.message || e}`,
            })
            .catch(() => null)
        } catch (_) { }
      }
    }

    logQueue.shift()
    item.resolve()

    if (item.cleanupFilePath && fs.existsSync(item.cleanupFilePath)) {
      try {
        fs.rmSync(item.cleanupFilePath)
        log(`[Log] Cleaned up file: ${item.cleanupFilePath}`)
      } catch (_) { }
      if (item.cleanupDir && item.cleanupDir !== './cache' && fs.existsSync(item.cleanupDir)) {
        try { fs.rmdirSync(item.cleanupDir) } catch (_) { }
      }
    }

    log(`[Log] Removed from queue: ${item.url}, remaining: ${logQueue.length}`)
  }

  globalLogProcessing = false
  log(`[Log] Global Queue processor stopped`)
}



// Check if cache directory usage exceeds the limit
function getCacheSizeMB(): number {
  if (!fs.existsSync('./cache')) return 0
  let totalBytes = 0
  const items = fs.readdirSync('./cache')
  for (const item of items) {
    const itemPath = `./cache/${item}`
    const stat = fs.statSync(itemPath)
    if (stat.isFile()) {
      totalBytes += stat.size
    } else if (stat.isDirectory()) {
      // Sum files inside subdirectory
      try {
        const subItems = fs.readdirSync(itemPath)
        for (const subItem of subItems) {
          const subPath = `${itemPath}/${subItem}`
          try {
            totalBytes += fs.statSync(subPath).size
          } catch (_) { }
        }
      } catch (_) { }
    }
  }
  return totalBytes / (1024 * 1024)
}

/**
 * Evict the oldest files from the cache directory until usage drops below the limit.
 * Returns the number of files deleted.
 */
function evictOldestCacheFiles(targetMB: number): number {
  if (!fs.existsSync('./cache')) return 0

  // Collect all files with their paths, sizes, and modification times
  const files: { path: string; size: number; mtime: number }[] = []
  const items = fs.readdirSync('./cache')

  for (const item of items) {
    const itemPath = `./cache/${item}`
    try {
      const stat = fs.statSync(itemPath)
      if (stat.isFile()) {
        files.push({ path: itemPath, size: stat.size, mtime: stat.mtimeMs })
      } else if (stat.isDirectory()) {
        // Collect files inside subdirectories too
        try {
          const subItems = fs.readdirSync(itemPath)
          for (const subItem of subItems) {
            const subPath = `${itemPath}/${subItem}`
            try {
              const subStat = fs.statSync(subPath)
              if (subStat.isFile()) {
                files.push({ path: subPath, size: subStat.size, mtime: subStat.mtimeMs })
              }
            } catch (_) { }
          }
        } catch (_) { }
      }
    } catch (_) { }
  }

  // Sort oldest first
  files.sort((a, b) => a.mtime - b.mtime)

  let currentBytes = files.reduce((sum, f) => sum + f.size, 0)
  const targetBytes = targetMB * 1024 * 1024
  let deleted = 0
  const now = Date.now()
  const SAFE_AGE_MS = 2 * 60 * 60 * 1000 // 2 hours — files newer than this are likely in active use

  for (const file of files) {
    if (currentBytes <= targetBytes) break
    // Skip files that were modified recently — they're likely being actively downloaded/uploaded
    if (now - file.mtime < SAFE_AGE_MS) {
      log(`[Cache] Skipping active file: ${file.path} (modified ${Math.round((now - file.mtime) / 1000)}s ago)`)
      continue
    }
    try {
      fs.rmSync(file.path)
      currentBytes -= file.size
      deleted++
      log(`[Cache] Evicted old file: ${file.path} (${(file.size / 1024 / 1024).toFixed(1)}MB)`)
    } catch (_) { }
  }

  // Clean up empty subdirectories
  if (deleted > 0) {
    try {
      for (const item of fs.readdirSync('./cache')) {
        const itemPath = `./cache/${item}`
        try {
          const stat = fs.statSync(itemPath)
          if (stat.isDirectory()) {
            const contents = fs.readdirSync(itemPath)
            if (contents.length === 0) {
              fs.rmdirSync(itemPath)
            }
          }
        } catch (_) { }
      }
    } catch (_) { }
  }

  return deleted
}

async function waitForCacheSpace(): Promise<void> {
  const maxMB = MAX_CACHE_MB
  let currentMB = getCacheSizeMB()

  if (currentMB <= maxMB) return

  // Actively evict oldest files first
  log(`[Cache] Usage ${currentMB.toFixed(0)}MB exceeds limit ${maxMB}MB, evicting old files...`)
  const evicted = evictOldestCacheFiles(maxMB)
  currentMB = getCacheSizeMB()

  if (evicted > 0) {
    log(`[Cache] Evicted ${evicted} file(s), usage now ${currentMB.toFixed(0)}MB`)
  }

  // If still over limit after eviction, wait briefly (something is actively downloading)
  // but with a hard timeout to prevent infinite loops
  const maxWaitMs = 120_000 // 2 minutes max wait
  const startTime = Date.now()

  while (currentMB > maxMB) {
    if (Date.now() - startTime > maxWaitMs) {
      log(`[Cache] ⚠️ Cache still at ${currentMB.toFixed(0)}MB after ${maxWaitMs / 1000}s, force-evicting...`)
      evictOldestCacheFiles(Math.floor(maxMB * 0.7)) // Evict down to 70% capacity
      currentMB = getCacheSizeMB()
      break
    }
    log(`[Cache] Usage ${currentMB.toFixed(0)}MB exceeds limit ${maxMB}MB, waiting for active transfers...`)
    await new Promise(resolve => setTimeout(resolve, 5000))
    currentMB = getCacheSizeMB()
  }
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
    !chatData[chat].skipCatbox &&
    ((service === 'Catbox' && fileSize > 200000000) ||
      (service === 'Litterbox' && fileSize > 1000000000))
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
      // Update the progress message every 5 seconds
      if (downloadedBytes && now - lastEditTime > 4000) {
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
          .catch(() => { })
      }
    }

    log(`Downloaded: ${filePath} (Size ${fileSize})`)

    // Upload to Catbox / Litterbox
    let result: string = 'Skipped'
    let validity: string = 'N/A'

    if (chatData[chat].skipCatbox) {
      // Skip catbox upload — just update status
      await bot.editMessage(chat, {
        message: editMsg.id,
        text: `<b>📤 Sending to log channel...</b>\n\n📁 Size: ${(fileSize / 1000 / 1000).toFixed(2)} MB`,
        parseMode: 'html',
      }).catch(() => { })
    } else {
      // Animated upload progress indicator (every 3s, skipped during flood pause)
      let uploadFrame = 0
      const uploadInterval = setInterval(() => {
        if (isFloodPaused()) return // Skip animation during flood pause
        uploadFrame++
        const animPos = uploadFrame % 20
        const bar = '░'.repeat(animPos) + '█' + '░'.repeat(19 - animPos)
        const dots = '.'.repeat((uploadFrame % 3) + 1)
        bot
          .editMessage(chat, {
            message: editMsg.id,
            text:
              `<b>📤 Uploading to ${service}${dots}</b>\n\n` +
              `📁 Size: ${(fileSize / 1000 / 1000).toFixed(2)} MB\n` +
              `<code>[${bar}]</code>`,
            parseMode: 'html',
          })
          .catch(() => { })
      }, 3000)

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
    }
    const text = chatData[chat].skipCatbox ?
      `<b>✅ Downloaded successfully!</b>\n\n📁 Size: ${(fileSize / 1000 / 1000).toFixed(2)} MB\n⚠️ Catbox uploading was skipped.` :
      i18n.t(lang, 'uploaded', [
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
      // For direct file transfers, we don't have a URL, so we use a placeholder.
      // The index is used for ordering in the log queue.
      let resolveLogPromise: () => void
      const logPromise = new Promise<void>(resolve => {
        resolveLogPromise = resolve
      })

      await sendToLogChannel(chat, {
        index: msg.id, // Use message ID as index for ordering
        url: `tg-file-${msg.id}`, // Unique identifier for dedup
        service,
        result,
        filePath,
        imageMsg: msg,
        resolve: resolveLogPromise!,
      })
      await logPromise // Wait for this specific log item to be processed
    }
  } catch (e) {
    clearTimeout(dlChunkTimeout)
    await bot
      .sendMessage(chat, {
        message: i18n.t(lang, 'error') + `\n\nError info: ${e.message}`,
        replyTo: msg.id,
      })
      .catch(() => { })
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

export async function transferFromURL(msg: Api.Message) {
  // This function is deprecated - use /dl command instead
  return
}

export async function transferSingleURL(
  msg: Api.Message,
  url: string,
  logIndex: number, // Sequential index for log ordering across batches
  totalInBatch: number,
  statusMsgId: number,
  abortSignal?: AbortSignal,
): Promise<string | null> {
  if (msg.peerId.className !== 'PeerUser') return null
  const chat = msg.peerId.userId.toJSNumber()
  const service = chatData[chat].service
  let filePath = ''

  chatData[chat].downloading++

  // Check URL Cache first
  const cachedCatboxUrl = getCachedUrl(url)

  if (!fs.existsSync('./cache')) fs.mkdirSync('./cache')

  // Wait if cache disk usage is too high
  await waitForCacheSpace()

  try {
    // Download file from URL with retry logic and exponential backoff
    let response!: Response
    const maxRetries = 5
    let lastError: Error | null = null

    // Ensure bot is connected before starting
    if (!bot.connected) {
      log(`[${logIndex}] Bot disconnected, reconnecting...`)
      await bot.connect()
    }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Check if already cancelled before starting
        if (abortSignal?.aborted) {
          throw new Error('Cancelled')
        }

        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 30000) // 30s timeout per request

        // If the parent abort signal fires, abort this fetch too
        const onAbort = () => controller.abort()
        abortSignal?.addEventListener('abort', onAbort, { once: true })

        // Extract domain for Referer header
        const urlObj = new URL(url)
        const referer = `${urlObj.protocol}//${urlObj.host}/`

        response = await fetch(url, {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            Accept: 'image/*,video/*,*/*',
            'Accept-Encoding': 'gzip, deflate, br',
            'Accept-Language': 'en-US,en;q=0.9',
            Connection: 'keep-alive',
            Referer: referer,
            Origin: `${urlObj.protocol}//${urlObj.host}`,
            'Sec-Fetch-Dest': 'image',
            'Sec-Fetch-Mode': 'no-cors',
            'Sec-Fetch-Site': 'same-origin',
            'Cache-Control': 'no-cache',
            Pragma: 'no-cache',
          },
          signal: controller.signal,
        })
        clearTimeout(timeout)
        abortSignal?.removeEventListener('abort', onAbort)

        if (!response.ok) {
          if (response.status === 503 || response.status === 429 || response.status === 408) {
            // Rate limited, service unavailable, or timeout — retry with exponential backoff
            const delay = Math.min(2000 * Math.pow(2, attempt - 1), 15000) // 2s, 4s, 8s, 15s
            log(
              `[${logIndex}] HTTP ${response.status} for ${url}, retry ${attempt}/${maxRetries} after ${delay}ms`,
            )
            if (attempt < maxRetries) {
              await new Promise(resolve => setTimeout(resolve, delay))
              continue
            }
          } else if (response.status === 403) {
            // Forbidden - retry with exponential backoff (might be rate limiting)
            const delay = Math.min(2000 * Math.pow(2, attempt - 1), 30000)
            log(
              `[${logIndex}] HTTP 403 Forbidden for ${url}, retry ${attempt}/${maxRetries} after ${delay}ms`,
            )
            if (attempt < maxRetries) {
              await new Promise(resolve => setTimeout(resolve, delay))
              continue
            }
          }
          lastError = new Error(`HTTP ${response.status}: ${response.statusText}`)
          throw lastError
        }
        break // success
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e))
        if (attempt < maxRetries) {
          const delay = Math.min(2000 * Math.pow(2, attempt - 1), 15000)
          log(
            `[${logIndex}] Fetch error for ${url}: ${lastError.message}, retry ${attempt}/${maxRetries} after ${delay}ms`,
          )
          await new Promise(resolve => setTimeout(resolve, delay))
        } else {
          throw lastError
        }
      }
    }

    // Get file size from Content-Length header
    const contentLength = response.headers.get('content-length')
    const fileSize = contentLength ? parseInt(contentLength) : 0

    // Check file size limits (only when catbox upload is enabled)
    if (fileSize > 0 && !chatData[chat].skipCatbox) {
      if (
        (service === 'Catbox' && fileSize > 200000000) ||
        (service === 'Litterbox' && fileSize > 1000000000)
      ) {
        log(`[${logIndex}] File too big: ${url} (${fileSize} bytes)`)
        // Log to channel even for oversized files
        if (LOG_CHANNEL_ID) {
          try {
            let resolveLogPromise: () => void
            const logPromise = new Promise<void>(resolve => {
              resolveLogPromise = resolve
            })
            await sendToLogChannel(chat, {
              index: logIndex,
              url,
              service,
              result: null,
              filePath: '',
              imageMsg: msg,
              resolve: resolveLogPromise!,
            })
            await logPromise
          } catch (e) {
            log(`[${logIndex}] Log error (non-fatal): ${e.message}`)
          }
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

    log(`[${logIndex}] Start downloading from URL: ${url} to ${filePath}...`)

    // Download file with streaming
    const reader = response.body?.getReader()
    if (!reader) throw new Error('Failed to get response body reader')

    const fileStream = fs.createWriteStream(filePath)

    let downloadedBytes = 0
    while (true) {
      // Check abort between chunks
      if (abortSignal?.aborted) {
        reader.cancel()
        fileStream.end()
        throw new Error('Cancelled')
      }
      const { done, value } = await reader.read()
      if (done) {
        break
      }

      // Await write stream to ensure data is actually flushed to disk
      if (!fileStream.write(value)) {
        await new Promise<void>(resolve => fileStream.once('drain', () => resolve()))
      }
      downloadedBytes += value.length
    }

    fileStream.end()
    await new Promise<void>((resolve, reject) => {
      fileStream.on('finish', resolve)
      fileStream.on('error', reject)
    })

    const finalFileSize = fs.statSync(filePath).size
    log(`[${logIndex}] Downloaded from URL: ${filePath} (Size ${finalFileSize})`)

    // Check final file size (only when catbox upload is enabled)
    if (
      !chatData[chat].skipCatbox &&
      ((service === 'Catbox' && finalFileSize > 200000000) ||
        (service === 'Litterbox' && finalFileSize > 1000000000))
    ) {
      log(`[${logIndex}] Final file too big: ${filePath} (${finalFileSize} bytes)`)
      if (LOG_CHANNEL_ID) {
        try {
          let resolveLogPromise: () => void
          const logPromise = new Promise<void>(resolve => {
            resolveLogPromise = resolve
          })
          await sendToLogChannel(chat, {
            index: logIndex,
            url,
            service,
            result: null,
            filePath,
            imageMsg: msg,
            resolve: resolveLogPromise!,
          })
          await logPromise
        } catch (e) {
          log(`[${logIndex}] Log error (non-fatal): ${e.message}`)
        }
      }
      return null
    }

    // Upload to Catbox / Litterbox with retry and animated progress
    let result!: string
    let isCached = false

    // Check abort before upload
    if (abortSignal?.aborted) {
      throw new Error('Cancelled')
    }

    if (chatData[chat].skipCatbox) {
      log(`[${logIndex}] URL upload skipped due to user settings: ${url}`)
      result = 'Skipped'
    } else if (cachedCatboxUrl) {
      log(`[${logIndex}] URL already uploaded, using cache: ${url} -> ${cachedCatboxUrl}`)
      result = cachedCatboxUrl
      isCached = true
    } else {
      let uploadRetries = 3
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
            log(`[${logIndex}] Upload failed, retrying... (${e.message})`)
            await new Promise(resolve => setTimeout(resolve, 1500))
          } else {
            throw new Error(`Upload failed after retries: ${e.message}`)
          }
        }
      }
    }

    const resultLine = chatData[chat].skipCatbox ?
      `<code>${logIndex}.</code> Skipped upload (${(finalFileSize / 1000 / 1000).toFixed(2)} MB)` :
      `<code>${logIndex}.</code> <a href="${result}">${(finalFileSize / 1000 / 1000).toFixed(2)} MB</a>`

    chatData[chat].total++
    log(`[${logIndex}] Processed ${filePath} from URL for ${service}: ${result}`)

    // Save to cache for deduplication
    if (!isCached && !chatData[chat].skipCatbox) setCachedUrl(url, result)

    // Ensure bot is connected before sending to log
    if (LOG_CHANNEL_ID && !bot.connected) {
      log(`[${logIndex}] Bot disconnected before log, reconnecting...`)
      await bot.connect()
    }

    // Add to log channel queue to be sent sequentially
    // File cleanup is deferred to the log queue processor so the file
    // stays on disk until it has been sent to the log channel.
    const fileDir = filePath ? filePath.substring(0, filePath.lastIndexOf('/')) : ''
    if (LOG_CHANNEL_ID) {
      try {
        let resolveLogPromise: () => void
        // We only need the resolve callback — the promise itself is intentionally
        // not awaited so transferSingleURL returns immediately (parallel mode)
        void new Promise<void>(resolve => {
          resolveLogPromise = resolve
        })

        await sendToLogChannel(chat, {
          index: logIndex,
          url,
          service,
          result,
          filePath,
          imageMsg: msg,
          resolve: resolveLogPromise!,
          cleanupFilePath: filePath, // Log queue will clean up after sending
          cleanupDir: fileDir !== './cache' ? fileDir : undefined,
        })
        // Don't await logPromise — let log queue process in background
        // This allows transferSingleURL to return immediately for parallel processing
      } catch (logError) {
        log(`[${logIndex}] Log channel error (non-fatal): ${logError.message}`)
        // Clean up file immediately if log queueing itself failed
        if (filePath && fs.existsSync(filePath)) {
          try {
            fs.rmSync(filePath)
          } catch (_) { }
          if (fileDir && fileDir !== './cache' && fs.existsSync(fileDir)) {
            try {
              fs.rmdirSync(fileDir)
            } catch (_) { }
          }
        }
      }
    } else {
      // No log channel — clean up file immediately
      if (filePath && fs.existsSync(filePath)) {
        try {
          fs.rmSync(filePath)
        } catch (_) { }
        if (fileDir && fileDir !== './cache' && fs.existsSync(fileDir)) {
          try {
            fs.rmdirSync(fileDir)
          } catch (_) { }
        }
      }
    }

    return resultLine
  } catch (e) {
    log(`[${logIndex}] Download from URL ${url} failed: ${e.stack || e.message}`)

    // Log failed downloads to the log channel too
    if (LOG_CHANNEL_ID) {
      try {
        await sendFailedToLogChannel(chat, logIndex, url, service, e.message || 'Unknown error')
      } catch (logError) {
        log(`[${logIndex}] Failed to send error log (non-fatal): ${logError.message}`)
      }
    }

    throw e
  } finally {
    // Only clean up on error — successful files are cleaned up by log queue
    // We check if an error was thrown by checking if we have a result
    // The catch block above re-throws, so if we reach finally without a result,
    // the file should be cleaned up
    chatData[chat].downloading--
    log(`[${logIndex}] Finished transferring process from URL`)
  }
}

// Send failed download info to log channel
async function sendFailedToLogChannel(
  chat: number,
  index: number,
  url: string,
  service: string,
  error: string,
) {
  if (!LOG_CHANNEL_ID) return
  try {
    await waitForFloodGate()
    await bot
      .sendMessage(LOG_CHANNEL_ID, {
        message: `❌ <b>Failed Upload</b>\nFrom: <code>${chat}</code>\nURL: <code>${url}</code>\nService: ${service}\nError: <code>${error}</code>\nIndex: ${index}`,
        parseMode: 'html',
      })
      .catch((e) => {
        const floodSec = getFloodWaitSeconds(e)
        if (floodSec) setFloodPause(floodSec)
      })
    // Add delay to avoid flood
    await new Promise(resolve => setTimeout(resolve, 2000))
  } catch (e) {
    const floodSec = getFloodWaitSeconds(e)
    if (floodSec) setFloodPause(floodSec)
    log(`Failed to send error log to channel: ${e.message}`)
  }
}

