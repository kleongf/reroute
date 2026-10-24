import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const BACKEND = process.env['BACKEND_URL'] ?? 'http://127.0.0.1:3000';
const proxied = ['/api', '/events', '/tools', '/webhooks', '/health'];

// Served by Hono at /next (see src/app.ts); built into <repo>/dist/web.
export default defineConfig({
  base: '/next/',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@backend': fileURLToPath(new URL('../src', import.meta.url)),
    },
  },
  build: {
    outDir: fileURLToPath(new URL('../dist/web', import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    proxy: Object.fromEntries(proxied.map((path) => [path, { target: BACKEND }])),
  },
});
