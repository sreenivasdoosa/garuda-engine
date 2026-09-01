import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react-swc';
import path from 'path';

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const backendUrl = env.VITE_BACKEND_URL || 'http://localhost:8080';
  const isHttps = backendUrl.startsWith('https');
  const wsUrl = backendUrl.replace(/^http/, 'ws');

  return {
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  css: {
    preprocessorOptions: {
      scss: {
        api: 'modern-compiler',
        additionalData: `@use "@/styles/_variables.scss" as *;`,
      },
    },
  },
  server: {
    port: 4000,
    watch: {
      // Polling instead of inotify: on Linux, a file replaced via atomic
      // rename (sed -i, codemod scripts, some editor save modes) gets a NEW
      // inode and silently orphans its inotify watch — subsequent edits to
      // that file never trigger HMR until the dev server restarts. Polling
      // is immune to lost subscriptions and cheap at this repo size.
      usePolling: true,
      interval: 300,
    },
    proxy: {
      '/api/v2': {
        target: backendUrl,
        changeOrigin: true,
        secure: isHttps,
      },
      '/apis': {
        target: backendUrl,
        changeOrigin: true,
        secure: isHttps,
      },
      '/socket': {
        target: wsUrl,
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom', 'react-router-dom'],
          charts: ['chart.js', 'react-chartjs-2'],
          query: ['@tanstack/react-query', 'axios'],
          codemirror: ['@uiw/react-codemirror', '@codemirror/lang-html'],
        },
      },
    },
  },
};
});
