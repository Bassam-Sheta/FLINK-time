'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { renderPortal } = require('./portal-template');

const portalPath = path.resolve(__dirname, '../../apps-script/Portal.html');
const VIEWS = ['user', 'admin', 'superadmin'];
const cache = {};

function source() {
  return fs.readFileSync(portalPath, 'utf8');
}

function view(name) {
  if (!VIEWS.includes(name)) throw new Error('Unknown portal view: ' + name);
  if (!(name in cache)) cache[name] = renderPortal(source(), { portalView: name });
  return cache[name];
}

function views() {
  return { user: view('user'), admin: view('admin'), superadmin: view('superadmin') };
}

module.exports = { portalPath, source, view, views, VIEWS };
