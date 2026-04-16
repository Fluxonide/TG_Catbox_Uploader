import i18n from '../i18n/index.js'
import * as buttons from './buttons.js'
import { bot } from '../../index.js'
import { chatData, initChatData, saveBotData } from './data.js'
import type { Api } from 'telegram'
import type { CallbackQueryEvent } from 'telegram/events/CallbackQuery.js'

// Callback query handler
// I use callback queries in the format of: [callback function]_[argument]
export async function handleCallbackQuery(event: CallbackQueryEvent) {
  if (event.query.className !== 'UpdateBotCallbackQuery') return

  const query = event.query
  const chat = query.userId.toJSNumber()
  const data = query.data?.toString() || ''
  const arg = data.includes('_') ? data.slice(data.indexOf('_') + 1) : null
  initChatData(chat)
  let lang = chatData[chat].lang

  // Buttons, Text
  let bt: Api.KeyboardButtonCallback[][] = [],
    text = '🐱 Blank'
  if (data.startsWith('setLang')) {
    if (arg) chatData[chat].lang = lang = arg
    else {
      bt = buttons.setLanguage(lang)
      text = `<b>${i18n.t(lang, 'settings_setLang')}</b>\n\n` + i18n.t(lang, 'help_setLang')
    }
  } else if (data.startsWith('refresh')) {
    // Handle refresh button for batch progress
    const progressState = chatData[chat].batchProgress
    if (progressState && !progressState.isComplete) {
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

      text = `<b>📥 Batch Download</b>\n\n`
      text += `✅ ${progressState.completed} | ❌ ${progressState.failed} | 📊 ${totalProcessed}/${progressState.totalUrls}\n`
      text += `<code>[${buildProgressBar(progress)}]</code> ${progress}%\n`
      text += `⏱ ETA: <code>${secToTime(eta)}</code>`

      if (progressState.failedUrls.length > 0 && progressState.failedUrls.length <= 5) {
        const failedList = progressState.failedUrls
          .slice(0, 5)
          .map((f: any) => `${f.index + 1}. ${f.error}`)
          .join('\n')
        text += `\n\n<b>❌ Failed:</b>\n${failedList}`
      } else if (progressState.failedUrls.length > 5) {
        text += `\n\n<b>❌ ${progressState.failedUrls.length} failed</b>`
      }

      bt = buttons.refreshProgress(chat)

      bot
        .editMessage(chat, {
          message: query.msgId,
          text: text,
          parseMode: 'html',
          linkPreview: false,
          buttons: bt,
        })
        .catch()
      await event.answer({ message: '🔄 Refreshed!' })
      return
    } else {
      await event.answer({ message: 'No active batch download' })
      return
    }
  }
  saveBotData()
  if (!bt.length) {
    bt = buttons.mainSettings(chat)
    text = `<b>${i18n.t(lang, 'settings')}</b>\n\n` + i18n.t(lang, 'help_settings')
  }
  bot
    .editMessage(chat, {
      message: query.msgId,
      text: text,
      parseMode: 'html',
      linkPreview: false,
      buttons: bt,
    })
    .catch()
  await event.answer({ message: arg ? i18n.t(lang, 'setSuccess') : '' })
}
