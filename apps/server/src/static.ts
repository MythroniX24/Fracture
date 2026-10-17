/**
 * Static file serving for the built client bundle.
 *
 * Deliberately dependency-free: only used when the client is deployed on the
 * same process (`SERVE_CLIENT=true`). Unknown paths fall back to `index.html`
 * so the single-page app can handle routing. Path traversal is impossible
 * because every resolved path must stay inside the dist directory.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

export interface StaticHandler {
  /** True when the dist directory exists and contains an index.html. */
  available: boolean;
  handle(req: IncomingMessage, res: ServerResponse, pathname: string): boolean;
}

export function createStaticHandler(distDir: string): StaticHandler {
  const root = resolve(distDir);
  const indexFile = join(root, 'index.html');
  const available = existsSync(indexFile);

  return {
    available,
    handle(req, res, pathname) {
      if (!available) return false;
      if (req.method !== 'GET' && req.method !== 'HEAD') return false;

      const relative = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
      const target = resolve(join(root, relative));
      // Never escape the bundle directory.
      if (target !== root && !target.startsWith(root + sep)) return false;

      let file = target;
      if (!existsSync(file) || statSync(file).isDirectory()) {
        if (relative !== '' && extname(relative) !== '') {
          // Missing asset: report it as a 404 rather than returning HTML.
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('Not found');
          return true;
        }
        file = indexFile;
      }

      try {
        const stats = statSync(file);
        res.writeHead(200, {
          'content-type': MIME_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
          'content-length': stats.size,
          'cache-control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=3600',
        });
        if (req.method === 'HEAD') {
          res.end();
          return true;
        }
        createReadStream(file).pipe(res);
        return true;
      } catch {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Failed to read asset');
        return true;
      }
    },
  };
}
