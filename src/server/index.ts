/**
 * Bang Story web server: runs the desktop app's main process (src/main) in plain Node and serves the
 * React renderer to a browser. The renderer's window.api becomes HTTP calls (src/web/api.ts):
 *
 *   POST /api/invoke/<channel>   one IPC call, JSON { args, upload? } → { ok, value } | { ok, error }
 *   POST /api/upload?name=…      raw file body; the id is passed to the next pick* call as `upload`
 *   GET  /api/events             server-sent events (job, clip, asset, … from src/main/events.ts)
 *   GET  /api/download?path=…    an exported MP4
 *   GET  /studio/<host>/<path>   the studio:// protocol (project assets, caption fonts), with Range
 *
 * Everything except the login page needs a session cookie (password from BANG_STORY_PASSWORD).
 */
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { basename, extname, join, normalize, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { closeDb, getDb } from '../main/db'
import { resumeJobs } from '../main/generation'
import { registerIpc } from '../main/ipc'
import { handleStudioProtocol } from '../main/protocol'
import { dataFolder, ipcHandlers, protocolHandlers, subscribe, withUpload } from './electron-shim'

const PORT = Number(process.env.PORT ?? 3200)
const HOST = process.env.HOST ?? '127.0.0.1'
const PASSWORD = process.env.BANG_STORY_PASSWORD ?? ''
const WEB_ROOT = resolve(process.env.BANG_STORY_WEB_ROOT ?? join(__dirname, '../web'))
const MAX_JSON = 100 * 1024 * 1024
const MAX_UPLOAD = 1024 * 1024 * 1024

if (PASSWORD.length < 8) {
  console.error('BANG_STORY_PASSWORD wajib diisi (minimal 8 karakter).')
  process.exit(1)
}

// ---- session --------------------------------------------------------------------------------------

const sessionKeyFile = join(dataFolder(), 'session.key')
if (!existsSync(sessionKeyFile)) writeFileSync(sessionKeyFile, randomBytes(32), { mode: 0o600 })
const sessionKey = readFileSync(sessionKeyFile)
// Changing the password signs everyone out, because the token is derived from it.
const sessionToken = createHmac('sha256', sessionKey).update(`session:${PASSWORD}`).digest('base64url')
const COOKIE = 'bs_session'

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

const authed = (req: IncomingMessage): boolean => safeEqual(cookies(req)[COOKIE] ?? '', sessionToken)
const isHttps = (req: IncomingMessage): boolean => req.headers['x-forwarded-proto'] === 'https'

// Slows down password guessing: each address gets a growing delay after failed attempts.
const failures = new Map<string, { count: number; at: number }>()
const clientIp = (req: IncomingMessage): string =>
  String(req.headers['cf-connecting-ip'] ?? req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0].trim()

const LOGIN_PAGE = (error: string): string => `<!doctype html>
<html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Masuk · Bang Story</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#FAF7F2;font:16px system-ui,sans-serif;color:#2B2622}
form{background:#fff;padding:32px;border-radius:16px;box-shadow:0 8px 30px #0001;width:300px;display:grid;gap:14px}
h1{margin:0;font-size:22px}input,button{font:inherit;padding:10px 12px;border-radius:10px;border:1px solid #ddd}
button{background:#E4572E;color:#fff;border:0;cursor:pointer;font-weight:600}.e{color:#c0392b;font-size:14px;margin:0}
</style></head><body>
<form method="post" action="/login"><h1>Bang Story</h1>
${error ? `<p class="e">${error}</p>` : ''}
<input type="password" name="password" placeholder="Kata sandi" autofocus required>
<button type="submit">Masuk</button></form></body></html>`

// ---- helpers --------------------------------------------------------------------------------------

function send(res: ServerResponse, status: number, body: string, type = 'text/plain; charset=utf-8'): void {
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) })
  res.end(body)
}

const json = (res: ServerResponse, status: number, value: unknown): void =>
  send(res, status, JSON.stringify(value), 'application/json; charset=utf-8')

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limit) throw new Error('Data terlalu besar')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

