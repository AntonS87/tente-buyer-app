// Test server: serves the app and answers /api with the real backend/Code.gs
// running on a fake sheet. It can also pretend the signal drops mid-sync.
//   node test/server.mjs   -> http://localhost:8080 (agent MW1, PIN 1234)

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBackend, PURCHASE_COLS } from './fake-gas.mjs';

const APP_DIR = fileURLToPath(new URL('../app/', import.meta.url));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png',
  '.webmanifest': 'application/manifest+json', '.json': 'application/json' };

export async function startServer(port = 0) {
  const backend = loadBackend();
  const faults = { dropAfterSave: 0, delayMs: 0, failNext: 0 };
  const stats = { syncCalls: 0, recordsReceived: 0 };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (url.pathname === '/api' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        if (faults.delayMs) await new Promise(r => setTimeout(r, faults.delayMs));
        if (faults.failNext > 0) { faults.failNext--; res.socket.destroy(); return; }
        const parsed = JSON.parse(body);
        if (parsed.action === 'sync') { stats.syncCalls++; stats.recordsReceived += (parsed.records || []).length; }
        const out = backend.post(parsed);
        // Signal lost after the sheet saved the rows but before the phone heard back.
        if (faults.dropAfterSave > 0 && parsed.action === 'sync' && (parsed.records || []).length) {
          faults.dropAfterSave--;
          res.socket.destroy();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out));
        return;
      }
      if (url.pathname === '/config.js') {
        res.writeHead(200, { 'Content-Type': 'text/javascript' });
        res.end("window.TENTE_CONFIG = { apiUrl: '/api' };");
        return;
      }
      const path = normalize(join(APP_DIR, url.pathname === '/' ? 'index.html' : url.pathname));
      if (!path.startsWith(APP_DIR)) { res.writeHead(403); res.end(); return; }
      const data = await readFile(path);
      res.writeHead(200, { 'Content-Type': TYPES[extname(path)] || 'application/octet-stream' });
      res.end(data);
    } catch (err) {
      res.writeHead(err.code === 'ENOENT' ? 404 : 500);
      res.end(String(err.message));
    }
  });

  await new Promise(r => server.listen(port, r));
  return {
    url: `http://localhost:${server.address().port}`,
    backend,
    faults,
    stats,
    purchases: () => backend.ss.getSheetByName('Purchases').rowsFrom(4, PURCHASE_COLS),
    close: () => new Promise(r => { server.closeAllConnections(); server.close(r); })
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const s = await startServer(Number(process.env.PORT || 8080));
  console.log(`Tente Buyer test server on ${s.url}  (log in as MW1 / 1234 or SZ1 / 5678)`);
}
