/// <reference types="vitest/config" />
import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    // The minimal backend (pnpm server) answers /api/*; the HELIOS data API (Python, FastAPI) answers /v1/*.
    // Same origin through the proxy, no CORS needed. Override the HELIOS address with HELIOS_API_ORIGIN.
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: false },
      '/v1': { target: process.env.HELIOS_API_ORIGIN || 'http://127.0.0.1:8000', changeOrigin: true },
    },
  },
  build: {
    target: 'es2022',
    // MapLibre (~800 kB) and three.js are split into their own lazy chunks on purpose.
    chunkSizeWarningLimit: 1100,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts', 'server/**/*.test.ts'],
  },
});
