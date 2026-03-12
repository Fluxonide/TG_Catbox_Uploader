import i18n from '../i18n/index.js'
import { bot } from '../../index.js'
import { handleCommand } from './command.js'
import { chatData, initChatData } from './data.js'
import { transfer, transferFromURL } from './transfer.js'
import type { NewMessageEvent } from 'telegram/events'

// Message handler
export async function handleMessage(event: NewMessageEvent) {
  const msg = event.message
  // Currently, only support private messages
  if (msg.peerId.className !== 'PeerUser') return
  const chatId = msg.peerId.userId.toString()

  // Check if the user has configured the bot
  initChatData(chatId)
  const lang = chatData[chatId].lang
  if (isCommand(msg.message)) await handleCommand(msg)
  else if (isURL(msg.message)) await transferFromURL(msg)
  else if (msg.media) await transfer(msg)
  else {
    bot
      .sendMessage(chatId, {
        message: i18n.t(lang, 'sendMeAFile'),
      })
      .catch(() => null)
  }
}

function isCommand(message: string) {
  return message.startsWith('/')
}
function isURL(message: string) {
  return message.startsWith('http://') || message.startsWith('https://')
}
