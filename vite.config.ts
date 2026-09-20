import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, loadEnv, type Plugin} from 'vite';

/**
 * Dev-only: Vite's SPA fallback answers a bare `/download` with the root
 * index.html, so a second page would only show up at `/download/`. Static
 * hosts resolve the directory index for both, so rewrite each here to keep dev
 * and production identical.
 */
const SUBPAGES = ['/download', '/chat', '/authentication'];

function extraPages(): Plugin {
  return {
    name: 'sylor-extra-pages',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        for (const base of SUBPAGES) {
          if (req.url === base || req.url?.startsWith(`${base}?`)) {
            req.url = `${base}/index.html` + (req.url.slice(base.length) || '');
            break;
          }
        }
        next();
      });
    },
  };
}

/**
 * Dev-only: serve `/api/chat` from the same runtime-agnostic handler that runs
 * as a Vercel Edge function in production, so `npm run dev` and the preview
 * tools exercise the real gateway. Adapts Node's req/res to the Web
 * Request/Response the handler speaks. In production Vercel routes `/api/*`
 * to the function directly and this middleware never runs.
 */
function apiDev(): Plugin {
  return {
    name: 'sylor-api-dev',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url || '';
        if (url !== '/api/chat' && !url.startsWith('/api/chat?')) return next();

        void (async () => {
          try {
            const { handleChat } = await import('./src/server/gateway');

            const chunks: Buffer[] = [];
            for await (const c of req) chunks.push(c as Buffer);
            const raw = chunks.length ? Buffer.concat(chunks).toString('utf8') : undefined;

            const headers = new Headers();
            for (const [k, v] of Object.entries(req.headers)) {
              if (Array.isArray(v)) for (const vv of v) headers.append(k, vv);
              else if (v != null) headers.set(k, v);
            }

            const proto = (req.headers['x-forwarded-proto'] as string) || 'http';
            const host = req.headers.host || 'localhost';
            const method = req.method || 'GET';
            const request = new Request(`${proto}://${host}${url}`, {
              method,
              headers,
              body: raw && method !== 'GET' && method !== 'HEAD' ? raw : undefined,
            });

            const response = await handleChat(request);
            res.statusCode = response.status;
            response.headers.forEach((value, key) => res.setHeader(key, value));

            if (response.body) {
              const reader = response.body.getReader();
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                res.write(Buffer.from(value));
                // Flush each SSE chunk so tokens reach the browser as they stream.
                (res as { flush?: () => void }).flush?.();
              }
            }
            res.end();
          } catch (err) {
            res.statusCode = 500;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ error: 'dev_gateway', detail: String(err) }));
          }
        })();
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  // Load every env var (empty prefix, not just VITE_) from .env* and expose it to
  // the dev gateway middleware via process.env — SYLOR_* (tools kill-switch, max tokens).
  const env = loadEnv(mode, process.cwd(), '');
  Object.assign(process.env, env);

  return {
    plugins: [react(), tailwindcss(), extraPages(), apiDev()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    build: {
      // Real HTML pages, so /download and /chat are their own documents rather
      // than client-side routes. Vercel serves dist/<page>/index.html at /<page>
      // with no rewrite rules needed.
      rollupOptions: {
        input: {
          main: path.resolve(__dirname, 'index.html'),
          download: path.resolve(__dirname, 'download/index.html'),
          chat: path.resolve(__dirname, 'chat/index.html'),
          authentication: path.resolve(__dirname, 'authentication/index.html'),
        },
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
