'use strict';

/**
 * Controllable fakes of the Apps Script services the v2 app uses (BUILD_SPEC section 10).
 *
 * createFakes() returns:
 *   globals   what the app sees as globals: Session, CacheService, ... console
 *   clock     the one shared clock (Date.now() in the app, cache TTLs, fetch stalls)
 *   session, cache, lock, properties, fetch, mail, html, triggers, utilities, log
 *             test-side handles to drive and inspect each fake
 *
 * The fakes copy Apps Script's visible behaviour where the spec relies on it (signed byte arrays,
 * cache limits, enum arguments). Where real behaviour is not recorded in docs/v2/phase0-results.md the
 * fake takes the stricter option and says so in a comment.
 */

const crypto = require('node:crypto');

// 2026-11-05 10:00:00 UTC. Fixed so that tests are deterministic; tests move it with clock.set().
const DEFAULT_START_MS = Date.UTC(2026, 10, 5, 10, 0, 0);

// Every global the app may use that tests need to control. load-app.js replaces each with a throwing
// accessor in "throwOnServiceUse" mode (the no-top-level-work test).
const SERVICE_GLOBALS = [
  'Session', 'CacheService', 'LockService', 'PropertiesService', 'Utilities', 'UrlFetchApp',
  'MailApp', 'HtmlService', 'ScriptApp', 'DriveApp', 'SpreadsheetApp', 'console',
];

function createClock(startMs = DEFAULT_START_MS) {
  let current = startMs;
  const requireMs = ms => {
    if (!Number.isSafeInteger(ms)) throw new TypeError('clock needs an integer number of milliseconds, got ' + ms);
    return ms;
  };
  return {
    now: () => current,
    set(ms) { current = requireMs(ms); },
    advance(ms) { current += requireMs(ms); },
  };
}

// ---------------------------------------------------------------- bytes and Utilities

// Apps Script's Byte[] holds SIGNED bytes (-128..127). Code that forgets "& 0xff" must fail here too.
const toSignedBytes = buffer => Array.from(buffer, b => (b << 24) >> 24);

function toBuffer(value, what) {
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (Array.isArray(value)) return Buffer.from(value.map(b => b & 0xff));
  throw new TypeError(`fake Utilities: ${what} must be a string or a byte array`);
}

class EnumValue {
  constructor(name) { this.name = name; Object.freeze(this); }
  toString() { return this.name; }
}

const NODE_HASH = { MD5: 'md5', SHA_1: 'sha1', SHA_256: 'sha256', SHA_384: 'sha384', SHA_512: 'sha512' };

function createEnum(names) {
  return Object.freeze(Object.fromEntries(names.map(name => [name, new EnumValue(name)])));
}

// Only these patterns are used by the code (BUILD_SPEC section 10). Anything else is refused so that a new
// pattern is added to the fake on purpose, with a test.
const SUPPORTED_DATE_PATTERNS = ['yyyy-MM-dd', 'HH:mm', 'Z'];

function formatDate(date, timeZone, pattern) {
  if (Object.prototype.toString.call(date) !== '[object Date]') {
    throw new TypeError('fake Utilities.formatDate: first argument must be a Date');
  }
  if (!SUPPORTED_DATE_PATTERNS.includes(pattern)) {
    throw new Error(`fake Utilities.formatDate: pattern "${pattern}" is not supported by the fake; add it deliberately`);
  }
  const ms = date.getTime();
  if (!Number.isFinite(ms)) throw new RangeError('fake Utilities.formatDate: Invalid Date');

  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', timeZoneName: 'longOffset',
    }).formatToParts(ms);
  } catch (err) {
    // Real Apps Script behaviour for an unknown zone id is not recorded in phase0-results.md. The fake throws so
    // that no code silently depends on a fallback.
    throw new Error('Exception: Invalid argument: ' + timeZone);
  }
  const part = type => parts.find(p => p.type === type).value;

  if (pattern === 'yyyy-MM-dd') return `${part('year')}-${part('month')}-${part('day')}`;
  if (pattern === 'HH:mm') return `${part('hour')}:${part('minute')}`;
  const match = /^GMT(?:([+-])(\d{2}):(\d{2}))?$/.exec(part('timeZoneName'));
  if (!match) throw new Error('fake Utilities.formatDate: unexpected zone name ' + part('timeZoneName'));
  return match[1] ? `${match[1]}${match[2]}${match[3]}` : '+0000';
}

