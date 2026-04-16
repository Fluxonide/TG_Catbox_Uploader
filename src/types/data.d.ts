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
  abortController?: AbortController
}

export interface UserData {
  lang: string
  downloading: number
  total: number
  banned: boolean
  batchProgress?: BatchProgressState
}
