import { bot } from '../../index.js'
import { chatData } from './data.js'
import { transferSingleURL } from './transfer.js'
import * as buttons from './buttons.js'
import type { Api } from 'telegram'

// Semaphore to limit concurrency
class Semaphore {
  private queue: Array<() => void> = []
  constructor(private slots: number) {}

  async acquire(): Promise<void> {
    if (this.slots > 0) {
      this.slots--
      return
    }
    await new Promise<void>(resolve => this.queue.push(resolve))
  }

  release(): void {
    if (this.queue.length > 0) {
      this.queue.shift()!()
    } else {
      this.slots++
    }
  }
}

// Global upload semaphore — Telegram allows ~1 upload/sec per bot
// Using 2 to allow slight overlap without hitting flood limits
const uploadSem = new Semaphore(2)

function secToTime(sec: number) {
  if (!isFinite(sec) || sec < 0) return '00:00:00'
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  return [h, m, s].map(v => v.toString().padStart(2, '0')).join(':')
}

function buildProgressBar(percent: number, length = 20): string {
  const filled = Math.round((Math.max(0, Math.min(100, percent)) / 100) * length)
  return '█'.repeat(filled) + '░'.repeat(length - filled)
}

export interface BatchProgressState {
  completed: number
  failed: number
  failedUrls: Array<{ index: number; url: string; error: string }>
  startTime: number
  totalUrls: number
  statusMsgId: number
  chat: number
  isComplete: boolean
  isCancelled: boolean
}

export async function runBatch(msg: Api.Message, urls: string[], statusMsgId: number) {
  const chat = (msg.peerId as any).userId.toJSNumber()

  const progressState: BatchProgressState = {
    completed: 0,
    failed: 0,
    failedUrls: [],
    startTime: Date.now(),
    totalUrls: urls.length,
    statusMsgId,
    chat,
    isComplete: false,
    isCancelled: false,
  }

  chatData[chat].batchProgress = progressState

  const updateProgress = async () => {
    if (progressState.isComplete) return
    const done = progressState.completed + progressState.failed
    const pct = Math.round((done / progressState.totalUrls) * 100)
    const elapsed = (Date.now() - progressState.startTime) / 1000
    const avg = done > 0 ? elapsed / done : 0
    const eta = Math.round(avg * (progressState.totalUrls - done))

    let text = `<b>📥 Batch Download</b>\n\n`
    text += `✅ ${progressState.completed} | ❌ ${progressState.failed} | 📊 ${done}/${progressState.totalUrls}\n`
    text += `<code>[${buildProgressBar(pct)}]</code> ${pct}%\n`
    text += `⏱ ETA: <code>${secToTime(eta)}</code>`

    if (progressState.failedUrls.length > 0 && progressState.failedUrls.length <= 5) {
      text +=
        `\n\n<b>❌ Failed:</b>\n` +
        progressState.failedUrls
          .slice(0, 5)
          .map(f => `${f.index + 1}. ${f.error}`)
          .join('\n')
    } else if (progressState.failedUrls.length > 5) {
      text += `\n\n<b>❌ ${progressState.failedUrls.length} failed</b>`
    }

    await bot
      .editMessage(chat, {
        message: statusMsgId,
        text,
        parseMode: 'html',
        linkPreview: false,
        buttons: buttons.refreshProgress(chat),
      })
      .catch(() => {})
  }

  // Auto-update every 5 seconds
  const progressInterval = setInterval(() => updateProgress(), 5000)

  // --- Parallel pipeline ---
  // Download concurrency: 3 (HTTP fetches are cheap on RAM)
  // Upload is gated by the global semaphore (max 2 at a time)
  const DOWNLOAD_CONCURRENCY = 3

  // Process in chunks of DOWNLOAD_CONCURRENCY
  for (let i = 0; i < urls.length; i += DOWNLOAD_CONCURRENCY) {
    if (progressState.isCancelled) break

    const chunk = urls.slice(i, i + DOWNLOAD_CONCURRENCY)

    // Kick off all downloads in this chunk in parallel
    await Promise.all(
      chunk.map(async (url, j) => {
        const idx = i + j
        if (progressState.isCancelled) return

        try {
          // Acquire upload slot before starting (so we don't download faster than we upload)
          await uploadSem.acquire()

          try {
            const result = await transferSingleURL(msg, url, idx + 1, urls.length, statusMsgId)

            if (result) {
              progressState.completed++
            } else {
              progressState.failed++
              progressState.failedUrls.push({ index: idx, url, error: 'File too big or empty' })
            }
          } finally {
            uploadSem.release()
          }
        } catch (err: any) {
          progressState.failed++
          progressState.failedUrls.push({ index: idx, url, error: err.message || 'Unknown error' })
          console.error(`[${idx + 1}/${urls.length}] Error: ${err.message}`)
        }
      }),
    )
  }

  clearInterval(progressInterval)
  progressState.isComplete = true

  // Final summary
  const totalElapsed = (Date.now() - progressState.startTime) / 1000
  const totalProcessed = progressState.completed + progressState.failed

  let finalText = progressState.isCancelled
    ? `<b>🛑 Batch Cancelled!</b>\n\n`
    : `<b>✅ Batch Complete!</b>\n\n`

  finalText += `📊 ${progressState.completed}/${urls.length} successful`
  if (progressState.failed > 0) finalText += ` | ❌ ${progressState.failed} failed`
  if (progressState.isCancelled) finalText += ` | ⏭ ${urls.length - totalProcessed} skipped`
  finalText += `\n⏱ Total time: <code>${secToTime(Math.round(totalElapsed))}</code>`

  if (progressState.failedUrls.length > 0) {
    const list = progressState.failedUrls
      .slice(0, 10)
      .map(f => `${f.index + 1}. ${f.error}`)
      .join('\n')
    finalText += `\n\n<b>❌ Failed:</b>\n${list}`
    if (progressState.failedUrls.length > 10)
      finalText += `\n... and ${progressState.failedUrls.length - 10} more`
  }

  await bot
    .editMessage(chat, {
      message: statusMsgId,
      text: finalText,
      parseMode: 'html',
      linkPreview: false,
    })
    .catch(() => {})

  delete chatData[chat].batchProgress
}
