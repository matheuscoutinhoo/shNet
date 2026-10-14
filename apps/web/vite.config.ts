import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { engineSourceHash } from '../../scripts/engine-build.ts';
export default defineConfig(({ command }) => ({
  define: {
    __SHLAB_ENGINE_BUILD__: JSON.stringify(command === 'build' ? engineSourceHash() : 'development'),
  },
  plugins: [react()],
  server: {
    port: Number(process.env.WEB_PORT ?? 5173),
    strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:' + (process.env.API_PORT ?? 3001), ws: true } },
  },
}));
