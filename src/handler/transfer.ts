import * as fs from 'fs'
import i18n from '../i18n/index.js'
import mime from 'mime-types'
import bigInt from 'big-integer'
import sharp from 'sharp'
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
  url: string
  service: string
  result: string | null
  filePath: string
  imageMsg: Api.Message | null
  resolve: () => void
}

const logQueue: Map<number, LogQueueItem[]> = new Map()
const logProcessing: Map<number, boolean> = new Map()
const logSentIndices: Map<number, Set<string>> = new Map()

// Create a compressed preview for large images
async function createCompressedPreview(filePath: string, maxSize = 2560): Promise<string | null> {
  try {
    const previewPath = filePath.replace(/\.(jpg|jpeg|png|webp)$/i, '_preview.jpg')

    await sharp(filePath)
      .resize(maxSize, maxSize, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({
        quality: 80,
        progressive: false,
      })
      .toFile(previewPath)

    const previewSize = fs.statSync(previewPath).size

    // If preview is still > 5MB, reduce quality further
    if (previewSize > 5000000) {
      await sharp(filePath)
        .resize(maxSize, maxSize, {
          fit: 'inside',
          withoutEnlargement: true,
        })
        .jpeg({
          quality: 75,
          progressive: false,
        })
        .toFile(previewPath)
    }

    const finalSize = fs.statSync(previewPath).size
    log(`[Log] Created preview: ${(finalSize / 1000 / 1000).toFixed(2)} MB`)

    return previewPath
  } catch (e) {
    log(`[Log] Failed to create preview: ${e.message}`)
    return null
  }
}

async function sendToLogChannel(chat: number, item: LogQueueItem) {
  if (!LOG_CHANNEL_ID) {
    item.resolve() // Resolve immediately if no log channel
    return
  }

  log(`[Log] Adding to queue: ${item.url} (index ${item.index}) for chat ${chat}`)

  // Init tracking structures for this chat
  if (!logSentIndices.has(chat)) {
    logSentIndices.set(chat, new Set())
  }

  const sentSet = logSentIndices.get(chat)!

  // Skip if already sent (dedup)
  if (sentSet.has(item.url)) {
    log(`[Log] Skipping duplicate URL ${item.url} for chat ${chat}`)
    item.resolve() // Resolve immediately if already sent
    return
  }

  // Add to queue
  if (!logQueue.has(chat)) {
    logQueue.set(chat, [])
  }
  const queue = logQueue.get(chat)!
  queue.push(item)
  queue.sort((a, b) => a.index - b.index) // Sort by index to maintain order

  log(`[Log] Queue size for chat ${chat}: ${queue.length}`)

  // Start processing loop if not already running
  if (!logProcessing.get(chat)) {
    logProcessing.set(chat, true)
    log(`[Log] Starting queue processor for chat ${chat}`)
    // Process queue in background
    processLogQueue(chat).catch(e => log(`Log queue error: ${e.message}`))
  }
}

async function processLogQueue(chat: number) {
  const queue = logQueue.get(chat)!
  const sentSet = logSentIndices.get(chat)!

  log(`[Log] Processing queue for chat ${chat}, queue length: ${queue.length}`)

  while (queue.length > 0) {
    // Sort queue by index to maintain order
    queue.sort((a, b) => a.index - b.index)

    const item = queue[0]

    log(`[Log] Processing item: ${item.url} (index ${item.index})`)

    // Dedup check
    if (sentSet.has(item.url)) {
      log(`[Log] Already sent, skipping: ${item.url}`)
      queue.shift()
      item.resolve()
      continue
    }

    // Check if file still exists before processing
    if (!item.url.startsWith('tg-file-') && item.filePath && !fs.existsSync(item.filePath)) {
      log(`[Log] File no longer exists, skipping: ${item.filePath}`)
      queue.shift()
      item.resolve()
      continue
    }

    try {
      if (item.url.startsWith('tg-file-') && item.imageMsg) {
        // Direct media upload: forward the original message
        let fwdMsg: Api.Message | null = null
        const fwdResult = await bot
          .forwardMessages(LOG_CHANNEL_ID, {
            messages: item.imageMsg.id,
            fromPeer: chat,
          })
          .catch(() => null)
        if (fwdResult && fwdResult.length > 0) {
          fwdMsg = fwdResult[0] as Api.Message
        }

        if (fwdMsg) {
          await bot
            .sendMessage(LOG_CHANNEL_ID, {
              message: `Service: ${item.service}\nResult: \`${item.result}\``,
              replyTo: fwdMsg.id,
            })
            .catch(() => null)

          if (item.filePath && fs.existsSync(item.filePath)) {
            await bot
              .sendFile(LOG_CHANNEL_ID, {
                file: item.filePath,
                forceDocument: true,
                replyTo: fwdMsg.id,
              })
              .catch(() => null)
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

            // Always create compressed preview for all images
            if (/\.(jpg|jpeg|png|webp)$/i.test(item.filePath)) {
              log(`[Log] Creating compressed preview...`)
              previewPath = await createCompressedPreview(item.filePath)
            }

            // Try to send preview (or original if small) as compressed photo
            const fileToSend = previewPath || item.filePath
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
              // If AUTH_KEY_DUPLICATED, wait and let other operations complete
              if (e.message.includes('AUTH_KEY_DUPLICATED')) {
                return new Promise(resolve => setTimeout(() => resolve(null), 2000))
              }
              return null
            })) as Api.Message | null

            // If compressed photo failed, create smaller preview and retry
            if (!imageMsg && previewPath) {
              log(`[Log] Creating smaller preview (1920px)...`)
              if (fs.existsSync(previewPath)) fs.rmSync(previewPath)
              previewPath = await createCompressedPreview(item.filePath, 1920)

              if (previewPath) {
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
                  return null
                })) as Api.Message | null
              }
            }

            // Last resort: send as document
            if (!imageMsg) {
              log(`[Log] Sending as document (fallback)...`)
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
                return null
              })) as Api.Message | null
            }

            if (imageMsg) {
              // Always send original file as document reply
              await Promise.race([
                bot.sendFile(LOG_CHANNEL_ID, {
                  file: item.filePath,
                  forceDocument: true,
                  replyTo: imageMsg.id,
                }),
                new Promise((_, reject) =>
                  setTimeout(() => reject(new Error('Upload timeout')), uploadTimeout),
                ),
              ]).catch(e => {
                log(`[Log] Failed to send raw document: ${e.message}`)
              })
            } else {
              // Fallback: send just the caption if file upload failed
              log(`[Log] File upload failed, sending caption only`)
              await bot
                .sendMessage(LOG_CHANNEL_ID, {
                  message: captionStr + `\n\n⚠️ File upload failed (${fileSizeMB} MB)`,
                })
                .catch(() => null)
            }

            // Clean up preview file
            if (previewPath && fs.existsSync(previewPath)) {
              fs.rmSync(previewPath)
            }
          } catch (e) {
            log(`[Log] Error uploading to log channel: ${e.message}`)
            // Send caption only as fallback
            await bot
              .sendMessage(LOG_CHANNEL_ID, {
                message: captionStr + `\n\n⚠️ File upload error: ${e.message}`,
              })
              .catch(() => null)
          }
        } else {
          // File missing (e.g. it was too big to download), just send text
          await bot.sendMessage(LOG_CHANNEL_ID, { message: captionStr }).catch(() => null)
        }
      }

      sentSet.add(item.url)
      log(`[Log] Marked as sent: ${item.url}`)

      // Longer delay to avoid AUTH_KEY_DUPLICATED errors
      const delayMs = 5000 // 5 seconds between log uploads
      await new Promise(resolve => setTimeout(resolve, delayMs))
    } catch (e) {
      log(`Failed to send to log channel: ${e.message || e}`)
      // Try to send at least a text message as fallback
      try {
        await bot
          .sendMessage(LOG_CHANNEL_ID, {
            message: `Source: \`${item.url}\`\nService: ${item.service}\nResult: \`${item.result}\`\n\n⚠️ Error: ${e.message || e}`,
          })
          .catch(() => null)
      } catch (_) {
        // Ignore if even text message fails
      }
      // Mark as sent even on error to avoid infinite retries
      sentSet.add(item.url)
    }

    queue.shift()
    item.resolve()
    log(`[Log] Removed from queue: ${item.url}, remaining: ${queue.length}`)
  }

  logProcessing.set(chat, false)
  log(`[Log] Queue processor stopped for chat ${chat}`)
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
          text:
            `<b>📤 Uploading to ${service}${dots}</b>\n\n` +
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

    // Ensure bot is connected before starting
    if (!bot.connected) {
      log(`[${logIndex}] Bot disconnected, reconnecting...`)
      await bot.connect()
    }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 60000) // 60s timeout per request

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

        if (!response.ok) {
          if (response.status === 503 || response.status === 429 || response.status === 408) {
            // Rate limited, service unavailable, or timeout — retry with exponential backoff
            const delay = Math.min(2000 * Math.pow(2, attempt - 1), 30000) // 2s, 4s, 8s, 16s, 30s
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
          const delay = Math.min(2000 * Math.pow(2, attempt - 1), 30000)
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

    // Check file size limits
    if (fileSize > 0) {
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
    log(`[${logIndex}] Downloaded from URL: ${filePath} (Size ${finalFileSize})`)

    // Check final file size
    if (
      (service === 'Catbox' && finalFileSize > 200000000) ||
      (service === 'Litterbox' && finalFileSize > 1000000000)
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

    if (cachedCatboxUrl) {
      log(`[${logIndex}] URL already uploaded, using cache: ${url} -> ${cachedCatboxUrl}`)
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
            text:
              `<b>📥 Batch Upload</b>\n\n` +
              `<b>📤 Uploading to ${service}${dots}</b>\n` +
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
              log(`[${logIndex}] Upload failed, retrying... (${e.message})`)
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

    const resultLine = `<code>${logIndex}.</code> <a href="${result}">${(finalFileSize / 1000 / 1000).toFixed(2)} MB${isCached ? ' (Cached)' : ''}</a>`

    chatData[chat].total++
    log(`[${logIndex}] Processed ${filePath} from URL for ${service}: ${result}`)

    // Save to cache for deduplication
    if (!isCached) setCachedUrl(url, result)

    // Ensure bot is connected before sending to log
    if (LOG_CHANNEL_ID && !bot.connected) {
      log(`[${logIndex}] Bot disconnected before log, reconnecting...`)
      await bot.connect()
    }

    // Add to log channel queue to be sent sequentially
    if (LOG_CHANNEL_ID) {
      try {
        let resolveLogPromise: () => void
        const logPromise = new Promise<void>(resolve => {
          resolveLogPromise = resolve
        })

        await sendToLogChannel(chat, {
          index: logIndex, // Use sequential index for proper ordering
          url,
          service,
          result,
          filePath,
          imageMsg: msg,
          resolve: resolveLogPromise!,
        })
        await logPromise // Wait for this specific log item to be processed
      } catch (logError) {
        log(`[${logIndex}] Log channel error (non-fatal): ${logError.message}`)
      }
    }

    // Clean up file after sending to log
    if (filePath && fs.existsSync(filePath)) {
      fs.rmSync(filePath)
      const dir = filePath.substring(0, filePath.lastIndexOf('/'))
      if (dir && dir !== './cache' && fs.existsSync(dir)) {
        try {
          fs.rmdirSync(dir)
        } catch (_) {}
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
    // Clean up file on error
    if (filePath && fs.existsSync(filePath)) {
      try {
        fs.rmSync(filePath)
      } catch (_) {}
      const dir = filePath.substring(0, filePath.lastIndexOf('/'))
      if (dir && dir !== './cache' && fs.existsSync(dir)) {
        try {
          fs.rmdirSync(dir)
        } catch (_) {}
      }
    }
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