function createUtilities() {
  const DigestAlgorithm = createEnum(Object.keys(NODE_HASH));
  const MacAlgorithm = createEnum(Object.keys(NODE_HASH).map(name => 'HMAC_' + name));
  const state = { sleptMs: 0 };

  const lookup = (enumeration, algorithm, label) => {
    if (!Object.values(enumeration).includes(algorithm)) {
      throw new TypeError(`fake Utilities: ${label} must be a Utilities.${label} value`);
    }
    return NODE_HASH[algorithm.name.replace(/^HMAC_/, '')];
  };

  const api = {
    DigestAlgorithm,
    MacAlgorithm,
    getUuid: () => crypto.randomUUID(),
    computeDigest(algorithm, value) {
      const hash = lookup(DigestAlgorithm, algorithm, 'DigestAlgorithm');
      return toSignedBytes(crypto.createHash(hash).update(toBuffer(value, 'value')).digest());
    },
    computeHmacSignature(algorithm, value, key) {
      const hash = lookup(MacAlgorithm, algorithm, 'MacAlgorithm');
      return toSignedBytes(crypto.createHmac(hash, toBuffer(key, 'key')).update(toBuffer(value, 'value')).digest());
    },
    computeHmacSha256Signature(value, key) {
      return api.computeHmacSignature(MacAlgorithm.HMAC_SHA_256, value, key);
    },
    base64Encode(data) {
      return toBuffer(data, 'data').toString('base64');
    },
    base64Decode(text) {
      return toSignedBytes(Buffer.from(String(text), 'base64'));
    },
    formatDate,
    sleep(ms) { state.sleptMs += ms; },
  };
  return { api, state };
}

// ---------------------------------------------------------------- Session

function createSession({ scriptTimeZone }) {
  const state = { activeEmail: '', effectiveEmail: '', scriptTimeZone };
  const api = {
    getActiveUser: () => ({ getEmail: () => state.activeEmail }),
    getEffectiveUser: () => ({ getEmail: () => state.effectiveEmail }),
    getScriptTimeZone: () => state.scriptTimeZone,
  };
  const control = {
    // The signed-in visitor. An empty string models "Google did not reveal the email" (AUTH_UNAVAILABLE).
    setActiveEmail(email) { state.activeEmail = email; },
    // The script owner, as seen by time-driven triggers and the editor.
    setEffectiveEmail(email) { state.effectiveEmail = email; },
  };
  return { api, control };
}

// ---------------------------------------------------------------- CacheService

const CACHE_MAX_TTL_S = 21600;      // Apps Script caps expiry at 6 hours
const CACHE_DEFAULT_TTL_S = 600;
const CACHE_MAX_VALUE_BYTES = 100 * 1024;
const CACHE_MAX_KEY_LENGTH = 250;

