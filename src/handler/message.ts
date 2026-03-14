import i18n from '../i18n/index.js'
import { bot } from '../../index.js'
import { handleCommand } from './command.js'
import { chatData, initChatData } from './data.js'
import { transfer } from './transfer.js'
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
      text: `✅ Found ${urls.length} URLs in file. Starting parallel download...`,
    })

    // Delete the status message after a moment and start batch
    setTimeout(() => {
      bot.deleteMessages(chatId, [statusMsg.id], { revoke: true }).catch(() => null)
    }, 2000)

    const newStatusMsg = await bot.sendMessage(chatId, {
      message: `📥 Found ${urls.length} URLs. Starting parallel download...`,
      replyTo: msg.id,
    })

    const { runBatch } = await import('./batchProcessor.js')
    await runBatch(msg, urls, newStatusMsg.id)
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

  const urls = msg.message.match(/https?:\/\/[^\s]+/g) || []
  if (urls.length === 0) return

  const statusMsg = await bot.sendMessage(chatId, {
    message: `📥 Found ${urls.length} URL${urls.length > 1 ? 's' : ''}. Starting parallel download...`,
    replyTo: msg.id,
  })

  try {
    const { runBatch } = await import('./batchProcessor.js')
    await runBatch(msg, urls, statusMsg.id)
  } catch (error) {
    await bot.editMessage(chatId, {
      message: statusMsg.id,
      text: `❌ Error processing URLs: ${error.message}`,
    })
  }
}