/** Streams a fetch-style Response (from the studio:// handler) into a Node response. */
async function pipeResponse(res: ServerResponse, r: Response): Promise<void> {
  const headers: Record<string, string> = {}
  r.headers.forEach((v, k) => (headers[k] = v))
  res.writeHead(r.status, headers)
  if (!r.body) return void res.end()
  await pipeline(Readable.fromWeb(r.body as import('node:stream/web').ReadableStream), res)
}

function inside(root: string, abs: string): boolean {
  return normalize(abs).startsWith(normalize(root) + sep)
}

// ---- uploads --------------------------------------------------------------------------------------

const uploadRoot = join(dataFolder(), 'tmp', 'uploads')
rmSync(uploadRoot, { recursive: true, force: true })
const uploads = new Map<string, { path: string; at: number }>()

function takeUpload(id: unknown): string[] {
  if (typeof id !== 'string') return []
  const u = uploads.get(id)
  return u ? [u.path] : []
}

function dropUpload(id: unknown): void {
  if (typeof id !== 'string') return
  const u = uploads.get(id)
  if (!u) return
  uploads.delete(id)
  rmSync(join(u.path, '..'), { recursive: true, force: true })
}

// Uploads that were never picked up (tab closed mid-way) are removed after an hour.
setInterval(() => {
  for (const [id, u] of uploads) if (Date.now() - u.at > 3_600_000) dropUpload(id)
}, 600_000).unref()

async function handleUpload(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  // Keep the original name: the app shows it as the asset's label (e.g. the music title).
  const name = basename(url.searchParams.get('name') ?? 'file').replace(/[^\p{L}\p{N} ._()-]/gu, '_').slice(0, 120) || 'file'
  const id = randomUUID()
  const dir = join(uploadRoot, id)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, name)
  const declared = Number(req.headers['content-length'] ?? 0)
  if (declared > MAX_UPLOAD) return json(res, 413, { ok: false, error: 'File terlalu besar (maksimal 1 GB)' })
  await pipeline(req, createWriteStream(path))
  uploads.set(id, { path, at: Date.now() })
  json(res, 200, { ok: true, id })
}

// ---- IPC over HTTP --------------------------------------------------------------------------------

async function handleInvoke(req: IncomingMessage, res: ServerResponse, channel: string): Promise<void> {
  const fn = ipcHandlers.get(channel)
  if (!fn) return json(res, 404, { ok: false, error: `Perintah tidak dikenal: ${channel}` })
  let body: { args?: unknown[]; upload?: string }
  try {
    body = JSON.parse((await readBody(req, MAX_JSON)).toString('utf8') || '{}')
  } catch (e) {
    return json(res, 400, { ok: false, error: (e as Error).message })
  }
  const args = Array.isArray(body.args) ? body.args : []
  try {
    const value = await withUpload(takeUpload(body.upload), () => fn(null, ...args))
    json(res, 200, { ok: true, value: value ?? null })
  } catch (e) {
    json(res, 200, { ok: false, error: (e as Error)?.message ?? String(e) })
  } finally {
    dropUpload(body.upload)
  }
}

function handleEvents(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Tells nginx-style proxies not to buffer the stream.
    'X-Accel-Buffering': 'no'
  })
  res.write('retry: 3000\n\n')
  const off = subscribe((channel, payload) => {
    res.write(`data: ${JSON.stringify({ channel, payload })}\n\n`)
  })
  // Proxies (Cloudflare) close idle connections; a comment line every 25 s keeps the stream open.
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000)
  req.on('close', () => {
    clearInterval(ping)
    off()
  })
}

function handleDownload(res: ServerResponse, url: URL): void {
  const path = resolve(url.searchParams.get('path') ?? '')
  // Exports land in the data folder (app.getPath('videos') → <data>/exports); nothing outside it is served.
  if (!inside(dataFolder(), path) || !existsSync(path) || !statSync(path).isFile()) return send(res, 404, 'Not found')
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': statSync(path).size,
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(basename(path))}`
  })
  createReadStream(path).pipe(res)
}

async function handleStudio(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const handler = protocolHandlers.get('studio')
  if (!handler) return send(res, 503, 'Not ready')
  // /studio/asset/<project>/<file> → studio://asset/<project>/<file>
  const headers = new Headers()
  if (req.headers.range) headers.set('range', req.headers.range)
  const r = await handler(new Request(`studio://${url.pathname.slice('/studio/'.length)}`, { headers }))
  await pipeResponse(res, r)
}

