import i18n from '../i18n/index.js'
import { bot } from '../../index.js'
import { handleCommand } from './command.js'
import { chatData, initChatData } from './data.js'
import { transfer, transferFromURL } from './transfer.js'
import { ALLOWED_USERS, ADMIN_ID } from '../env.js'
import type { NewMessageEvent } from 'telegram/events/NewMessage.js'

// Message handler
export async function handleMessage(event: NewMessageEvent) {
  const msg = event.message
  // Currently, only support private messages
  if (msg.peerId.className !== 'PeerUser') return
  const chatId = msg.peerId.userId.toString()
  const userId = msg.peerId.userId.toJSNumber()

  // Check if the user has configured the bot
  initChatData(chatId)
  const lang = chatData[chatId].lang

  // Check if user is allowed (if ALLOWED_USERS is configured and not empty)
  if (ALLOWED_USERS.length > 0) {
    const isAllowed = ALLOWED_USERS.includes(userId) || userId === ADMIN_ID
    if (!isAllowed) {
      await bot.sendMessage(chatId, {
        message: i18n.t(lang, 'error_unauthorized'),
      })
      return
    }
  }
  if (isCommand(msg.message)) await handleCommand(msg)
  else if (hasURLs(msg.message)) await handleURLMessage(msg)
  else if (msg.media) {
    // Check if it's a .txt file with URLs
    if (await isTxtFileWithUrls(msg)) {
      await handleTxtFileUrls(msg)
    } else {
      await transfer(msg)
    }
  } else {
    bot
      .sendMessage(chatId, {
        message: i18n.t(lang, 'sendMeAFile'),
      })
      .catch(() => null)
  }
}

// Check if message contains a .txt file
async function isTxtFileWithUrls(msg: any): Promise<boolean> {
  if (!msg.media || !('document' in msg.media)) return false
  const doc = msg.media.document
  if (!doc || doc.className !== 'Document') return false

  // Check if it's a text file
  if (doc.mimeType === 'text/plain') return true

  // Check file extension from attributes
  for (const attr of doc.attributes) {
    if (attr.className === 'DocumentAttributeFilename') {
      if (attr.fileName && attr.fileName.toLowerCase().endsWith('.txt')) {
        return true
      }
    }
  }

  return false
}

// Handle .txt file containing URLs
async function handleTxtFileUrls(msg: any) {
  const chatId = msg.peerId.userId.toString()

  const statusMsg = await bot.sendMessage(chatId, {
    message: '📄 Downloading URL list file...',
    replyTo: msg.id,
  })

  try {
    // Download the txt file
    const buffer = await bot.downloadMedia(msg.media, {})

    if (!buffer) {
      throw new Error('Failed to download file')
    }

    // Convert buffer to string
    const content = buffer.toString('utf-8')

    // Extract URLs from the file
    const urlRegex = /https?:\/\/[^\s]+/g
    const urls = content.match(urlRegex) || []

    if (urls.length === 0) {
      await bot.editMessage(chatId, {
        message: statusMsg.id,
        text: '❌ No URLs found in the file.',
      })
      return
    }

    await bot.editMessage(chatId, {
      message: statusMsg.id,
      text: `✅ Found ${urls.length} URLs in file.\n\nProcessing batch...`,
    })

    // Delete the status message after a moment
    setTimeout(() => {
      bot.deleteMessages(chatId, [statusMsg.id], { revoke: true }).catch(() => null)
    }, 2000)

    // Create a synthetic message with the URLs
    const syntheticMsg = {
      ...msg,
      message: urls.join('\n'),
    }

    // Process the URLs
    await transferFromURL(syntheticMsg)
  } catch (error) {
    await bot.editMessage(chatId, {
      message: statusMsg.id,
      text: `❌ Error processing file: ${error.message}`,
    })
  }
}

function isCommand(message: string) {
  return message.startsWith('/')
}

function hasURLs(message: string) {
  return /https?:\/\/[^\s]+/i.test(message)
}

// Handle messages containing URLs
async function handleURLMessage(msg: any) {
  const chatId = msg.peerId.userId.toString()
  const chat = msg.peerId.userId.toJSNumber()

  // Extract all URLs from the message
  const urlRegex = /https?:\/\/[^\s]+/g
  const urls = msg.message.match(urlRegex) || []

  if (urls.length === 0) return

  const statusMsg = await bot.sendMessage(chatId, {
    message: `📥 Found ${urls.length} URL${urls.length > 1 ? 's' : ''}. Starting download...`,
    replyTo: msg.id,
  })

  try {
    // Import transfer function
    const { transferSingleURL, getLogQueueStatus } = await import('./transfer.js')

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

    // Store progress state for refresh button
    const progressState = {
      completed,
      failed,
      failedUrls,
      startTime,
      totalUrls: urls.length,
      statusMsgId: statusMsg.id,
      chat,
      isComplete: false,
      isCancelled: false,
      logStartTime: null as number | null,
      logLastDone: 0,
      logLastTime: null as number | null,
    }

    // Store in chatData for access from callback
    chatData[chat].batchProgress = progressState

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
      const logStatus = getLogQueueStatus(chat)
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
        .editMessage(chat, {
          message: statusMsg.id,
          text,
          parseMode: 'html',
          linkPreview: false,
          buttons:
            showButton && !progressState.isComplete
              ? (await import('./buttons.js')).refreshProgress(chat)
              : undefined,
        })
        .catch(() => {})
    }

    // Auto-update progress every 5 seconds
    const progressInterval = setInterval(() => {
      if (!progressState.isComplete) {
        updateProgress().catch(() => {})
      }
    }, 5000)

    // Process URLs one by one sequentially
    for (let i = 0; i < urls.length; i++) {
      // Check if cancelled
      if (progressState.isCancelled) {
        console.log('Batch download cancelled by user')
        break
      }

      const currentUrl = urls[i]

      try {
        console.log(`[${i + 1}/${urls.length}] Processing: ${currentUrl}`)

        const result = await transferSingleURL(msg, currentUrl, i + 1, urls.length, statusMsg.id)

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
    }

    // Wait for log queue to finish
    let logStatus = getLogQueueStatus(chat)
    while (!progressState.isCancelled && (logStatus.pending > 0 || logStatus.processing)) {
      await new Promise(resolve => setTimeout(resolve, 1000))
      logStatus = getLogQueueStatus(chat)
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
        finalText += `\n... and ${progressState.failedUrls.length - 10} more`
      }
    }

    await bot.editMessage(chat, {
      message: statusMsg.id,
      text: finalText,
      parseMode: 'html',
      linkPreview: false,
    })

    // Clean up progress state
    delete chatData[chat].batchProgress
  } catch (error) {
    await bot.editMessage(chatId, {
      message: statusMsg.id,
      text: `❌ Error processing URLs: ${error.message}`,
    })
  }
}
