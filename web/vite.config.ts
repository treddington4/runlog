import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const backendUrl = process.env.HALE_BACKEND_URL || 'http://localhost:8000'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    proxy: {
      '/api': backendUrl,
      '/auth': backendUrl,
    },
    // Y:\runlog is an SMB share (see .RUNBOOK.md) — native fs.watch() isn't
    // supported over network mounts and crashes Vite on startup. Polling is
    // the documented workaround for network/Docker-volume filesystems.
    watch: {
      usePolling: true,
      interval: 300,
    },
  },
})
