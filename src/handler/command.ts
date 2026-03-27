import i18n from '../i18n/index.js'
import * as buttons from './buttons.js'
import { bot, BOT_NAME } from '../../index.js'
import { Catbox } from 'node-catbox'
import { chatData, saveBotData } from './data.js'
import { ADMIN_ID, LOG_CHANNEL_ID, PARALLEL_DOWNLOADS } from '../env.js'
import type { Api } from 'telegram'
import * as fs from 'fs'
import mime from 'mime-types'

// Bot command handler
export async function handleCommand(msg: Api.Message) {
  const text = msg.message
  const chat = (msg.peerId as Api.PeerUser).userId.toJSNumber()

  const generalCmds = new GeneralCommands(msg)
  const ownerCmds = new OwnerCommands(msg)

  // Split message by lines starting with /
  const blocks = text.split(/(?=^\/)/m).map(b => b.trim()).filter(b => b.startsWith('/'))

  for (const block of blocks) {
    const match = block.match(/^\/([^\s@]+)(?:@([^\s]+))?(?:\s+([\s\S]*))?$/)
    if (!match) continue

    const command = match[1]
    const mention = match[2]
    const arg = match[3] || ''

    // If the text contains mention, need to check if the mentioned target is the bot
    if (mention && mention !== BOT_NAME) continue

    console.log(
      `[Command Debug] Trying command '${command}' for chat ${chat} (ADMIN_ID: ${ADMIN_ID})`,
    )
    console.log(
      `[Command Debug] isGeneral: ${typeof (generalCmds as any)[command] === 'function'}, isOwner: ${typeof (ownerCmds as any)[command] === 'function'}`,
    )

    try {
      if (typeof (generalCmds as any)[command] === 'function') {
        const result = (generalCmds as any)[command](arg)
        if (result instanceof Promise) await result
      } else if (chat === ADMIN_ID && typeof (ownerCmds as any)[command] === 'function') {
        const result = (ownerCmds as any)[command](arg)
        if (result instanceof Promise) await result
      }
    } catch (e: any) {
      console.error(`[Command Error] Command ${command} failed:`, e)
      if (e.errorMessage === 'FLOOD' || e.name === 'FloodWaitError') {
        console.warn(`[Command Warn] Stopping further command processing due to FloodWaitError of ${e.seconds}s`)
        break
      }
    }
    
    // Add small delay to prevent rapid execution of multiple commands causing API flood
    if (blocks.length > 1 && block !== blocks[blocks.length - 1]) {
      await new Promise(r => setTimeout(r, 1500))
    }
  }
}

class OwnerCommands {
  chat: number
  lang: string

  constructor(msg: Api.Message) {
    this.chat = (msg.peerId as Api.PeerUser).userId.toJSNumber()
    this.lang = chatData[this.chat].lang
  }

  ban(arg: string) {
    if (arg) {
      const user = parseInt(arg)
      if (chatData[user]) {
        chatData[user].banned = true
        saveBotData()
        bot.sendMessage(this.chat, { message: i18n.t(this.lang, 'banned') }).catch(console.error)
      } else {
        bot
          .sendMessage(this.chat, { message: i18n.t(this.lang, 'userNotFound') })
          .catch(console.error)
      }
    } else {
      bot.sendMessage(this.chat, { message: 'Usage: /ban UID' }).catch(console.error)
    }
  }

  unban(arg: string) {
    if (arg) {
      const user = parseInt(arg)
      if (chatData[user]) {
        chatData[user].banned = false
        saveBotData()
        bot.sendMessage(this.chat, { message: i18n.t(this.lang, 'unbanned') }).catch(console.error)
      } else {
        bot
          .sendMessage(this.chat, { message: i18n.t(this.lang, 'userNotFound') })
          .catch(console.error)
      }
    } else {
      bot.sendMessage(this.chat, { message: 'Usage: /unban UID' }).catch(console.error)
    }
  }

