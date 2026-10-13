import { resolve } from 'node:path'
import { defineConfig } from 'vite'

/**
 * Web server build (`npm run web:build`): src/server/index.ts plus the whole src/main, with `electron`
 * swapped for src/server/electron-shim.ts. Dependencies stay in node_modules (better-sqlite3 must be
 * built for Node, not Electron — see docs/web.md).
 */
export default defineConfig({
  resolve: {
    alias: { '@shared': resolve('src/shared'), electron: resolve('src/server/electron-shim.ts') }
  },
  ssr: { noExternal: ['electron'] },
  build: {
    ssr: resolve('src/server/index.ts'),
    outDir: resolve('out/server'),
    emptyOutDir: true,
    target: 'node22',
    rollupOptions: { output: { format: 'cjs', entryFileNames: 'index.js' } }
  }
})
