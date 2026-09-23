import { defineConfig } from 'vitest/config';

// Root (website + Edge gateway) test config. The desktop app has its own config
// under app/. Scope to src/** so this run never picks up the app's tests, which
// need the app's aliases and jsdom setup. The server adapters are pure and use
// only Web APIs, so the Node environment (Node 18+ has fetch/TextDecoder/
// ReadableStream globally) is all they need.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
  },
});
