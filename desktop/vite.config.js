import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite 只负责构建渲染进程（renderer）的 React 前端
// 主进程（main.js / preload.js）是纯 Node，不经过 Vite
export default defineConfig({
  plugins: [react()],
  root: '.',
  base: './',
  build: {
    outDir: 'dist-renderer',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
