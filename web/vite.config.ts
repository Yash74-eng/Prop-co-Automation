import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    // In dev the UI runs on 5174 and proxies API calls to the Express server on 5173.
    proxy: {
      '/api': {
        target: process.env.API_TARGET ?? 'http://localhost:5173',
        changeOrigin: true,
      },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