// ---- static renderer ------------------------------------------------------------------------------

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg'
}

function serveStatic(res: ServerResponse, url: URL): void {
  let path = normalize(join(WEB_ROOT, decodeURIComponent(url.pathname)))
  if (!inside(WEB_ROOT, path) || !existsSync(path) || !statSync(path).isFile()) path = join(WEB_ROOT, 'index.html')
  const hashed = path.includes(`${sep}assets${sep}`)
  res.writeHead(200, {
    'Content-Type': TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': statSync(path).size,
    'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache'
  })
  createReadStream(path).pipe(res)
}

// ---- router ---------------------------------------------------------------------------------------

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname

  if (path === '/login') {
    if (req.method !== 'POST') return send(res, 200, LOGIN_PAGE(''), 'text/html; charset=utf-8')
    const ip = clientIp(req)
    const f = failures.get(ip)
    if (f && f.count >= 5 && Date.now() - f.at < Math.min(2 ** (f.count - 5), 60) * 60_000) {
      return send(res, 429, LOGIN_PAGE('Terlalu banyak percobaan. Coba lagi beberapa menit lagi.'), 'text/html; charset=utf-8')
    }
    const password = new URLSearchParams((await readBody(req, 10_000)).toString('utf8')).get('password') ?? ''
    if (!safeEqual(password, PASSWORD)) {
      failures.set(ip, { count: (f?.count ?? 0) + 1, at: Date.now() })
      await new Promise((r) => setTimeout(r, 1000))
      return send(res, 401, LOGIN_PAGE('Kata sandi salah.'), 'text/html; charset=utf-8')
    }
    failures.delete(ip)
    const secure = isHttps(req) ? '; Secure' : ''
    res.writeHead(303, {
      Location: '/',
      'Set-Cookie': `${COOKIE}=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}${secure}`
    })
    return void res.end()
  }
  if (path === '/logout') {
    res.writeHead(303, { Location: '/login', 'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` })
    return void res.end()
  }

  if (!authed(req)) {
    if (path.startsWith('/api/') || path.startsWith('/studio/')) return json(res, 401, { ok: false, error: 'Sesi habis. Muat ulang halaman lalu masuk lagi.' })
    res.writeHead(303, { Location: '/login' })
    return void res.end()
  }

  if (path.startsWith('/api/')) {
    // Same-origin fetches only: a cross-site form cannot set this header, which blocks CSRF.
    if (req.method === 'POST' && req.headers['x-bang-story'] !== '1') return json(res, 403, { ok: false, error: 'Forbidden' })
    if (req.method === 'POST' && path.startsWith('/api/invoke/')) return handleInvoke(req, res, decodeURIComponent(path.slice('/api/invoke/'.length)))
    if (req.method === 'POST' && path === '/api/upload') return handleUpload(req, res, url)
    if (path === '/api/events') return handleEvents(req, res)
    if (path === '/api/download') return handleDownload(res, url)
    return json(res, 404, { ok: false, error: 'Not found' })
  }
  if (path.startsWith('/studio/')) return handleStudio(req, res, url)
  serveStatic(res, url)
}

// ---- start ----------------------------------------------------------------------------------------

getDb()
handleStudioProtocol()
registerIpc()
resumeJobs()

const server = createServer((req, res) => {
  route(req, res).catch((e) => {
    console.error(e)
    if (!res.headersSent) json(res, 500, { ok: false, error: 'Kesalahan server' })
    else res.destroy()
  })
})
server.requestTimeout = 0 // uploads and exports can take long
server.listen(PORT, HOST, () => console.log(`Bang Story web: http://${HOST}:${PORT} (data: ${dataFolder()})`))

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    server.close()
    closeDb()
    process.exit(0)
  })
}