function createCache(clock) {
  const store = new Map();

  const checkKey = key => {
    if (typeof key !== 'string' || key.length === 0 || key.length > CACHE_MAX_KEY_LENGTH) {
      throw new Error('fake CacheService: key must be a string of 1-250 characters');
    }
    return key;
  };
  const toText = value => {
    // Numbers and booleans are stored as their string form (Cache.bump_ puts a number). Anything else is refused.
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (typeof value !== 'string') throw new TypeError('fake CacheService: value must be a string');
    if (Buffer.byteLength(value, 'utf8') > CACHE_MAX_VALUE_BYTES) {
      throw new Error('Exception: Argument too large: value');
    }
    return value;
  };
  const live = key => {
    const entry = store.get(key);
    if (!entry) return null;
    if (clock.now() >= entry.expiresAt) { store.delete(key); return null; }
    return entry.value;
  };

  const cache = {
    get: key => live(checkKey(key)),
    getAll(keys) {
      const found = {};
      for (const key of keys) { const value = live(checkKey(key)); if (value !== null) found[key] = value; }
      return found;
    },
    put(key, value, ttlSeconds = CACHE_DEFAULT_TTL_S) {
      const ttl = Math.min(ttlSeconds, CACHE_MAX_TTL_S);
      store.set(checkKey(key), { value: toText(value), expiresAt: clock.now() + ttl * 1000 });
    },
    putAll(values, ttlSeconds) { for (const key of Object.keys(values)) cache.put(key, values[key], ttlSeconds); },
    remove(key) { store.delete(checkKey(key)); },
    removeAll(keys) { for (const key of keys) store.delete(checkKey(key)); },
  };
  const api = {
    getScriptCache: () => cache,
    getUserCache: () => cache,
    getDocumentCache: () => cache,
  };
  const control = {
    clear() { store.clear(); },
    keys() { return [...store.keys()].filter(key => live(key) !== null); },
  };
  return { api, control };
}

// ---------------------------------------------------------------- LockService

function createLock() {
  const state = { held: false, heldElsewhere: false };
  const lock = {
    tryLock() {
      if (state.held || state.heldElsewhere) return false;
      state.held = true;
      return true;
    },
    waitLock() {
      if (!lock.tryLock()) throw new Error('Exception: Could not obtain lock after the timeout');
    },
    hasLock: () => state.held,
    releaseLock() { state.held = false; },
  };
  const api = { getScriptLock: () => lock, getUserLock: () => lock, getDocumentLock: () => lock };
  const control = {
    // Models another execution holding the script lock ("two sealers can't overlap").
    setHeldElsewhere(value) { state.heldElsewhere = !!value; },
    isHeld: () => state.held,
  };
  return { api, control };
}

// ---------------------------------------------------------------- PropertiesService

function createProperties() {
  const store = new Map();
  const properties = {
    getProperty: key => (store.has(key) ? store.get(key) : null),
    getProperties: () => Object.fromEntries(store),
    getKeys: () => [...store.keys()],
    setProperty(key, value) { store.set(String(key), String(value)); return properties; },
    setProperties(values, deleteAllOthers) {
      if (deleteAllOthers) store.clear();
      for (const key of Object.keys(values)) store.set(key, String(values[key]));
      return properties;
    },
    deleteProperty(key) { store.delete(key); return properties; },
    deleteAllProperties() { store.clear(); return properties; },
  };
  const api = { getScriptProperties: () => properties };
  const control = {
    get: key => (store.has(key) ? store.get(key) : null),
    set(key, value) { store.set(key, String(value)); },
    all: () => Object.fromEntries(store),
  };
  return { api, control };
}

// ---------------------------------------------------------------- UrlFetchApp

