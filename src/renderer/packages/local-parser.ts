import { featureFlags } from '@/utils/feature-flags'
import { fetchWithProxy } from '@/utils/request'
import { v4 as uuidv4 } from 'uuid'
import platform from '@/platform'
import * as remote from './remote'

export async function parseTextFile(file: File, options: { maxLength?: number } = {}) {
  let text = await file.text()
  if (options.maxLength) {
    text = text.trim().slice(0, options.maxLength)
  }
  const key = `parseFile-` + uuidv4()
  await platform.setStoreBlob(key, text)
  return { key }
}

export async function parseUrl(url: string) {
  let result: { text: string; title: string }
  if (featureFlags.chatboxAI) {
    result = await remote.parseUserLinkFree({ url })
  } else {
    const target = new URL(url)
    if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Unsupported webpage URL')
    const response = await fetchWithProxy(target, { headers: { Accept: 'text/html, text/plain' } })
    const content = await response.text()
    if (response.headers.get('content-type')?.includes('text/html')) {
      const document = new DOMParser().parseFromString(content, 'text/html')
      document.querySelectorAll('script, style, noscript, iframe').forEach((node) => node.remove())
      result = { title: document.title || url, text: document.body?.textContent?.trim() || '' }
    } else {
      result = { title: url, text: content }
    }
  }
  const key = `parseUrl-` + uuidv4()
  await platform.setStoreBlob(key, result.text)
  return { key, title: result.title }
}
