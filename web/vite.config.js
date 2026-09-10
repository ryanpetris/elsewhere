import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// audioMotion 4.5.4's click listener outlives destroy(); the viewer owns context resumption.
function patchAudioMotion(code) {
  const listener = 'window.addEventListener( EVENT_CLICK, unlockContext );';
  if (!code.includes(listener)) throw new Error('Recheck audioMotion context ownership for this version');
  return code.replace(listener, '// Modified by elsewhere: playback owner resumes the shared context.');
}
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss(), {
    name: 'audio-context-ownership',
    transform(code, id) {
      if (id.endsWith('/audiomotion-analyzer/src/audioMotion-analyzer.js')) return patchAudioMotion(code);
    },
  }],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    cssCodeSplit: false,
    modulePreload: false,
    rollupOptions: { output: { entryFileNames: 'app.js', chunkFileNames: 'assets/[name]-[hash].js', assetFileNames: 'app.[ext]' } },
  },
  server: { proxy: { '/ws': { target: 'ws://127.0.0.1:8080', ws: true }, '/api': 'http://127.0.0.1:8080', '/mcp': 'http://127.0.0.1:8080' } },
});
