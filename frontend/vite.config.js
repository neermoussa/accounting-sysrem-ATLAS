import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// Port and backend address come from frontend/.env (or the shell):
//   VITE_PORT  - this app's dev port (default 5173)
//   ATLAS_API  - where the Atlas backend runs (default http://localhost:4000)
// The department apps (see tools/split-departments.js) each ship a .env with
// their own port and all point at the same backend.
export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env };
  const port = Number(env.VITE_PORT || 5173);
  const api = env.ATLAS_API || 'http://localhost:4000';
  // Scoped to the exact static subfolders the backend actually serves
  // (see server.js) rather than a blanket '/uploads' prefix — that used
  // to also swallow the frontend's own '/uploads' route (the Uploads
  // page), so a hard refresh or direct link to it hit the backend and
  // 404'd instead of reaching the SPA.
  const proxy = {
    '/api': { target: api, changeOrigin: true },
    '/uploads/branding': { target: api, changeOrigin: true },
    '/uploads/invoices': { target: api, changeOrigin: true },
  };
  return {
    plugins: [react()],
    server: { port, strictPort: true, proxy },
    preview: { port: port + 1000, proxy },
  };
});
