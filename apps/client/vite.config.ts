import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * In development the game server runs on port 2567 while Vite serves the client
 * on 3000. Proxying `/ws` and `/health` keeps the browser on a single origin
 * (including when the dev server is exposed through a tunnel), so the client can
 * simply connect to `ws://<page-origin>/ws`.
 */
const serverTarget = process.env.VITE_SERVER_PROXY_TARGET ?? 'http://127.0.0.1:2567';

const extraAllowedHosts = (process.env.VITE_ALLOWED_HOSTS ?? '')
  .split(',')
  .map((host) => host.trim())
  .filter((host) => host.length > 0);

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 3000,
    strictPort: false,
    ...(extraAllowedHosts.length > 0 ? { allowedHosts: extraAllowedHosts } : {}),
    proxy: {
      '/ws': { target: serverTarget, ws: true, changeOrigin: true },
      '/health': { target: serverTarget, changeOrigin: true },
    },
  },
  preview: {
    host: '0.0.0.0',
    port: 3000,
    ...(extraAllowedHosts.length > 0 ? { allowedHosts: extraAllowedHosts } : {}),
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
  },
});
