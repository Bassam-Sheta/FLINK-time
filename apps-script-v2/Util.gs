/**
 * Util.gs - ids, time, canonical JSON, hashing, HMAC, hex (BUILD_SPEC sections 2, 3, 6.2, 7.3 and 11).
 * Top-level code only defines things (BUILD_SPEC section 2.1).
 *
 * Copied from the old code, then re-tested under tests/v2 (BUILD_SPEC section 11):
 *   canonicalJson_  from storage-v2/LogChain.gs (canonicalJson)
 *   time zone validation, local dates, calendar-day arithmetic  from apps-script/Code.gs (TimezoneService)
 * The old week-bounds and local-time-to-UTC code is not needed: v1 groups weeks in SQL from local_date and takes
 * timestamps as milliseconds.
 *
 * Mistakes in the calling code surface as AppError_ INTERNAL; values that came from a user are validated in
 * Validate.gs before they reach these helpers.
 */
var Util = {

  /** An internal error for a helper that was called with something it cannot use. */
  bug_: function (detail) {
    return new AppError_('INTERNAL', 'An internal error occurred.', { error: detail });
  },

  // ------------------------------------------------------------ ids

  /** A new id: Utilities.getUuid(), lower-case, no braces (BUILD_SPEC section 3). */
  id_: function () {
    return String(Utilities.getUuid()).toLowerCase().replace(/[{}]/g, '');
  },

  // ------------------------------------------------------------ canonical JSON

  /**
   * Deterministic JSON for anything that is stored in a column or hashed: keys sorted by UTF-16 code unit at every
   * depth, no spaces, numbers as JSON writes them, undefined object properties dropped. Anything that is not JSON
   * (NaN, Infinity, Date, functions, undefined inside an array, ...) is refused rather than quietly changed.
   */
  canonicalJson_: function (value) {
    if (value === null) return 'null';
    var type = typeof value;
    if (type === 'string' || type === 'boolean') return JSON.stringify(value);
    if (type === 'number') {
      if (!isFinite(value)) throw Util.bug_('a non-finite number cannot be written as JSON');
      return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
      var items = [];
      for (var i = 0; i < value.length; i++) items.push(Util.canonicalJson_(value[i]));
      return '[' + items.join(',') + ']';
    }
    if (type === 'object') {
      if (Object.prototype.toString.call(value) === '[object Date]') {
        throw Util.bug_('a Date cannot be written as canonical JSON; use its milliseconds');
      }
      return '{' + Object.keys(value).sort().filter(function (key) {
        return value[key] !== undefined;
      }).map(function (key) {
        return JSON.stringify(key) + ':' + Util.canonicalJson_(value[key]);
      }).join(',') + '}';
    }
    throw Util.bug_('a value of type ' + type + ' cannot be written as canonical JSON');
  },

  // ------------------------------------------------------------ bytes, hashing, HMAC

  /**
   * UTF-8 bytes of a string, as Apps Script's signed Byte[] (-128..127). Done here so that hashes never depend on a
   * platform default charset. A lone surrogate becomes U+FFFD (EF BF BD), as in TextEncoder and Node.
   */
  utf8Bytes_: function (text) {
    if (typeof text !== 'string') throw Util.bug_('utf8Bytes_ needs a string');
    var bytes = [];
    for (var i = 0; i < text.length; i++) {
      var code = text.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
        var next = text.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
          i++;
        }
      }
      if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
      if (code < 0x80) {
        bytes.push(code);
      } else if (code < 0x800) {
        bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
      } else if (code < 0x10000) {
        bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
      } else {
        bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
      }
    }
    return bytes.map(function (byte) { return byte > 127 ? byte - 256 : byte; });
  },

  /** Number of bytes utf8Bytes_ would produce, without building them. */
  utf8Length_: function (text) {
    if (typeof text !== 'string') throw Util.bug_('utf8Length_ needs a string');
    var length = 0;
    for (var i = 0; i < text.length; i++) {
      var code = text.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
        var next = text.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          code = 0x10000;
          i++;
        }
      }
      if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
      length += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    }
    return length;
  },

  /** Lower-case hex of a byte array. Apps Script bytes are signed, so each is masked to 0..255 first. */
  hex_: function (bytes) {
    if (!Array.isArray(bytes)) throw Util.bug_('hex_ needs a byte array');
    var hex = '';
    for (var i = 0; i < bytes.length; i++) {
      hex += ((bytes[i] & 0xff) + 0x100).toString(16).slice(1);
    }
    return hex;
  },

  /** SHA-256 of a string's UTF-8 bytes, as 64 lower-case hex digits. */
  sha256Hex_: function (text) {
    if (typeof text !== 'string') throw Util.bug_('sha256Hex_ needs a string');
    return Util.hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Util.utf8Bytes_(text)));
  },

  /**
   * HMAC-SHA256 as hex. The order is (key, message), as in the spec's HMAC_SHA256(key, message); Apps Script's own
   * function takes (value, key). Both are used as the UTF-8 text they are: a 64-hex-digit key is not decoded.
   */
  hmacSha256Hex_: function (key, message) {
    if (typeof key !== 'string' || key === '') throw Util.bug_('hmacSha256Hex_ needs a non-empty string key');
    if (typeof message !== 'string') throw Util.bug_('hmacSha256Hex_ needs a string message');
    return Util.hex_(Utilities.computeHmacSha256Signature(Util.utf8Bytes_(message), Util.utf8Bytes_(key)));
  },

  // ------------------------------------------------------------ time zones and local dates

  /**
   * True for an IANA zone id that Utilities.formatDate really understands. The id must look like one; Intl must
   * accept it (when Intl exists); and formatDate must agree with Intl about the local time at two probe instants,
   * one in January and one in July. The last check catches a platform that quietly formats an id it does not know
   * as GMT (what Java's TimeZone does), which would silently produce wrong dates. What real Apps Script does with an
   * unknown id is not recorded in docs/v2/phase0-results.md, so this does not assume either behaviour.
   */
  isValidTimeZone_: function (timeZone) {
    if (typeof timeZone !== 'string' || timeZone.length > 64) return false;
    if (!/^[A-Za-z][A-Za-z0-9_+\-]*(\/[A-Za-z0-9_+\-]+){0,2}$/.test(timeZone)) return false;

    var formatter = null;
    if (typeof Intl === 'object' && Intl !== null && typeof Intl.DateTimeFormat === 'function') {
      try {
        formatter = new Intl.DateTimeFormat('en-GB', { timeZone: timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
      } catch (err) {
        return false;
      }
    }
    var probes = [Date.UTC(2026, 0, 15, 12, 0, 0), Date.UTC(2026, 6, 15, 12, 0, 0)];
    for (var i = 0; i < probes.length; i++) {
      var viaScript;
      try {
        viaScript = Utilities.formatDate(new Date(probes[i]), timeZone, 'HH:mm');
      } catch (err) {
        return false;
      }
      if (formatter && viaScript !== formatter.format(probes[i])) return false;
    }
    return true;
  },

  /** YYYY-MM-DD of a moment in a time zone (BUILD_SPEC section 3). Entries count on their start date (D5). */
  localDate_: function (ms, timeZone) {
    if (!Number.isSafeInteger(ms)) throw Util.bug_('localDate_ needs an integer number of milliseconds');
    if (typeof timeZone !== 'string' || timeZone === '') throw Util.bug_('localDate_ needs a time zone');
    try {
      return Utilities.formatDate(new Date(ms), timeZone, 'yyyy-MM-dd');
    } catch (err) {
      throw Util.bug_('localDate_ could not format ' + ms + ' in ' + timeZone);
    }
  },

  /** Today's date in a time zone, by the server clock. */
  today_: function (timeZone) {
    return Util.localDate_(Date.now(), timeZone);
  },

  // ------------------------------------------------------------ calendar dates (no time zone, no DST)

  /** { year, month, day, ms } for a real YYYY-MM-DD date (year 0001..9999), or null. */
  parseDate_: function (text) {
    var match = typeof text === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(text) : null;
    if (!match) return null;
    var year = Number(match[1]);
    var month = Number(match[2]);
    var day = Number(match[3]);
    if (year < 1 || month < 1 || month > 12 || day < 1) return null;
    // setUTCFullYear, because Date.UTC reads years 0..99 as 1900..1999
    var date = new Date(0);
    date.setUTCFullYear(year, month - 1, day);
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
    return { year: year, month: month, day: day, ms: date.getTime() };
  },

  isDate_: function (text) {
    return Util.parseDate_(text) !== null;
  },

  /** The date n days after (or before, if negative) a YYYY-MM-DD date. Pure calendar arithmetic. */
  addDays_: function (dateText, days) {
    var parsed = Util.parseDate_(dateText);
    if (!parsed) throw Util.bug_('addDays_ needs a real YYYY-MM-DD date');
    if (!Number.isInteger(days)) throw Util.bug_('addDays_ needs a whole number of days');
    var date = new Date(parsed.ms + days * 86400000);
    var year = date.getUTCFullYear();
    if (year < 1 || year > 9999) throw Util.bug_('addDays_ left the supported years');
    var pad = function (number, width) { return ('0000' + number).slice(-width); };
    return pad(year, 4) + '-' + pad(date.getUTCMonth() + 1, 2) + '-' + pad(date.getUTCDate(), 2);
  },

  /** Whole days from the first date to the second (negative if the second is earlier). */
  diffDays_: function (fromText, toText) {
    var from = Util.parseDate_(fromText);
    var to = Util.parseDate_(toText);
    if (!from || !to) throw Util.bug_('diffDays_ needs two real YYYY-MM-DD dates');
    return Math.round((to.ms - from.ms) / 86400000);
  },

  // ------------------------------------------------------------ durations and client time

  /** Whole seconds between two moments: Math.floor((end - start) / 1000), the same as SQLite's integer division. */
  durationSeconds_: function (startMs, endMs) {
    if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs)) {
      throw Util.bug_('durationSeconds_ needs integer milliseconds');
    }
    if (endMs < startMs) throw Util.bug_('durationSeconds_ needs the end not before the start');
    return Math.floor((endMs - startMs) / 1000);
  },

  /**
   * The start time to record for a timer (BUILD_SPEC section 6.2): if the client's clock is within skewSeconds of
   * the server's, trust it but never later than the server (min); otherwise use the server's. A value that is not an
   * integer time is not trusted at all. skewSeconds is TIMER_CLIENT_SKEW_SECONDS (default 120).
   */
  clampClientTime_: function (clientAt, now, skewSeconds) {
    if (!Number.isSafeInteger(now)) throw Util.bug_('clampClientTime_ needs the server time as integer milliseconds');
    var skew = skewSeconds === undefined ? 120 : skewSeconds;
    if (typeof skew !== 'number' || !isFinite(skew) || skew < 0) throw Util.bug_('clampClientTime_ needs a skew of zero or more seconds');
    if (!Number.isSafeInteger(clientAt)) return now;
    if (Math.abs(clientAt - now) <= skew * 1000) return Math.min(clientAt, now);
    return now;
  }
};
