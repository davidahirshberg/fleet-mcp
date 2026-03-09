import { defineConfig } from 'vite'

export default defineConfig({
  root: 'dashboard',
  base: process.env.FLEET_BASE || '/',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  server: {
    port: 5200,
    proxy: {
      '/api': 'http://localhost:5199',
      '/events': {
        target: 'http://localhost:5199',
        // SSE needs these to avoid buffering
        headers: { 'Cache-Control': 'no-transform' },
      },
    },
  },
})
