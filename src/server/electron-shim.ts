/**
 * Stand-in for the `electron` module when src/main runs inside the web server (vite.server.config.ts
 * aliases `electron` to this file). It implements only what src/main uses outside index.ts and
 * devharness.ts, so the desktop code runs unchanged:
 *
 * - ipcMain.handle   → registry the HTTP server dispatches `/api/invoke/<channel>` to
 * - BrowserWindow    → one fake window whose webContents.send fans events out to browser tabs (SSE)
 * - protocol.handle  → the studio:// handler, served by the HTTP server under /studio/
 * - dialog           → returns the file the browser just uploaded (see withUpload)
 * - safeStorage      → AES-256-GCM with a key file in the data folder (no OS keychain on a server)
 * - shell/clipboard  → no-ops; the browser does these itself (src/web/api.ts)
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// ---- app ------------------------------------------------------------------------------------------

const appRoot = resolve(process.env.BANG_STORY_APP_ROOT ?? process.cwd())
const dataRoot = resolve(process.env.BANG_STORY_DATA ?? join(appRoot, 'web-data'))
mkdirSync(dataRoot, { recursive: true })

const version = (): string => {
  try {
    return (JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8')) as { version: string }).version
  } catch {
    return '0.0.0'
  }
}

export const app = {
  // false keeps paths pointing at the repo's resources/ folder and enables the STUDIO_* env overrides.
  isPackaged: false,
  getAppPath: (): string => appRoot,
  getVersion: version,
  getPath(name: string): string {
    if (name === 'userData' || name === 'appData') return dataRoot
    if (name === 'videos') return join(dataRoot, 'exports')
    if (name === 'temp') return tmpdir()
    return dataRoot
  }
}

// ---- IPC ------------------------------------------------------------------------------------------

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown
export const ipcHandlers = new Map<string, IpcHandler>()

export const ipcMain = {
  handle(channel: string, fn: IpcHandler): void {
    ipcHandlers.set(channel, fn)
  }
}

// ---- events (main → renderer) ---------------------------------------------------------------------

type Listener = (channel: string, payload: unknown) => void
const listeners = new Set<Listener>()

/** Subscribes a browser tab (an SSE stream) to everything src/main sends to its windows. */
export function subscribe(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

const serverWindow = {
  isDestroyed: (): boolean => false,
  webContents: {
    send(channel: string, payload: unknown): void {
      for (const fn of listeners) fn(channel, payload)
    }
  }
}

export const BrowserWindow = {
  getAllWindows: (): (typeof serverWindow)[] => [serverWindow],
  getFocusedWindow: (): typeof serverWindow => serverWindow
}

// ---- studio:// protocol ---------------------------------------------------------------------------

type ProtocolHandler = (req: Request) => Response | Promise<Response>
export const protocolHandlers = new Map<string, ProtocolHandler>()

export const protocol = {
  registerSchemesAsPrivileged(): void {},
  handle(scheme: string, fn: ProtocolHandler): void {
    protocolHandlers.set(scheme, fn)
  }
}

// ---- dialog ---------------------------------------------------------------------------------------

/**
 * A browser cannot hand the server a path on the user's disk. The browser uploads the file first, and
 * the IPC call that would have opened a file dialog runs inside withUpload, so showOpenDialog "picks"
 * the uploaded copy. Without an upload (e.g. the export folder picker) the dialog counts as cancelled.
 */
const pickedFiles = new AsyncLocalStorage<string[]>()

export function withUpload<T>(filePaths: string[], fn: () => T): T {
  return pickedFiles.run(filePaths, fn)
}

export const dialog = {
  async showOpenDialog(): Promise<{ canceled: boolean; filePaths: string[] }> {
    const files = pickedFiles.getStore() ?? []
    return { canceled: files.length === 0, filePaths: files }
  }
}

// ---- safeStorage ----------------------------------------------------------------------------------

const keyFile = join(dataRoot, 'secrets.key')
let secretKey: Buffer | null = null

function key(): Buffer {
  if (secretKey) return secretKey
  if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32), { mode: 0o600 })
  secretKey = readFileSync(keyFile)
  return secretKey
}

export const safeStorage = {
  isEncryptionAvailable: (): boolean => true,
  encryptString(text: string): Buffer {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key(), iv)
    const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), body])
  },
  decryptString(value: Buffer): string {
    const decipher = createDecipheriv('aes-256-gcm', key(), value.subarray(0, 12))
    decipher.setAuthTag(value.subarray(12, 28))
    return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8')
  }
}

// ---- shell / clipboard ----------------------------------------------------------------------------

export const shell = {
  openExternal: async (): Promise<void> => {},
  openPath: async (): Promise<string> => '',
  showItemInFolder: (): void => {}
}

export const clipboard = {
  writeText: (): void => {}
}

export const dataFolder = (): string => dataRoot
