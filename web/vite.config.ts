import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

const backendUrl = process.env.HALE_BACKEND_URL || 'http://localhost:8000'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // Custom src/sw.ts (push handling) rather than the default generateSW —
      // generateSW can't inject arbitrary event listeners like `push`/`notificationclick`.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      injectManifest: {
        // Vite's own icons.svg/favicon.svg + generated PWA icons already live under
        // public/ and are copied verbatim; this just controls what the SW precaches.
        globPatterns: ['**/*.{js,css,html,svg,png,ico}'],
      },
      registerType: 'autoUpdate',
      devOptions: { enabled: false }, // avoid SW interference with the Vite dev server / HMR
      manifest: {
        name: "HALE — HALE's Adaptive Life Engine",
        short_name: 'HALE',
        description: 'Self-hosted fitness tracker: Strava/Garmin sync, insights, and an AI coach.',
        start_url: '/',
        display: 'standalone',
        background_color: '#0b0e12',
        theme_color: '#0b0e12',
        icons: [
          { src: '/icons/pwa-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
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
