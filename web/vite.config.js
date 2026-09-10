import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    cssCodeSplit: false,
    modulePreload: false,
    rollupOptions: { output: { entryFileNames: 'app.js', chunkFileNames: 'assets/[name]-[hash].js', assetFileNames: 'app.[ext]' } },
  },
  server: { proxy: { '/ws': { target: 'ws://127.0.0.1:8080', ws: true }, '/api': 'http://127.0.0.1:8080', '/mcp': 'http://127.0.0.1:8080' } },
});
