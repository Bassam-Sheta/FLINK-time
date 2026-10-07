'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const mockPath = path.join(__dirname, 'mock-google.js');

const routes = {
  '/': {
    file: path.join(root, 'apps-script', 'User.html'),
    role: 'USER',
    setupInitialized: true
  },
  '/user': {
    file: path.join(root, 'apps-script', 'User.html'),
    role: 'USER',
    setupInitialized: true
  },
  '/admin': {
    file: path.join(root, 'apps-script', 'Admin.html'),
    role: 'ADMIN',
    setupInitialized: true
  },
  '/superadmin-setup': {
    file: path.join(root, 'apps-script', 'SuperAdmin.html'),
    role: 'SUPER_ADMIN',
    setupInitialized: false
  },
  '/superadmin': {
    file: path.join(root, 'apps-script', 'SuperAdmin.html'),
    role: 'SUPER_ADMIN',
    setupInitialized: true
  }
};

function pageHtml(route) {
  const config = routes[route] || routes['/'];
  const html = fs.readFileSync(config.file, 'utf8');
  const marker = '<!-- CORE FRONTEND ENGINE SCRIPT -->';
  if (!html.includes(marker)) {
    throw new Error(path.basename(config.file) + ' core script marker not found.');
  }

  const bootstrap = [
    '<script>',
    'window.__FLINK_MOCK_ROLE = ' + JSON.stringify(config.role) + ';',
    'window.__FLINK_MOCK_SETUP_INITIALIZED = ' +
      JSON.stringify(config.setupInitialized) + ';',
    '</script>',
    '<script src="/mock-google.js"></script>'
  ].join('\n');

  return html.replace(marker, bootstrap + '\n  ' + marker);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:4173');

  if (url.pathname === '/mock-google.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
    res.end(fs.readFileSync(mockPath, 'utf8'));
    return;
  }
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(pageHtml(url.pathname));
});

server.listen(4173, '127.0.0.1', () => {
  process.stdout.write('FLINK browser-test server listening on 4173\n');
});

function shutdown() {
  server.close(() => process.exit(0));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
