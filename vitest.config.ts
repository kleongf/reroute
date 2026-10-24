import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@backend': fileURLToPath(new URL('./src', import.meta.url)),
      '@': fileURLToPath(new URL('./web/src', import.meta.url)),
    },
  },
  test: {
    include: [
      'src/**/*.test.ts',
      'scripts/**/*.test.ts',
      'public/**/*.test.js',
      'web/src/**/*.test.ts',
    ],
    environment: 'node',
  },
});
