/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// frontend3 dev server runs on 5175 so frontend2 (5174) can run alongside.
// Both proxy /api -> http://localhost:8000 (the live backend).
//
// VITE_BASE_PATH lets prod serve the SPA under a sub-path (prod fronts the app
// at acufy.ai/apps/timesheet/). Default '/' for dev + root deploys. Vite needs
// a trailing slash on `base`.
const basePath = process.env.VITE_BASE_PATH || '/';
export default defineConfig({
  base: basePath.endsWith('/') ? basePath : `${basePath}/`,
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5175,
    host: true,
    proxy: {
      // Backend mounts routes at root (/auth/login etc.). Strip /api here
      // so client calls like api.post('/auth/login') land on /auth/login
      // upstream. In prod, nginx does the same rewrite.
      '/api': {
        // Use 127.0.0.1 explicitly so Node doesn't resolve `localhost` to
        // ::1 (IPv6) on Windows — the backend only listens on IPv4.
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    css: true,
  },
});