function createFetch(clock) {
  const routes = [];
  const queue = [];
  const calls = [];

  const makeResponse = (status, body, headers = {}) => ({
    getResponseCode: () => status,
    getContentText: () => body,
    getHeaders: () => ({ ...headers }),
    getAllHeaders: () => ({ ...headers }),
  });

  const api = {
    fetch(url, params = {}) {
      const request = {
        url,
        method: String(params.method || 'get').toUpperCase(),
        headers: { ...(params.headers || {}) },
        contentType: params.contentType,
        payload: params.payload,
        muteHttpExceptions: !!params.muteHttpExceptions,
      };
      calls.push(request);

      let behaviour = queue.shift() || {};
      if (behaviour.stallMs) {
        // Apps Script fetch is synchronous; a stalled call simply takes this long.
        clock.advance(behaviour.stallMs);
      }
      if (behaviour.fail) {
        throw new Error('Exception: Address unavailable: ' + url);
      }

      let status; let body; let headers;
      if (behaviour.garbage) {
        status = 200; body = '<<<not a turso response>>>'; headers = {};
      } else if (behaviour.status !== undefined) {
        status = behaviour.status; body = behaviour.body === undefined ? '' : behaviour.body; headers = {};
      } else {
        const route = routes.find(r => r.match(url));
        if (!route) throw new Error('fake UrlFetchApp: no route for ' + url);
        const result = route.handler(request);
        status = result.status === undefined ? 200 : result.status;
        body = result.body === undefined ? '' : result.body;
        headers = result.headers || {};
      }

      if (status >= 400 && !request.muteHttpExceptions) {
        throw new Error(`Exception: Request failed for ${url} returned code ${status}. Truncated server response: ${String(body).slice(0, 100)}`);
      }
      return makeResponse(status, body, headers);
    },
  };

  const control = {
    calls,
    // handler(request) -> { status?, body?, headers? }; match is a string prefix or a function(url) -> boolean.
    // The first matching route answers; { first: true } puts this one in front of the routes already added,
    // which is how a test wraps the fake Turso route (drop a response, fail the Nth call).
    route(match, handler, options = {}) {
      const entry = { match: typeof match === 'function' ? match : url => String(url).startsWith(match), handler };
      if (options.first) routes.unshift(entry); else routes.push(entry);
    },
    failNext() { queue.push({ fail: true }); },
    stallNext(ms) { queue.push({ stallMs: ms }); },
    garbageNext() { queue.push({ garbage: true }); },
    respondNext(status, body) { queue.push({ status, body }); },
    reset() { routes.length = 0; queue.length = 0; calls.length = 0; },
  };
  return { api, control };
}

// ---------------------------------------------------------------- MailApp

function createMail() {
  const sent = [];
  const state = { failNext: 0 };
  const api = {
    sendEmail(...args) {
      if (state.failNext > 0) { state.failNext -= 1; throw new Error('Exception: Service invoked too many times for one day: email.'); }
      const mail = typeof args[0] === 'object' && args[0] !== null
        ? { to: args[0].to, subject: args[0].subject, body: args[0].body || args[0].htmlBody, options: { ...args[0] } }
        : { to: args[0], subject: args[1], body: args[2], options: { ...(args[3] || {}) } };
      sent.push(mail);
    },
    getRemainingDailyQuota: () => Math.max(0, 100 - sent.length),
  };
  const control = {
    sent,
    failNext(count = 1) { state.failNext = count; },
    reset() { sent.length = 0; state.failNext = 0; },
  };
  return { api, control };
}

// ---------------------------------------------------------------- HtmlService

function createHtml() {
  const outputs = [];
  const XFrameOptionsMode = Object.freeze({ ALLOWALL: 'ALLOWALL', DEFAULT: 'DEFAULT' });

  const makeOutput = (record, content) => {
    const output = {
      setTitle(title) { record.title = title; return output; },
      setXFrameOptionsMode(mode) { record.frameMode = mode; return output; },
      addMetaTag(name, contentValue) { record.meta.push([name, contentValue]); return output; },
      getContent: () => content,
    };
    return output;
  };
  const newRecord = (template, props) => {
    const record = { template, props, title: undefined, frameMode: undefined, meta: [] };
    outputs.push(record);
    return record;
  };

  const api = {
    XFrameOptionsMode,
    createTemplateFromFile(name) {
      const template = {
        evaluate() {
          const props = {};
          for (const key of Object.keys(template)) if (typeof template[key] !== 'function') props[key] = template[key];
          return makeOutput(newRecord(name, props), `<!-- fake template ${name} -->`);
        },
      };
      return template;
    },
    createHtmlOutputFromFile: name => makeOutput(newRecord(name, {}), `<!-- fake include ${name} -->`),
    createHtmlOutput: content => makeOutput(newRecord(null, {}), String(content)),
  };
  const control = {
    outputs,
    last: () => outputs[outputs.length - 1],
    reset() { outputs.length = 0; },
  };
  return { api, control };
}

// ---------------------------------------------------------------- ScriptApp

