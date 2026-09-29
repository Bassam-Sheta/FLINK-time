'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const userHtmlPath = path.join(root, 'apps-script', 'User.html');
const mockPath = path.join(__dirname, 'mock-google.js');

function pageHtml() {
  const html = fs.readFileSync(userHtmlPath, 'utf8');
  const marker = '<!-- CORE FRONTEND ENGINE SCRIPT -->';
  if (!html.includes(marker)) {
    throw new Error('User.html core script marker not found.');
  }
  return html.replace(
    marker,
    '<script src="/mock-google.js"></script>\n  ' + marker
  );
}

const server = http.createServer((req, res) => {
  if (req.url === '/mock-google.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
    res.end(fs.readFileSync(mockPath, 'utf8'));
    return;
  }
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(pageHtml());
});

server.listen(4173, '127.0.0.1', () => {
  process.stdout.write('FLINK human-test server listening on 4173\n');
});

function shutdown() {
  server.close(() => process.exit(0));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
