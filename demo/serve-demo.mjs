import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = dirname(fileURLToPath(import.meta.url));
const preferredPort = Number(process.env.ONELIVE_DEMO_PORT || 4173);
let port = preferredPort;
const host = '127.0.0.1';
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.fbx': 'application/octet-stream', '.mp4': 'video/mp4', '.m4a': 'audio/mp4',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml'
};

function openBrowser(url) {
  const commands = process.platform === 'win32'
    ? [['cmd', ['/c', 'start', '', url]]]
    : process.platform === 'darwin'
      ? [['open', [url]]]
      : [['xdg-open', [url]]];
  const [command, args] = commands[0];
  spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

const server = createServer((request, response) => {
  try {
    const url = new URL(request.url || '/', `http://${host}:${port}`);
    const pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const file = resolve(root, `.${pathname}`);
    if (file !== root && !file.startsWith(`${root}${sep}`)) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    const stat = statSync(file);
    if (!stat.isFile()) throw new Error('Not a file');
    const extension = extname(file).toLowerCase();
    const headers = {
      'Content-Type': types[extension] || 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Cache-Control': ['.html', '.js', '.css'].includes(extension) ? 'no-store' : 'public, max-age=3600'
    };
    const range = request.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
      if (start > end || start >= stat.size) {
        response.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }).end();
        return;
      }
      response.writeHead(206, { ...headers, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${stat.size}` });
      if (request.method === 'HEAD') response.end();
      else createReadStream(file, { start, end }).pipe(response);
      return;
    }
    response.writeHead(200, { ...headers, 'Content-Length': stat.size });
    if (request.method === 'HEAD') response.end();
    else createReadStream(file).pipe(response);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('OneLive demo file not found');
  }
});

function startServer() {
  server.listen(port, host);
}

server.on('listening', () => {
  const url = `http://${host}:${port}/`;
  console.log(`OneLive demo is running at ${url}`);
  console.log('Keep this window open. Press Ctrl+C to stop.');
  if (process.env.ONELIVE_DEMO_NO_OPEN !== '1') openBrowser(url);
});

server.on('error', async (error) => {
  if (error.code === 'EADDRINUSE') {
    const occupiedUrl = `http://${host}:${port}/`;
    try {
      const response = await fetch(occupiedUrl, { signal: AbortSignal.timeout(1200) });
      const html = await response.text();
      if (html.includes('id="futureOpen"') && html.includes('OneLive')) {
        console.log(`OneLive is already running at ${occupiedUrl}`);
        if (process.env.ONELIVE_DEMO_NO_OPEN !== '1') openBrowser(occupiedUrl);
        process.exit(0);
      }
    } catch {
      // The port belongs to another process; continue with the next local port.
    }
    if (port < preferredPort + 10) {
      port += 1;
      console.log(`Port ${port - 1} is busy. Trying http://${host}:${port}/ ...`);
      startServer();
      return;
    }
  }
  console.error(`Unable to start OneLive demo: ${error.message}`);
  process.exitCode = 1;
});

startServer();