function createScriptApp() {
  const triggers = [];
  let nextId = 1;
  const WeekDay = Object.freeze({
    MONDAY: 'MONDAY', TUESDAY: 'TUESDAY', WEDNESDAY: 'WEDNESDAY', THURSDAY: 'THURSDAY',
    FRIDAY: 'FRIDAY', SATURDAY: 'SATURDAY', SUNDAY: 'SUNDAY',
  });

  const api = {
    WeekDay,
    newTrigger(handler) {
      const schedule = {};
      const builder = {
        timeBased: () => builder,
        everyMinutes(n) { schedule.every = { unit: 'minutes', n }; return builder; },
        everyHours(n) { schedule.every = { unit: 'hours', n }; return builder; },
        everyDays(n) { schedule.every = { unit: 'days', n }; return builder; },
        everyWeeks(n) { schedule.every = { unit: 'weeks', n }; return builder; },
        onWeekDay(day) { schedule.weekDay = day; return builder; },
        atHour(hour) { schedule.atHour = hour; return builder; },
        nearMinute(minute) { schedule.nearMinute = minute; return builder; },
        inTimezone(timeZone) { schedule.timeZone = timeZone; return builder; },
        create() {
          const record = { id: String(nextId++), handler, schedule: { ...schedule } };
          triggers.push(record);
          return {
            getHandlerFunction: () => record.handler,
            getUniqueId: () => record.id,
            getEventType: () => 'CLOCK',
          };
        },
      };
      return builder;
    },
    getProjectTriggers: () => triggers.map(record => ({
      getHandlerFunction: () => record.handler,
      getUniqueId: () => record.id,
      getEventType: () => 'CLOCK',
    })),
    deleteTrigger(trigger) {
      const index = triggers.findIndex(record => record.id === trigger.getUniqueId());
      if (index >= 0) triggers.splice(index, 1);
    },
  };
  const control = { triggers, reset() { triggers.length = 0; } };
  return { api, control };
}

// ---------------------------------------------------------------- console

function createLog() {
  const lines = [];
  const format = args => args.map(arg => {
    if (typeof arg === 'string') return arg;
    try { return JSON.stringify(arg); } catch (err) { return String(arg); }
  }).join(' ');
  const record = level => (...args) => { lines.push({ level, text: format(args) }); };
  const api = { log: record('log'), info: record('info'), warn: record('warn'), error: record('error'), debug: record('debug') };
  return { api, control: { lines, reset() { lines.length = 0; } } };
}

// ---------------------------------------------------------------- not implemented yet

function notImplemented(name, ticket) {
  return new Proxy({}, {
    get(target, property) {
      if (typeof property === 'symbol') return undefined;
      throw new Error(`fake ${name}.${property} is not implemented yet; it is needed from ticket ${ticket}`);
    },
  });
}

// ---------------------------------------------------------------- assembly

function createFakes(options = {}) {
  const clock = options.clock || createClock();
  const scriptTimeZone = options.scriptTimeZone || 'Africa/Cairo';

  const session = createSession({ scriptTimeZone });
  const cache = createCache(clock);
  const lock = createLock();
  const properties = createProperties();
  const utilities = createUtilities();
  const fetch = createFetch(clock);
  const mail = createMail();
  const html = createHtml();
  const scriptApp = createScriptApp();
  const log = createLog();

  return {
    clock,
    session: session.control,
    cache: cache.control,
    lock: lock.control,
    properties: properties.control,
    utilities: utilities.state,
    fetch: fetch.control,
    mail: mail.control,
    html: html.control,
    triggers: scriptApp.control,
    log: log.control,
    globals: {
      Session: session.api,
      CacheService: cache.api,
      LockService: lock.api,
      PropertiesService: properties.api,
      Utilities: utilities.api,
      UrlFetchApp: fetch.api,
      MailApp: mail.api,
      HtmlService: html.api,
      ScriptApp: scriptApp.api,
      DriveApp: notImplemented('DriveApp', 'T4.3'),
      SpreadsheetApp: notImplemented('SpreadsheetApp', 'T4.3'),
      console: log.api,
    },
  };
}

module.exports = { createFakes, createClock, DEFAULT_START_MS, SERVICE_GLOBALS };
