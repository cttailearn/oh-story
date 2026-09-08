import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// 客户端构建：root=client。dev 时 Vite 起 5173，/api 代理到后端 3081。
export default defineConfig({
  root: 'client',
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./client/src', import.meta.url)),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3081',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: '../dist/client',
    emptyOutDir: true,
    // 首屏优化：把体积最大的三方库拆成独立 chunk（原先单个 1.1MB bundle，首次访问全量下载）。
    // 只做「叶子」切分（codemirror 不依赖其它 node_modules），避免 rollup 的 circular chunk 告警。
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('@codemirror') || id.includes('@lezer') || id.includes('/codemirror/')) return 'codemirror';
          return 'vendor';
        },
      },
    },
  },
});
