# HALE web

Vite + React + TypeScript + Tailwind + shadcn/ui frontend, replacing the
legacy vanilla-JS `app/static/` frontend tab-by-tab (see `../PLAN.md` Phase 0
and `../ROADMAP.md`). FastAPI backend API contracts are unchanged — this is a
rewrite of the client only.

## Dev

```bash
npm install
HALE_BACKEND_URL=http://<backend-host>:8000 npm run dev
```

`HALE_BACKEND_URL` defaults to `http://localhost:8000`. The dev server proxies
`/api/*` and `/auth/*` to it (see `vite.config.ts`) so the app can be worked on
against a real backend without CORS setup.

If you're on a network-mounted working copy (SMB/NFS), Vite's file watcher
needs `usePolling` (already configured) since native `fs.watch()` doesn't work
over network filesystems — expect `npm install` itself to be slow for the
same reason (many small-file writes over the network), but HMR should be
fine once `node_modules` exists.

## Build

```bash
npm run build   # tsc -b && vite build -> dist/
```

`dist/` is gitignored — Phase 0.10 wires this into a multi-stage Dockerfile
build, replacing `app/static/` in production.
