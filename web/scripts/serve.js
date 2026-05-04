import { existsSync } from 'node:fs';
import { join, normalize } from 'node:path';

const root = join(process.cwd(), 'dist');
const port = Number(process.env.PORT || 4173);

function contentType(pathname) {
  if (pathname.endsWith('.html')) return 'text/html; charset=utf-8';
  if (pathname.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (pathname.endsWith('.css')) return 'text/css; charset=utf-8';
  if (pathname.endsWith('.json')) return 'application/json; charset=utf-8';
  if (pathname.endsWith('.svg')) return 'image/svg+xml';
  if (pathname.endsWith('.png')) return 'image/png';
  if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) return 'image/jpeg';
  return 'application/octet-stream';
}

Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url);
    const requested = url.pathname === '/' ? '/index.html' : url.pathname;
    const filePath = normalize(join(root, requested));

    if (!filePath.startsWith(normalize(root)) || !existsSync(filePath)) {
      return new Response('Not found', { status: 404 });
    }

    return new Response(Bun.file(filePath), {
      headers: {
        'Content-Type': contentType(filePath),
        'Cache-Control': 'no-store',
      },
    });
  },
});

console.log(`Aikan static HLS preview: http://127.0.0.1:${port}`);
