import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * Browser build of the renderer (`npm run web:build`). Same React app as the desktop build, plus:
 * - the page entry is src/web/main.ts, which installs the HTTP window.api before the app starts
 * - caption fonts load from /studio/fonts/ (the web server) instead of the studio:// protocol
 */
function webEntry(): Plugin {
  const entry = resolve('src/web/main.ts')
  return {
    name: 'bang-story-web',
    enforce: 'pre',
    resolveId(id, importer) {
      if (id === '/src/main.tsx' && importer?.endsWith('index.html')) return entry
      return null
    },
    transform(code, id) {
      if (id.endsWith('styles.css')) return code.replaceAll('studio://fonts/', '/studio/fonts/')
      return null
    }
  }
}

export default defineConfig({
  root: 'src/renderer',
  base: '/',
  resolve: {
    alias: { '@shared': resolve('src/shared'), '@renderer': resolve('src/renderer/src') }
  },
  plugins: [webEntry(), react(), tailwindcss()],
  build: {
    outDir: resolve('out/web'),
    emptyOutDir: true
  }
})
