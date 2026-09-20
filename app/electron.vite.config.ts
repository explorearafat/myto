import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') },
        // package.json is `"type": "module"`, so a `.js`/`.mjs` preload is ESM —
        // which Electron REFUSES to load when `sandbox: true`. Force CommonJS with
        // a `.cjs` extension (unconditionally CJS regardless of package type) so the
        // sandboxed preload loads and `window.sylor` is actually exposed.
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [
      react(),
      tailwindcss(),
      // Vite tags the emitted <script>/<link> with `crossorigin`, which forces
      // CORS mode on the module fetch — hostile to the packaged file:// load
      // (opaque origin, no CORS headers) and a cause of a blank window. Strip it
      // from the built HTML. Dev is served over http and is unaffected.
      {
        name: 'sylor-strip-crossorigin',
        transformIndexHtml: (html: string): string => html.replace(/\s+crossorigin/g, '')
      }
    ],
    build: {
      rollupOptions: {
        input: { index: resolve('src/renderer/index.html') }
      }
    },
    // ES-format workers so Monaco's worker chunks resolve correctly under file:// in prod.
    worker: { format: 'es' }
  }
})
