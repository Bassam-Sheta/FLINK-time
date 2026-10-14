'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const appDir = path.resolve(__dirname, '../../apps-script');
const backend = fs.readFileSync(path.join(appDir, 'Code.gs'), 'utf8');

function portalRenderer(overrides = {}) {
  let reads = 0;
  const context = vm.createContext({
    console,
    HtmlService: {
      createHtmlOutputFromFile(name) {
        if (!['User', 'Admin', 'SuperAdmin'].includes(name)) throw new Error('Unexpected portal file');
        reads++;
        return { getContent: () => overrides[name] ?? fs.readFileSync(path.join(appDir, name + '.html'), 'utf8') };
      },
      XFrameOptionsMode: { ALLOWALL: 'ALLOWALL', DEFAULT: 'DEFAULT' },
      createHtmlOutput(html) {
        return { html,
          setTitle(title) { this.title = title; return this; },
          setXFrameOptionsMode(mode) { this.frameMode = mode; return this; },
          addMetaTag(name, value) { this.metaTag = { name, value }; return this; }
        };
      }
    },
    ContentService: {
      MimeType: { TEXT: 'text/plain' },
      createTextOutput(text) { return { text, setMimeType() { return this; } }; }
    }
  });
  vm.runInContext(backend, context);
  return {
    context,
    get reads() { return reads; },
    render(name) {
      return context.renderPortalHtml_(name);
    }
  };
}

function renderPortal(name) { return portalRenderer().render(name); }
module.exports = { portalRenderer, renderPortal };
