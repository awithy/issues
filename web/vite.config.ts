import 'dotenv/config';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  build: { outDir: '../dist/web', emptyOutDir: true },
  server: { host: '127.0.0.1', port: 5173, proxy: { '/api': { target: 'http://127.0.0.1:' + (process.env.PORT || 3031), changeOrigin: false } } },
});