  async broadcast(text: string) {
    if (!text) return bot.sendMessage(ADMIN_ID, { message: 'Come on, say something.' })
    const chats = Object.keys(chatData)
    const count = chats.length
    const result = await bot.sendMessage(ADMIN_ID, {
      message: `Start broadcasting tp ${count} chats...`,
    })
    let edit = setInterval(() => {
      bot
        .editMessage(ADMIN_ID, {
          message: result.id,
          text: `Broadcasting, remaining ${chats.length} / ${count}...`,
        })
        .catch(() => null)
    }, 2000)
    while (chats.length) {
      const chat = chats.shift()!
      await bot.sendMessage(chat, { message: text }).catch(e => {
        if (e.message.toLowerCase().includes('flood')) chats.push(chat)
      })
      await sleep(100)
    }
    clearInterval(edit)
    await bot.editMessage(ADMIN_ID, { message: result.id, text: 'Broadcast success!' })
  }

  async send(text: string) {
    if (!LOG_CHANNEL_ID) {
      return bot
        .sendMessage(this.chat, { message: 'LOG_CHANNEL_ID is not configured.' })
        .catch(console.error)
    }
    if (!text) {
      return bot
        .sendMessage(this.chat, {
          message:
            'Usage:\n/send <url> <caption>\n\nExample:\n/send https://example.com/video.mp4 My Video Title',
        })
        .catch(console.error)
    }

    try {
      // Parse the command: first word is URL, rest is caption
      const match = text.match(/^(\S+)(?:\s+([\s\S]*))?$/)
      if (!match) return bot.sendMessage(this.chat, { message: 'Failed to extract URL.' }).catch(console.error)
      const url = match[1]
      const caption = match[2] || ''

      // Check if it's a URL
      if (url.startsWith('http://') || url.startsWith('https://')) {
        const statusMsg = await bot.sendMessage(this.chat, {
          message: '📥 Downloading file from URL...',
        })

        try {
          // Download the file
          const urlObj = new URL(url)
          const referer = `${urlObj.protocol}//${urlObj.host}/`

          const response = await fetch(url, {
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
          })

          if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`)
          }

          // Get filename from URL
          const urlPath = new URL(url).pathname
          let filename = urlPath.split('/').pop() || 'download'

          // Try to decode filename
          try {
            filename = decodeURIComponent(filename)
          } catch (e) {
            // Keep original if decode fails
          }

          // If no extension, try to get from content-type
          if (!filename.includes('.')) {
            const contentType = response.headers.get('content-type')
            if (contentType) {
              const ext = mime.extension(contentType)
              if (ext) filename += `.${ext}`
            }
          }

          const uniqueDir = `./cache/${this.chat}_${Date.now()}`
          fs.mkdirSync(uniqueDir, { recursive: true })
          const filePath = `${uniqueDir}/${filename}`

          await bot.editMessage(this.chat, {
            message: statusMsg.id,
            text: '💾 Saving file...',
          })

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

          const fileSize = fs.statSync(filePath).size
          console.log(`Downloaded: ${filePath} (${fileSize} bytes)`)

          await bot.editMessage(this.chat, {
            message: statusMsg.id,
            text: '📤 Uploading to log channel...',
          })

          // Upload to log channel with caption
          const captionText = caption ? `<b><i><u>${caption}</u></i></b>` : ''

          await bot.sendFile(LOG_CHANNEL_ID, {
            file: filePath,
            caption: captionText,
            parseMode: 'html',
            forceDocument: false,
          })

          await bot.editMessage(this.chat, {
            message: statusMsg.id,
            text: `✅ File uploaded to log channel!\n\n📁 Size: ${(fileSize / 1000 / 1000).toFixed(2)} MB${caption ? `\n📝 Caption: ${caption}` : ''}`,
          })

          // Clean up
          if (fs.existsSync(filePath)) {
            fs.rmSync(filePath)
            if (fs.existsSync(uniqueDir)) {
              try {
                fs.rmdirSync(uniqueDir)
              } catch (_) {}
            }
          }
        } catch (e: any) {
          if (e.errorMessage === 'FLOOD' || e.name === 'FloodWaitError') throw e;
          await bot.editMessage(this.chat, {
            message: statusMsg.id,
            text: `❌ Failed to download/upload: ${e.message}`,
          }).catch(() => {})
        }
      } else {
        // If not a URL, send as text message (original behavior)
        await bot.sendMessage(LOG_CHANNEL_ID, {
          message: `<b><i><u>${text}</u></i></b>`,
          parseMode: 'html',
          linkPreview: false,
        })
        await bot.sendMessage(this.chat, { message: 'Message sent to log channel.' })
      }
    } catch (e: any) {
      if (e.errorMessage === 'FLOOD' || e.name === 'FloodWaitError') throw e;
      bot.sendMessage(this.chat, { message: `Failed to send: ${e.message}` }).catch(console.error)
    }
  }


}

class GeneralCommands {
  chat: number
  lang: string

  constructor(msg: Api.Message) {
    this.chat = (msg.peerId as Api.PeerUser).userId.toJSNumber()
    this.lang = chatData[this.chat].lang
  }

  start() {
    bot
      .sendMessage(this.chat, {
        // Initial message does not support i18n
        message:
          '🐱 <b>欢迎！请在下方选择您的语言。发送 /help 命令查看帮助。\n\nWelcome! Please select a language below. Send /help to see what I can do.</b>',
        parseMode: 'html',
        buttons: buttons.setLanguage(this.lang),
      })
      .catch(console.error)
  }

  help() {
    bot
      .sendMessage(this.chat, {
        message: i18n.t(this.lang, 'help'),
        parseMode: 'html',
        linkPreview: false,
      })
      .catch(console.error)
  }

  settings() {
    bot
      .sendMessage(this.chat, {
        message: i18n.t(this.lang, 'settings'),
        parseMode: 'html',
        buttons: buttons.mainSettings(this.chat),
      })
      .catch(console.error)
  }

  async stats() {
    let total = 0,
      downloading = 0
    for (let chat in chatData) {
      downloading += chatData[chat].downloading
      total += chatData[chat].total
    }
    await bot.sendMessage(this.chat, {
      message: i18n.t(this.lang, 'stats', [
        Object.keys(chatData).length.toString(),
        downloading.toString(),
        total.toString(),
        chatData[this.chat].total.toString(),
      ]),
      parseMode: 'html',
    })
  }

  async delete(link: string) {
    if (link) {
      // Parse the filename if it's a link
      if (link.startsWith('http')) {
        link = new URL(link).pathname.substring(1)
      }
      if (chatData[this.chat].token) {
        let result = ''
        const catbox = new Catbox(chatData[this.chat].token)

        try {
          await catbox.deleteFiles({ files: [link] })
          await bot.sendMessage(this.chat, { message: i18n.t(this.lang, 'deleteFileSuccess') })
        } catch (e) {
          console.error(`Delete file ${link} failed:`, e)
          if (e.message.includes("doesn't exist")) {
            result = i18n.t(this.lang, 'operationFailed', [i18n.t(this.lang, 'fileNotFound')])
          } else if (e.message.includes("didn't belong to")) {
            result = i18n.t(this.lang, 'operationFailed', [i18n.t(this.lang, 'fileWrongOwnership')])
          } else result = i18n.t(this.lang, 'unknownError')
          await bot.sendMessage(this.chat, { message: result })
        }
      } else
        await bot.sendMessage(this.chat, {
          message: i18n.t(this.lang, 'err_TokenNeeded'),
          parseMode: 'html',
          linkPreview: false,
        })
    } else
      await bot.sendMessage(this.chat, {
        message: i18n.t(this.lang, 'help_delete'),
        parseMode: 'html',
      })
  }

  async token(token: string) {
    if (token) {
      chatData[this.chat].token = token
      await bot.sendMessage(this.chat, { message: i18n.t(this.lang, 'setSuccess') })
    } else {
      await bot.sendMessage(this.chat, {
        message: i18n.t(this.lang, 'help_token', [chatData[this.chat].token || '🚫']),
        parseMode: 'html',
        linkPreview: false,
      })
    }
  }

  async skipcat() {
    chatData[this.chat].skipCatbox = true
    await bot.sendMessage(this.chat, {
      message: '✅ Catbox uploading will be skipped. Files will only be saved to the log channel.',
      parseMode: 'html',
    })
  }

  async upcat() {
    chatData[this.chat].skipCatbox = false
    await bot.sendMessage(this.chat, {
      message: '✅ Catbox uploading has been re-enabled.',
      parseMode: 'html',
    })
  }

  async cancel() {
    const progressState = chatData[this.chat].batchProgress

    if (!progressState || progressState.isComplete) {
      await bot.sendMessage(this.chat, {
        message: '❌ No active batch download to cancel.',
        parseMode: 'html',
      })
      return
    }

    // Set the cancel flag
    progressState.isCancelled = true

    // Abort any in-progress downloads/uploads immediately
    if (progressState.abortController) {
      progressState.abortController.abort()
    }

    // Update the progress message to show cancellation
    const totalProcessed = progressState.completed + progressState.failed
    const progress = Math.round((totalProcessed / progressState.totalUrls) * 100)
    const elapsed = (Date.now() - progressState.startTime) / 1000
    const avgTimePerUrl = totalProcessed > 0 ? elapsed / totalProcessed : 0
    const remaining = progressState.totalUrls - totalProcessed
    const eta = totalProcessed > 0 ? Math.round(avgTimePerUrl * remaining) : 0

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

    let text = `<b>🛑 Cancelling Batch...</b>\n\n`
    text += `✅ ${progressState.completed} | ❌ ${progressState.failed} | 📊 ${totalProcessed}/${progressState.totalUrls}\n`
    text += `<code>[${buildProgressBar(progress)}]</code> ${progress}%\n`
    text += `⏱ ETA: <code>${secToTime(eta)}</code>\n\n`
    text += `<i>Aborting in-progress downloads and stopping log uploads...</i>`

    await bot
      .editMessage(this.chat, {
        message: progressState.statusMsgId,
        text,
        parseMode: 'html',
        linkPreview: false,
      })
      .catch(() => {})
  }

  async dl(url: string) {
    url = url ? url.trim() : ''
    if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
      await bot.sendMessage(this.chat, {
        message:
          '❌ Usage: /dl <url>\n\nProvide a URL to a text file containing URLs (one per line).',
        parseMode: 'html',
      })
      return
    }

    const statusMsg = await bot.sendMessage(this.chat, {
      message: '📄 Downloading URL list from link...',
    })

    try {
      // Download the URL list
      const urlObj = new URL(url)
      const referer = `${urlObj.protocol}//${urlObj.host}/`

      const response = await fetch(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'text/plain,text/html,*/*',
          'Accept-Encoding': 'gzip, deflate, br',
          'Accept-Language': 'en-US,en;q=0.9',
          Connection: 'keep-alive',
          Referer: referer,
          'Cache-Control': 'no-cache',
          Pragma: 'no-cache',
        },
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }

      const content = await response.text()

      // Extract URLs from the content
      const urlRegex = /https?:\/\/[^\s]+/g
      const urls = content.match(urlRegex) || []

      if (urls.length === 0) {
        await bot.editMessage(this.chat, {
          message: statusMsg.id,
          text: '❌ No URLs found in the file.',
        })
        return
      }

      await bot.editMessage(this.chat, {
        message: statusMsg.id,
        text: `✅ Found ${urls.length} URLs.\n\nStarting parallel download (${PARALLEL_DOWNLOADS} concurrent)...`,
      })

      // Import transfer function
      const { transferSingleURL, getLogQueueStatus, isFloodPaused } = await import('./transfer.js')

      let completed = 0
      let failed = 0
      const failedUrls: Array<{ index: number; url: string; error: string }> = []
      const startTime = Date.now()

      // Helper functions
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

      // Create AbortController for cancellation
      const abortController = new AbortController()

      // Store progress state for refresh button
      const progressState = {
        completed,
        failed,
        failedUrls,
        startTime,
        totalUrls: urls.length,
        statusMsgId: statusMsg.id,
        chat: this.chat,
        isComplete: false,
        isCancelled: false,
        abortController,
        logStartTime: null as number | null,
        logLastDone: 0,
        logLastTime: null as number | null,
      }

      // Store in chatData for access from callback
      chatData[this.chat].batchProgress = progressState

      // Update progress
      const updateProgress = async (showButton = true) => {
        const totalProcessed = progressState.completed + progressState.failed
        const dlProgress = Math.round((totalProcessed / progressState.totalUrls) * 100)
        const elapsed = (Date.now() - progressState.startTime) / 1000
        const avgTimePerUrl = totalProcessed > 0 ? elapsed / totalProcessed : 0
        const remaining = progressState.totalUrls - totalProcessed
        const eta = totalProcessed > 0 ? Math.round(avgTimePerUrl * remaining) : 0

        // Download bar
        let text = `<b>📥 Batch Download</b>\n`
        text += `✅ ${progressState.completed} | ❌ ${progressState.failed} | 📊 ${totalProcessed}/${progressState.totalUrls}\n`
        text += `<code>[${buildProgressBar(dlProgress)}]</code> ${dlProgress}%\n`
        text += `⏱ ETA: <code>${secToTime(eta)}</code>`

        // Log upload bar (always shown as a separate section)
        const logStatus = getLogQueueStatus(this.chat)
        const totalLogs = progressState.totalUrls
        const logsDone = Math.max(0, totalLogs - logStatus.pending)
        const logProgress = totalLogs > 0 ? Math.round((logsDone / totalLogs) * 100) : 0

        // Track log start time once logs begin processing
        if (logsDone > 0 && progressState.logStartTime === null) {
          progressState.logStartTime = Date.now()
          progressState.logLastDone = logsDone
          progressState.logLastTime = Date.now()
        }

        // Compute log ETA using a rolling rate (last snapshot → now)
        let logEta = 0
        if (progressState.logLastTime !== null && logsDone > progressState.logLastDone) {
          const logElapsed = (Date.now() - progressState.logLastTime) / 1000
          const logRate = (logsDone - progressState.logLastDone) / logElapsed // logs/sec
          logEta = logRate > 0 ? Math.round(logStatus.pending / logRate) : 0
          progressState.logLastDone = logsDone
          progressState.logLastTime = Date.now()
        } else if (progressState.logStartTime !== null) {
          const logElapsed = (Date.now() - progressState.logStartTime) / 1000
          const logRate = logsDone > 0 ? logsDone / logElapsed : 0
          logEta = logRate > 0 ? Math.round(logStatus.pending / logRate) : 0
        }

        text += `\n\n<b>📤 Uploading Logs</b>\n`
        text += `✅ ${logsDone} | ⏳ ${logStatus.pending} remaining\n`
        text += `<code>[${buildProgressBar(logProgress)}]</code> ${logProgress}%\n`
        text += `⏱ ETA: <code>${secToTime(logEta)}</code>`

        if (progressState.failedUrls.length > 0 && progressState.failedUrls.length <= 5) {
          const failedList = progressState.failedUrls
            .slice(0, 5)
            .map(f => `${f.index + 1}. ${f.error}`)
            .join('\n')
          text += `\n\n<b>❌ Failed:</b>\n${failedList}`
        } else if (progressState.failedUrls.length > 5) {
          text += `\n\n<b>❌ ${progressState.failedUrls.length} failed</b>`
        }

        await bot
          .editMessage(this.chat, {
            message: statusMsg.id,
            text,
            parseMode: 'html',
            linkPreview: false,
            buttons:
              showButton && !progressState.isComplete
                ? buttons.refreshProgress(this.chat)
                : undefined,
          })
          .catch(() => {})
      }

      // Auto-update progress every 7 seconds (skipped during flood pause)
      const progressInterval = setInterval(() => {
        if (!progressState.isComplete && !isFloodPaused()) {
          updateProgress().catch(() => {})
        }
      }, 7000)

      // Process URLs with controlled concurrency (worker pool pattern)
      let nextIndex = 0 // Shared counter for the next URL to process

      async function processWorker(
        chat: number,
        urls: string[],
        progressState: any,
        statusMsgId: number,
      ): Promise<void> {
        while (nextIndex < urls.length && !progressState.isCancelled) {
          const i = nextIndex++
          const currentUrl = urls[i]

          try {
            console.log(`[${i + 1}/${urls.length}] Processing: ${currentUrl}`)

            const syntheticMsg = {
              peerId: {
                className: 'PeerUser',
                userId: {
                  toJSNumber: () => chat,
                  toString: () => chat.toString(),
                },
              },
              id: i + 1,
            } as any

            const result = await transferSingleURL(
              syntheticMsg,
              currentUrl,
              i + 1,
              urls.length,
              statusMsgId,
              abortController.signal,
            )

            if (result) {
              progressState.completed++
            } else {
              progressState.failed++
              progressState.failedUrls.push({
                index: i,
                url: currentUrl,
                error: 'File too big or empty',
              })
            }
          } catch (error) {
            progressState.failed++
            progressState.failedUrls.push({
              index: i,
              url: currentUrl,
              error: error.message || 'Unknown error',
            })
            console.error(`[${i + 1}/${urls.length}] Error: ${error.message}`)
          }

          // Small delay between downloads within each worker to avoid
          // thundering herd on the source server
          if (nextIndex < urls.length && !progressState.isCancelled) {
            await sleep(250)
          }
        }
      }

      // Launch N workers with staggered starts
      const workers: Promise<void>[] = []
      const workerCount = Math.min(PARALLEL_DOWNLOADS, urls.length)
      for (let w = 0; w < workerCount; w++) {
        workers.push(processWorker(this.chat, urls, progressState, statusMsg.id))
        // Stagger worker launches to avoid all workers hitting the
        // source server simultaneously at startup
        if (w < workerCount - 1) {
          await sleep(250)
        }
      }

      // Wait for all workers to complete
      await Promise.all(workers)

      // Wait for log queue to finish
      let logStatus = getLogQueueStatus(this.chat)
      while (!progressState.isCancelled && (logStatus.pending > 0 || logStatus.processing)) {
        await sleep(1000)
        logStatus = getLogQueueStatus(this.chat)
      }

      // Stop auto-update
      clearInterval(progressInterval)
      progressState.isComplete = true

      // Final summary
      const totalElapsed = (Date.now() - startTime) / 1000
      const totalProcessed = progressState.completed + progressState.failed

      let finalText = progressState.isCancelled
        ? `<b>🛑 Batch Cancelled!</b>\n\n`
        : `<b>✅ Batch Complete!</b>\n\n`

      finalText += `📊 ${progressState.completed}/${urls.length} successful`
      if (progressState.failed > 0) finalText += ` | ❌ ${progressState.failed} failed`
      if (progressState.isCancelled) finalText += ` | ⏭ ${urls.length - totalProcessed} skipped`
      finalText += `\n⏱ Total time: <code>${secToTime(Math.round(totalElapsed))}</code>`

      if (progressState.failedUrls.length > 0) {
        const failedList = progressState.failedUrls
          .slice(0, 10)
          .map(f => `${f.index + 1}. ${f.error}`)
          .join('\n')
        finalText += `\n\n<b>❌ Failed:</b>\n${failedList}`
        if (progressState.failedUrls.length > 10) {
          finalText += `\n... and ${failedUrls.length - 10} more`
        }
      }

      await bot.editMessage(this.chat, {
        message: statusMsg.id,
        text: finalText,
        parseMode: 'html',
        linkPreview: false,
      })

      // Clean up progress state
      delete chatData[this.chat].batchProgress
    } catch (error: any) {
      if (error.errorMessage === 'FLOOD' || error.name === 'FloodWaitError') throw error;
      await bot.editMessage(this.chat, {
        message: statusMsg.id,
        text: `❌ Error downloading URL list: ${error.message}`,
      }).catch(() => {})
    }
  }
}

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms))
}
