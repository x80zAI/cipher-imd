import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import handler from './api/imd.mjs';

export default defineConfig({
  plugins: [react(), {
    name: 'cipher-imd-api',
    configureServer(server) { server.middlewares.use('/api/imd', (req, res) => { void handler(req, res); }); },
    configurePreviewServer(server) { server.middlewares.use('/api/imd', (req, res) => { void handler(req, res); }); }
  }],
  build: { target: 'es2022' },
  test: { include: ['tests/**/*.test.ts'], environment: 'node', testTimeout: 15000 }
});
