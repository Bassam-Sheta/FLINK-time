/**
 * Validate.gs - payload schema checker and formula neutraliser (BUILD_SPEC sections 2, 6.1 and 11).
 * Top-level code only defines things (BUILD_SPEC section 2.1).
 *
 * Validate.payload_(schema, payload) checks a request payload against an ACTIONS schema such as
 *   { projectId: 'id?', description: 'text:0:500?', tagIds: 'ids:10?', clientAt: 'ms' }
 * and returns a NEW object holding only the schema's fields, normalised (text trimmed, email lower-cased). A failure
 * is thrown as VALIDATION with details.field naming the first bad field. Nothing is converted: "5" is not an int.
 *
 * Rules the spec leaves open, chosen here and recorded in docs/v2/questions.md:
 *   - A trailing "?" makes a field optional: it may be absent (left out of the result: "unchanged") or null (kept as
 *     null in the result: "clear"). A required field may be neither.
 *   - Unknown fields are reported first, then the schema's fields in the order the schema declares them.
 *   - Text is checked after trimming, by characters (code points), as SQLite's length() counts them. Tab and newline
 *     are allowed only in text whose maximum is 500 or more (descriptions and notes); never in shorter text (names).
 *     Other control characters, U+2028/2029 and lone surrogates are never allowed.
 *
 * The formula neutraliser is copied from the old code (apps-script/Code.gs, Validation.sanitizeCellValue and
 * ExportService.escapeCsv) and re-tested in tests/v2/validate.test.js.
 */
