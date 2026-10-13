/**
 * Browser version of window.api (the desktop app gets it from src/preload). Every call becomes
 * POST /api/invoke/<channel> on the web server (src/server/index.ts); events arrive over one
 * EventSource. Loaded before the renderer's main.tsx by vite.web.config.ts, so the renderer is unchanged.
 */
import { EVENTS, type StudioApi } from '../shared/api'

// Group names in window.api that differ from the IPC channel prefix.
const PREFIX: Record<string, string> = { exporter: 'export' }

/** Assets and fonts are served under /studio/ instead of the desktop's studio:// protocol. */
function rewriteUrls<T>(value: T): T {
  if (typeof value === 'string') return (value.startsWith('studio://') ? `/studio/${value.slice(9)}` : value) as T
  if (Array.isArray(value)) return value.map(rewriteUrls) as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = rewriteUrls(v)
    return out as T
  }
  return value
}

async function invoke<T>(channel: string, args: unknown[], upload?: string): Promise<T> {
  const res = await fetch(`/api/invoke/${encodeURIComponent(channel)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Bang-Story': '1' },
    body: JSON.stringify({ args, upload })
  })
  if (res.status === 401) {
    location.href = '/login'
    throw new Error('Sesi habis. Silakan masuk lagi.')
  }
  const body = (await res.json().catch(() => null)) as { ok: boolean; value?: T; error?: string } | null
  if (!body) throw new Error(`Server tidak merespons dengan benar (HTTP ${res.status})`)
  if (!body.ok) throw new Error(body.error ?? 'Terjadi kesalahan')
  return rewriteUrls(body.value as T)
}

/** Lets the user choose a file, uploads it, and returns the upload id (null when cancelled). */
function pickAndUpload(accept: string): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return resolve(null)
      try {
        const res = await fetch(`/api/upload?name=${encodeURIComponent(file.name)}`, {
          method: 'POST',
          headers: { 'X-Bang-Story': '1', 'Content-Type': 'application/octet-stream' },
          body: file
        })
        const body = (await res.json()) as { ok: boolean; id?: string; error?: string }
        if (!body.ok || !body.id) throw new Error(body.error ?? 'Upload gagal')
        resolve(body.id)
      } catch (e) {
        reject(e)
      }
    }
    // Browsers fire "cancel" when the picker is closed without a file.
    input.addEventListener('cancel', () => resolve(null))
    input.click()
  })
}

async function pickFile<T>(channel: string, accept: string, projectId: string): Promise<T | null> {
  const upload = await pickAndUpload(accept)
  if (!upload) return null
  return invoke<T>(channel, [projectId], upload)
}

async function copyText(text: string): Promise<void> {
  // navigator.clipboard only exists on https or localhost; fall back to the old copy command elsewhere.
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text)
  const area = document.createElement('textarea')
  area.value = text
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  document.execCommand('copy')
  area.remove()
}

// ---- events ---------------------------------------------------------------------------------------

type Callback = (payload: unknown) => void
const callbacks = new Map<string, Set<Callback>>()
let source: EventSource | null = null

function connect(): void {
  if (source) return
  source = new EventSource('/api/events')
  source.onmessage = (e) => {
    const { channel, payload } = JSON.parse(e.data) as { channel: string; payload: unknown }
    for (const cb of callbacks.get(channel) ?? []) cb(rewriteUrls(payload))
  }
}

const listen =
  (channel: string) =>
  (cb: Callback): (() => void) => {
    connect()
    if (!callbacks.has(channel)) callbacks.set(channel, new Set())
    callbacks.get(channel)!.add(cb)
    return () => callbacks.get(channel)?.delete(cb)
  }

// ---- window.api -----------------------------------------------------------------------------------

/** Methods that need the browser instead of the server (files, clipboard, links, downloads). */
const overrides: Record<string, Record<string, (...args: never[]) => unknown>> = {
  assets: {
    pickMusic: (projectId: string) => pickFile('assets:pickMusic', 'audio/mpeg,audio/wav,audio/mp4,audio/ogg,.mp3,.wav,.m4a,.ogg', projectId),
    pickImage: (projectId: string) => pickFile('assets:pickImage', 'image/png,image/jpeg,image/webp', projectId)
  },
  exporter: {
    // Exports always go to the server's data folder; the result is downloaded instead of shown in a folder.
    pickFolder: async () => null,
    reveal: async (path: string) => {
      const a = document.createElement('a')
      a.href = `/api/download?path=${encodeURIComponent(path)}`
      a.download = ''
      a.click()
    }
  },
  app: {
    openExternal: async (url: string) => {
      if (/^https:\/\//i.test(url)) window.open(url, '_blank', 'noopener')
    },
    copyText: (text: string) => copyText(String(text))
  },
  whisper: {
    openFolder: async () => {}
  }
}

const on = {
  whisper: listen(EVENTS.whisper),
  job: listen(EVENTS.job),
  clip: listen(EVENTS.clip),
  character: listen(EVENTS.character),
  asset: listen(EVENTS.asset)
}

const group = (name: string): Record<string, unknown> =>
  new Proxy(
    {},
    {
      get: (_t, method: string) =>
        overrides[name]?.[method] ?? ((...args: unknown[]) => invoke(`${PREFIX[name] ?? name}:${method}`, args))
    }
  )

window.api = new Proxy({} as StudioApi, {
  get: (_t, name: string) => (name === 'on' ? on : group(name))
})
