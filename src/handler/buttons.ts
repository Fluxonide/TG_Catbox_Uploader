import i18n from '../i18n/index.js'
import { Button } from 'telegram/tl/custom/button.js'
import { chatData } from './data.js'
import type { Api } from 'telegram'

// Shorthand for the buttons
function cb(text: string, data: string) {
  return Button.inline(text, Buffer.from(data))
}

// The main menu of settings
const mainSettings = (chat: string | number) => {
  const lang = chatData[chat].lang

  return [
    [cb(i18n.t(lang, 'settings_setLang') + ` (${i18n.t(lang, 'name')})`, 'setLang')],
  ]
}

// Set the language of the bot
const setLanguage = (lang: string) => {
  const buttons: Api.KeyboardButtonCallback[][] = []
  let tmp: Api.KeyboardButtonCallback[] = []

  for (const _lang of i18n.languages) {
    tmp.push(cb(i18n.t(_lang, 'name') + (_lang === lang ? ' ✅' : ''), `setLang_${_lang}`))
    if (tmp.length === 2) {
      buttons.push(tmp)
      tmp = []
    }
  }
  if (tmp.length > 0) buttons.push(tmp)
  buttons.push(back(lang)[0])
  return buttons
}


// Back button
const back = (lang: string) => {
  return [[cb(i18n.t(lang, 'settings_back'), 'back')]]
}

// Refresh button for batch progress
const refreshProgress = (chat: string | number) => {
  return [[cb('🔄 Refresh Status', `refresh_${chat}`)]]
}

export {
  setLanguage,
  mainSettings,
  back,
  refreshProgress,
}