var Validate = {

  /** 10 years of 365.25 days: how far an "ms" value may be from the server clock. */
  TEN_YEARS_MS_: 315576000000,
  /** Text with a maximum of at least this many characters may contain tab and newline. */
  MULTILINE_FROM_MAX_: 500,
  /** A Google Sheets cell holds at most 50,000 characters. */
  MAX_CELL_CHARS_: 50000,
  /** The type "any": text of at most this many characters, or a list of at most ANY_IDS_MAX_ ids. */
  ANY_TEXT_MAX_: 500,
  ANY_IDS_MAX_: 50,

  UUID_PATTERN_: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  CODE_PATTERN_: /^[A-Z0-9_-]{1,20}$/,
  FIELD_NAME_PATTERN_: /^[A-Za-z_][A-Za-z0-9_]*$/,
  /** Control characters, line and paragraph separators. */
  SINGLE_LINE_BAD_: /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/,
  /** The same, except tab (U+0009) and newline (U+000A). */
  MULTI_LINE_BAD_: /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/,
  /** A string that spreadsheets may run as a formula: starts (after spaces) with = + - @ tab CR or LF. */
  FORMULA_START_: /^\s*[=+\-@\t\r\n]/,
  /** A plain number, which is safe even when it starts with + or -. */
  PLAIN_NUMBER_: /^\s*[-+]?\d+(\.\d+)?\s*$/,

  // ------------------------------------------------------------ errors

  /** The payload is wrong: the page can show message and highlight details.field. */
  fail_: function (field, message) {
    return new AppError_('VALIDATION', message, { field: field });
  },

  /** The calling code is wrong (a bad schema, a value that is not a cell). */
  bug_: function (detail) {
    return new AppError_('INTERNAL', 'An internal error occurred.', { error: detail });
  },

  // ------------------------------------------------------------ schemas

  /**
   * Parses one schema type such as 'text:0:500?' into { kind, optional, ... }. Throws INTERNAL for anything that is not
   * in the grammar of BUILD_SPEC section 6.1.
   */
  parseType_: function (spec) {
    if (typeof spec !== 'string' || spec === '') throw Validate.bug_('a schema type must be a non-empty string');
    var optional = spec.charAt(spec.length - 1) === '?';
    var parts = (optional ? spec.slice(0, -1) : spec).split(':');
    var kind = parts[0];
    var parsed = { kind: kind, optional: optional };
    var whole = function (text) {
      if (!/^-?\d+$/.test(text) || !Number.isSafeInteger(Number(text))) throw Validate.bug_('not a whole number in schema type ' + spec);
      return Number(text);
    };

    switch (kind) {
      case 'id': case 'code': case 'email': case 'bool': case 'ms': case 'date': case 'tz': case 'cursor': case 'any':
        if (parts.length !== 1) throw Validate.bug_(kind + ' takes no arguments: ' + spec);
        break;
      case 'ids':
        if (parts.length !== 2) throw Validate.bug_('ids needs a maximum count: ' + spec);
        parsed.n = whole(parts[1]);
        if (parsed.n < 1 || parsed.n > 1000) throw Validate.bug_('ids needs a count from 1 to 1000: ' + spec);
        break;
      case 'text':
        if (parts.length !== 3) throw Validate.bug_('text needs a minimum and a maximum: ' + spec);
        parsed.min = whole(parts[1]);
        parsed.max = whole(parts[2]);
        if (parsed.min < 0 || parsed.max < 1 || parsed.min > parsed.max) throw Validate.bug_('text needs 0 <= min <= max, max >= 1: ' + spec);
        break;
      case 'int':
        if (parts.length !== 3) throw Validate.bug_('int needs a minimum and a maximum: ' + spec);
        parsed.min = whole(parts[1]);
        parsed.max = whole(parts[2]);
        if (parsed.min > parsed.max) throw Validate.bug_('int needs min <= max: ' + spec);
        break;
      case 'enum': {
        if (parts.length < 2) throw Validate.bug_('enum needs options: ' + spec);
        var options = parts.slice(1).join(':').split('|');
        var seen = {};
        options.forEach(function (option) {
          if (option === '' || seen[option] === true) throw Validate.bug_('enum options must be non-empty and unique: ' + spec);
          seen[option] = true;
        });
        parsed.options = options;
        break;
      }
      default:
        throw Validate.bug_('unknown schema type ' + kind + ' in ' + spec);
    }
    return parsed;
  },

  /** Throws INTERNAL unless the schema is an object of valid types. The permission-matrix test runs it on every action. */
  checkSchema_: function (schema) {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw Validate.bug_('a schema must be an object');
    Object.keys(schema).forEach(function (name) {
      if (name === '__proto__' || !Validate.FIELD_NAME_PATTERN_.test(name)) throw Validate.bug_('schema field name not allowed: ' + name);
      try {
        Validate.parseType_(schema[name]);
      } catch (err) {
        throw Validate.bug_('schema field ' + name + ': ' + (err.details && err.details.error));
      }
    });
  },

  // ------------------------------------------------------------ values

  /** { length, lone }: the number of characters (code points) of a string, and whether it has a lone surrogate. */
  inspectText_: function (text) {
    var length = 0;
    var lone = false;
    for (var i = 0; i < text.length; i++) {
      var code = text.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        var next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
        if (next >= 0xdc00 && next <= 0xdfff) {
          i++;
        } else {
          lone = true;
        }
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        lone = true;
      }
      length++;
    }
    return { length: length, lone: lone };
  },

  /** An ASCII address: one @, a local part of at most 64 characters, a dotted domain with a letter-only last label. */
  isEmail_: function (text) {
    if (text.length < 3 || text.length > 254) return false;
    var at = text.indexOf('@');
    if (at < 1 || at !== text.lastIndexOf('@')) return false;
    var local = text.slice(0, at);
    var domain = text.slice(at + 1);
    if (local.length > 64) return false;
    if (!/^[a-z0-9!#$%&'*+\/=?^_`{|}~.-]+$/.test(local)) return false;
    if (local.charAt(0) === '.' || local.charAt(local.length - 1) === '.' || local.indexOf('..') >= 0) return false;
    var labels = domain.split('.');
    if (labels.length < 2) return false;
    for (var i = 0; i < labels.length; i++) {
      if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(labels[i])) return false;
    }
    return /^(?:[a-z]{2,}|xn--[a-z0-9-]+)$/.test(labels[labels.length - 1]);
  },

  /** A trimmed string of min..max characters without forbidden characters. */
  checkText_: function (field, spec, value) {
    if (typeof value !== 'string') throw Validate.fail_(field, field + ' must be text');
    var text = value.trim();
    var tooLong = field + ' must be at most ' + spec.max + ' characters';
    var range = spec.min === 0 ? tooLong : field + ' must be ' + spec.min + ' to ' + spec.max + ' characters';
    // a character is at most two UTF-16 units, so more than twice the maximum is certainly too long
    if (text.length > spec.max * 2) throw Validate.fail_(field, range);
    var multiline = spec.max >= Validate.MULTILINE_FROM_MAX_;
    var seen = Validate.inspectText_(text);
    if (seen.lone || (multiline ? Validate.MULTI_LINE_BAD_ : Validate.SINGLE_LINE_BAD_).test(text)) {
      throw Validate.fail_(field, field + ' contains characters that are not allowed');
    }
    if (seen.length < spec.min || seen.length > spec.max) throw Validate.fail_(field, range);
    return text;
  },

  /** The normalised value, or a thrown VALIDATION naming the field. */
  checkValue_: function (field, spec, value) {
    switch (spec.kind) {
      case 'id':
        if (typeof value === 'string' && Validate.UUID_PATTERN_.test(value)) return value;
        throw Validate.fail_(field, field + ' is not a valid id');

      case 'ids': {
        var message = field + ' must be a list of at most ' + spec.n + ' different ids';
        if (!Array.isArray(value) || value.length > spec.n) throw Validate.fail_(field, message);
        var seen = {};
        for (var i = 0; i < value.length; i++) {
          if (typeof value[i] !== 'string' || !Validate.UUID_PATTERN_.test(value[i]) || seen[value[i]] === true) {
            throw Validate.fail_(field, message);
          }
          seen[value[i]] = true;
        }
        return value.slice();
      }

      case 'text':
        return Validate.checkText_(field, spec, value);

      case 'code': {
        var code = typeof value === 'string' ? value.trim() : '';
        if (Validate.CODE_PATTERN_.test(code)) return code;
        throw Validate.fail_(field, field + ' must be 1 to 20 letters A-Z, digits, _ or -');
      }

      case 'email': {
        var email = typeof value === 'string' ? value.trim().toLowerCase() : '';
        if (Validate.isEmail_(email)) return email;
        throw Validate.fail_(field, field + ' is not a valid email address');
      }

      case 'bool':
        if (typeof value === 'boolean') return value;
        throw Validate.fail_(field, field + ' must be true or false');

      case 'int':
        if (Number.isSafeInteger(value) && value >= spec.min && value <= spec.max) return value === 0 ? 0 : value;
        throw Validate.fail_(field, field + ' must be a whole number from ' + spec.min + ' to ' + spec.max);

      case 'ms':
        if (Number.isSafeInteger(value) && Math.abs(value - Date.now()) <= Validate.TEN_YEARS_MS_) return value;
        throw Validate.fail_(field, field + ' is not a valid time');

      case 'date':
        if (typeof value === 'string' && Util.isDate_(value)) return value;
        throw Validate.fail_(field, field + ' must be a date as YYYY-MM-DD');

      case 'enum':
        if (typeof value === 'string' && spec.options.indexOf(value) >= 0) return value;
        throw Validate.fail_(field, field + ' must be one of ' + spec.options.join(', '));

      case 'tz':
        if (typeof value === 'string' && Util.isValidTimeZone_(value)) return value;
        throw Validate.fail_(field, field + ' is not a valid time zone');

      case 'cursor': {
        var ok = typeof value === 'string' && value.length >= 1 && value.length <= 200 &&
          !Validate.SINGLE_LINE_BAD_.test(value) && !Validate.inspectText_(value).lone;
        if (ok) return value;
        throw Validate.fail_(field, field + ' is not a valid cursor');
      }

      case 'any':
        // One JSON scalar or a short list of ids, nothing nested. For the two fields whose type depends on another
        // field (settings.patch.value, entries.bulk.value); the handler checks the value against that other field.
        if (typeof value === 'string') return Validate.checkText_(field, { min: 0, max: Validate.ANY_TEXT_MAX_ }, value);
        if (typeof value === 'boolean') return value;
        if (typeof value === 'number' && isFinite(value)) return value === 0 ? 0 : value;
        if (Array.isArray(value)) return Validate.checkValue_(field, { kind: 'ids', n: Validate.ANY_IDS_MAX_ }, value);
        throw Validate.fail_(field, field + ' must be text, a number, true or false, or a list of ids');

      default:
        throw Validate.bug_('unknown schema type ' + spec.kind);
    }
  },

  /**
   * Checks a payload against a schema and returns the normalised copy. A missing or null payload counts as {}.
   * Throws VALIDATION (details.field) for a bad payload and INTERNAL for a bad schema, which is checked first.
   */
  payload_: function (schema, payload) {
    Validate.checkSchema_(schema);
    var data = payload === undefined || payload === null ? {} : payload;
    if (typeof data !== 'object' || Array.isArray(data)) throw Validate.fail_('payload', 'The request body must be an object.');

    var hasOwn = Object.prototype.hasOwnProperty;
    var keys = Object.keys(data);
    for (var i = 0; i < keys.length; i++) {
      if (!hasOwn.call(schema, keys[i])) throw Validate.fail_(keys[i], keys[i] + ' is not allowed');
    }

    var result = {};
    var names = Object.keys(schema);
    for (var n = 0; n < names.length; n++) {
      var name = names[n];
      var spec = Validate.parseType_(schema[name]);
      var value = hasOwn.call(data, name) ? data[name] : undefined;
      if (value === undefined || value === null) {
        if (!spec.optional) throw Validate.fail_(name, name + ' is required');
        if (value === null) result[name] = null;
        continue;
      }
      result[name] = Validate.checkValue_(name, spec, value);
    }
    return result;
  },

  // ------------------------------------------------------------ formula neutralising

  /**
   * A value for a Sheets cell. A string that a spreadsheet could run as a formula gets an apostrophe in front;
   * plain numbers (even negative ones) do not. null and undefined become ''. Numbers and booleans pass through.
   * The result is at most 50,000 characters, prefix included, and never ends in half a surrogate pair.
   */
  neutralizeCell_: function (value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      if (!isFinite(value)) throw Validate.bug_('a cell cannot hold a non-finite number');
      return value;
    }
    if (typeof value !== 'string') throw Validate.bug_('a cell must be text, a number, a boolean or empty, not ' + typeof value);
    var text = value;
    if (!Validate.PLAIN_NUMBER_.test(text) && Validate.FORMULA_START_.test(text)) text = "'" + text;
    if (text.length > Validate.MAX_CELL_CHARS_) {
      text = text.substring(0, Validate.MAX_CELL_CHARS_);
      var last = text.charCodeAt(text.length - 1);
      if (last >= 0xd800 && last <= 0xdbff) text = text.slice(0, -1);
    }
    return text;
  },

  /** One CSV cell: always quoted, quotes doubled, formulas neutralised. null and undefined are an empty cell. */
  csvCell_: function (value) {
    if (value === null || value === undefined) return '""';
    var text;
    if (typeof value === 'string') {
      text = value;
    } else if (typeof value === 'boolean') {
      text = String(value);
    } else if (typeof value === 'number' && isFinite(value)) {
      text = String(value);
    } else {
      throw Validate.bug_('a CSV cell must be text, a number, a boolean or empty');
    }
    if (!Validate.PLAIN_NUMBER_.test(text) && Validate.FORMULA_START_.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  }
};
