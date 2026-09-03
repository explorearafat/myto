import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, type Plugin} from 'vite';

/**
 * Dev-only: Vite's SPA fallback answers a bare `/download` with the root
 * index.html, so the second page would only show up at `/download/`. Static
 * hosts resolve the directory index for both, so rewrite it here to keep dev
 * and production identical.
 */
function extraPages(): Plugin {
  return {
    name: 'sylor-extra-pages',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.url === '/download' || req.url?.startsWith('/download?')) {
          req.url = '/download/index.html' + (req.url.slice('/download'.length) || '');
        }
        next();
      });
    },
  };
}

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss(), extraPages()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    build: {
      // Two real HTML pages, so /download is its own document rather than a
      // client-side route. Vercel serves dist/download/index.html at /download
      // with no rewrite rules needed.
      rollupOptions: {
        input: {
          main: path.resolve(__dirname, 'index.html'),
          download: path.resolve(__dirname, 'download/index.html'),
        },
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
