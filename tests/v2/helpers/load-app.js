'use strict';

/**
 * Loads apps-script-v2/*.gs into ONE vm context, in the order of files.json, with the fakes as globals
 * (BUILD_SPEC section 10). Nothing is concatenated: each file is its own vm.Script, like Apps Script.
 *
 * const ctx = loadApp();
 * ctx.handleClientRequest(...)   // later tickets: the function exactly as the page would call it
 * ctx.__fakes                    // test handles (see fakes.js)
 * ctx.__setNow(ms)               // move the clock: Date.now(), new Date(), cache TTLs
 * ctx.__plain(value)             // JSON copy into the test's own realm (see below)
 *
 * Realm note: objects built by app code belong to the vm context's realm, so assert.deepStrictEqual against a
 * literal fails on prototypes even when the data matches. google.script.run sends JSON, so tests compare
 * ctx.__plain(result) instead.
 *
 * The context has only the JavaScript built-ins plus the fakes, so code that reaches for Node-only globals
 * (require, Buffer, URL, TextEncoder, setTimeout, crypto ...) fails here as it would in Apps Script.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createFakes, SERVICE_GLOBALS } = require('./fakes');

const APP_DIR = path.resolve(__dirname, '..', '..', '..', 'apps-script-v2');

function readFilesJson(appDir = APP_DIR) {
  const list = JSON.parse(fs.readFileSync(path.join(appDir, 'files.json'), 'utf8'));
  if (!Array.isArray(list) || !list.every(name => typeof name === 'string')) {
    throw new Error('files.json must be an array of file names');
  }
  if (new Set(list).size !== list.length) throw new Error('files.json lists a file twice');
  return list;
}

function readSources(appDir) {
  return readFilesJson(appDir)
    .filter(name => name.endsWith('.gs'))
    .map(name => ({ name, source: fs.readFileSync(path.join(appDir, name), 'utf8') }));
}

class TopLevelWorkError extends Error {}

function installServices(sandbox, fakes, throwOnServiceUse) {
  for (const name of SERVICE_GLOBALS) {
    if (throwOnServiceUse) {
      const refuse = () => {
        throw new TopLevelWorkError(`top-level code touched ${name}; .gs files may only define things (BUILD_SPEC 2.1)`);
      };
      Object.defineProperty(sandbox, name, { configurable: true, enumerable: true, get: refuse, set: refuse });
    } else {
      Object.defineProperty(sandbox, name, {
        configurable: true, enumerable: true, writable: true, value: fakes.globals[name],
      });
    }
  }
}

// Replaces Date inside the context so that Date.now() and new Date() read the fake clock. Everything else about
// Date (parsing, UTC, prototype, instanceof) is the context's own.
function installClock(context, clock) {
  const install = vm.runInContext(`(function (nowFn) {
    var RealDate = Date;
    var FakeDate = new Proxy(RealDate, {
      construct: function (target, args, newTarget) {
        if (args.length === 0) { return new target(nowFn()); }
        return Reflect.construct(target, args, newTarget);
      },
      apply: function (target) { return new target(nowFn()).toString(); },
      get: function (target, property) {
        if (property === 'now') { return function now() { return nowFn(); }; }
        return Reflect.get(target, property);
      }
    });
    globalThis.Date = FakeDate;
  })`, context);
  install(() => clock.now());
}

function runInApp(context, code) {
  return vm.runInContext(code, context);
}

/**
 * options.sources            [{ name, source }] instead of reading files.json
 * options.fakes              a createFakes() result to share with the test
 * options.throwOnServiceUse  every Apps Script service throws when read (no-top-level-work test)
 * options.appDir             a different app directory
 */
function loadApp(options = {}) {
  const appDir = options.appDir || APP_DIR;
  const fakes = options.fakes || createFakes();
  const sources = options.sources || readSources(appDir);

  const sandbox = {};
  installServices(sandbox, fakes, options.throwOnServiceUse === true);
  const context = vm.createContext(sandbox, { name: 'apps-script-v2' });
  installClock(context, fakes.clock);

  for (const { name, source } of sources) {
    try {
      new vm.Script(source, { filename: path.join(appDir, name) }).runInContext(context);
    } catch (err) {
      throw new Error(`loading ${name} failed: ${err.message}`, { cause: err });
    }
  }

  Object.defineProperties(context, {
    __fakes: { value: fakes },
    __setNow: { value: ms => fakes.clock.set(ms) },
    __advance: { value: ms => fakes.clock.advance(ms) },
    __plain: { value: value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value))) },
  });
  return context;
}

module.exports = { loadApp, runInApp, readFilesJson, APP_DIR, SERVICE_GLOBALS, TopLevelWorkError };
