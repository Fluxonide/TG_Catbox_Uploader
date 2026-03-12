import { writeFileSync, readFileSync, existsSync } from 'fs'
import { log } from './data.js'

let urlCache: Map<string, string> = new Map()

export function loadUrlCache() {
  log('Loading URL cache...')
  if (existsSync('./data/urlCache.json')) {
    try {
      const data = JSON.parse(readFileSync('./data/urlCache.json', 'utf-8'))
      urlCache = new Map(Object.entries(data))
    } catch (e) {
      log(`Error loading URL cache: ${e.message}`)
      urlCache = new Map()
    }
  }
  log(`Loaded ${urlCache.size} cached URLs`)
}

export function saveUrlCache() {
  try {
    writeFileSync('./data/urlCache.json', JSON.stringify(Object.fromEntries(urlCache)))
  } catch (e) {
    log(`Error saving URL cache: ${e.message}`)
  }
}

export function getCachedUrl(originalUrl: string): string | undefined {
  return urlCache.get(originalUrl)
}

export function setCachedUrl(originalUrl: string, catboxUrl: string) {
  urlCache.set(originalUrl, catboxUrl)
  // Save per-item, could be batched but fine for now
  saveUrlCache()
}
