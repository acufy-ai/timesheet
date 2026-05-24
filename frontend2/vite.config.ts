import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// frontend2 — minimal config. Hardcoded proxy + port so we don't depend
// on env file load order. The user controls the port by editing this file.
export default defineConfig({
  base: '/',
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  server: {
    port: 5176,
    strictPort: true,
    host: '127.0.0.1',
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
    },
  },
});
