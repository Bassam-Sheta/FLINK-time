/**
 * Main.gs - doGet, handleClientRequest, dispatcher (BUILD_SPEC sections 2, 4 and 9).
 * Top-level code only defines things (BUILD_SPEC section 2.1).
 *
 * The page calls google.script.run.handleClientRequest(action, envelope). The answer is always a response object and
 * never a thrown error (section 4.2). Main runs the eleven steps of section 4.4 in order; the steps about who the
 * caller is live in Auth.gs, the rest are here.
 */

/** The page. Makes no database call: the page draws at once and then calls app.bootstrap (section 9). */
function doGet(event) {
  return Main.doGet_(event);
}

/** The one function the page calls for everything else. Never throws. */
function handleClientRequest(action, envelope) {
  return Main.handleClientRequest_(action, envelope);
}

var Main = {

  VIEWS_: ['user', 'admin', 'superadmin'],
  /** The only fields an envelope may have (section 4.1). */
  ENVELOPE_FIELDS_: ['v', 'requestId', 'workspaceId', 'grant', 'payload'],
  INTERNAL_MESSAGE_: 'An internal error occurred.',

  // ------------------------------------------------------------ doGet

  /** The view the URL asks for: exactly user, admin or superadmin; anything else is the user view. */
  viewFrom_: function (event) {
    var parameter = Main.isObject_(event) ? event.parameter : undefined;
    var view = Main.isObject_(parameter) ? parameter.view : undefined;
    return typeof view === 'string' && Main.VIEWS_.indexOf(view) >= 0 ? view : 'user';
  },

  /** True for ?view=setup (exactly): the owner's setup page, which has its own rules (Setup.gs). */
  isSetup_: function (event) {
    var parameter = Main.isObject_(event) ? event.parameter : undefined;
    return Main.isObject_(parameter) && parameter.view === 'setup';
  },

  /**
   * One template for the three views. Only the user view may be framed (it lives inside a Google Site); the admin
   * views are served with the default frame mode, which refuses framing.
   */
  doGet_: function (event) {
    if (Main.isSetup_(event)) return Setup.page_();
    var view = Main.viewFrom_(event);
    var template = HtmlService.createTemplateFromFile('Portal');
    template.view = view;
    var output = template.evaluate()
      .setTitle('FLINK Time')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
    output.setXFrameOptionsMode(view === 'user' ? HtmlService.XFrameOptionsMode.ALLOWALL : HtmlService.XFrameOptionsMode.DEFAULT);
    return output;
  },

  // ------------------------------------------------------------ small helpers

  /** True for a non-null, non-array object, whichever realm made it. */
  isObject_: function (value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  },

  /** An envelope field, or undefined when the envelope is not an object or lacks it. */
  field_: function (envelope, name) {
    return Main.isObject_(envelope) && Object.prototype.hasOwnProperty.call(envelope, name) ? envelope[name] : undefined;
  },

  // ------------------------------------------------------------ steps 8 and 9: envelope, payload, request id

  /**
   * Checks the envelope (an object, v = 1, only the known fields), validates the payload against the action's schema
   * and, for a write, checks the request id and hashes the payload. Returns { payload, requestId, payloadHash }; the
   * request id and the hash are null for a read. The hash is over the normalised payload, so the same request sent
   * again hashes the same.
   */
  checkRequest_: function (entry, envelope) {
    if (!Main.isObject_(envelope)) throw Validate.fail_('envelope', 'The request is not valid.');
    if (envelope.v !== 1) throw Validate.fail_('v', 'This page is out of date; reload it.');
    Object.keys(envelope).forEach(function (name) {
      if (Main.ENVELOPE_FIELDS_.indexOf(name) < 0) throw Validate.fail_(name, name + ' is not allowed');
    });

    var payload = Validate.payload_(entry.schema, envelope.payload);
    var request = { payload: payload, requestId: null, payloadHash: null };
    if (entry.write === true) {
      var id = envelope.requestId;
      if (typeof id !== 'string' || !Validate.UUID_PATTERN_.test(id)) {
        throw Validate.fail_('requestId', 'requestId is required and must be an id');
      }
      request.requestId = id;
      request.payloadHash = Util.sha256Hex_(Util.canonicalJson_(payload));
    }
    return request;
  },

  // ------------------------------------------------------------ step 10: the handler

  /** The function named by an action's handler, such as 'ActTimer.start_': an own function of an own global. */
  resolveHandler_: function (name) {
    var parts = typeof name === 'string' ? name.split('.') : [];
    var hasOwn = Object.prototype.hasOwnProperty;
    if (parts.length !== 2 || !hasOwn.call(globalThis, parts[0])) throw Main.bug_('no module for handler ' + String(name));
    var owner = globalThis[parts[0]];
    if (owner === null || (typeof owner !== 'object' && typeof owner !== 'function') ||
        !hasOwn.call(owner, parts[1]) || typeof owner[parts[1]] !== 'function') {
      throw Main.bug_('handler ' + String(name) + ' is not implemented');
    }
    return { owner: owner, fn: owner[parts[1]] };
  },

  bug_: function (detail) {
    return new AppError_('INTERNAL', Main.INTERNAL_MESSAGE_, { error: detail });
  },

  /**
   * The context a handler gets (section 4.4, step 10): the caller (allowlisted account fields), their active
   * memberships, the workspace the request is about, the validated grant, the normalised payload, the request id and
   * its hash, the time, plus:
   *   action        the action name (Db.tx_ wants it)
   *   grantToken    the grant token as sent, when it has the right shape, for handlers that check a grant themselves
   *   rateLimit     for writes: RATE_LIMIT_WRITES_PER_MIN, for Db.tx_
   *   setting(key)  a setting's value for this workspace (or another, as the second argument). The settings are read
   *                 once, on first use, and only for the rest of this request
   */
  buildContext_: function (action, entry, account, workspace, grant, token, request, now) {
    var snapshot = null;
    var workspaceId = workspace === null ? undefined : workspace.id;
    var ctx = {
      action: action,
      user: account.user,
      memberships: account.memberships,
      workspace: workspace,
      grant: grant,
      grantToken: token,
      payload: request.payload,
      requestId: request.requestId,
      payloadHash: request.payloadHash,
      now: now,
      setting: function (key, forWorkspaceId) {
        if (snapshot === null) snapshot = Config.load_();
        return Config.value_(snapshot, key, forWorkspaceId === undefined ? workspaceId : forWorkspaceId);
      }
    };
    if (entry.write === true) ctx.rateLimit = ctx.setting('RATE_LIMIT_WRITES_PER_MIN');
    return ctx;
  },

  /**
   * ownerMaintenance(true) sets MAINTENANCE = 1. Every request for a known action is then answered with a retryable
   * DB_UNAVAILABLE (section 4.3 has no code of its own for it) before anything else is looked at.
   */
  checkMaintenance_: function () {
    if (PropertiesService.getScriptProperties().getProperty('MAINTENANCE') === '1') {
      throw new AppError_('DB_UNAVAILABLE', 'FLINK Time is down for maintenance. Try again in a few minutes.');
    }
  },

  /**
   * Steps 1 to 10 for one request: returns what the handler returned, or throws. state is filled in as far as the
   * request gets, for the log line: the action once it is a known one, the user id once the account is loaded.
   */
  run_: function (action, envelope, state, now) {
    var entry = Auth.actionEntry_(action);                                  // 1
    state.action = action;
    Main.checkMaintenance_();                                               // owner switch, not a step of 4.4
    var email = Auth.identity_();                                           // 2, 3
    var account = Auth.loadAccount_(email);                                 // 4
    if (account !== null) state.userId = account.user.id;
    Auth.checkAccount_(account);
    Auth.checkRole_(entry, account);                                        // 5
    var workspace = Auth.checkWorkspace_(entry, account, Main.field_(envelope, 'workspaceId'));   // 6
    var sent = Main.field_(envelope, 'grant');                              // 7
    var token = typeof sent === 'string' && Auth.GRANT_PATTERN_.test(sent) ? sent : null;
    var grant = Auth.checkGrant_(entry, sent, account.user, now);
    var request = Main.checkRequest_(entry, envelope);                      // 8, 9
    var ctx = Main.buildContext_(action, entry, account, workspace, grant, token, request, now);
    var handler = Main.resolveHandler_(entry.handler);                      // 10
    return handler.fn.call(handler.owner, ctx);
  },

  // ------------------------------------------------------------ step 11: the response and the log

  /** What the page may see in details for each code (section 4.3). Nothing else is passed on. */
  publicDetails_: function (code, details) {
    var source = Main.isObject_(details) ? details : {};
    var out = {};
    switch (code) {
      case 'VALIDATION':
        if (typeof source.field === 'string') out.field = source.field.slice(0, 80);
        break;
      case 'POLICY':
        if (typeof source.rule === 'string') out.rule = source.rule.slice(0, 80);
        break;
      case 'LOCKED_OUT':
        if (Number.isSafeInteger(source.until)) out.until = source.until;
        if (source.hard === true) out.hard = true;
        break;
      case 'RATE_LIMITED':
        out.retryAfterSeconds = ERROR_CODES_.RATE_LIMITED.retryAfterSeconds;
        break;
      default:
        break;
    }
    return out;
  },

  /** Removes what must never reach a log: emails, then anything that could be a token or a key (40+ token characters). */
  scrub_: function (text) {
    return String(text)
      .replace(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+/g, '[email]')
      .replace(/[A-Za-z0-9_\-.=+\/]{40,}/g, '[redacted]')
      .slice(0, 1000);
  },

  /** console calls must never break a request. */
  write_: function (level, text) {
    try {
      console[level](text);
    } catch (err) {
      // nothing more can be done about a broken log
    }
  },

  /** The real cause of an INTERNAL error goes to the log under the id the page was given. */
  logInternal_: function (correlationId, err) {
    var cause;
    try {
      if (err instanceof AppError_) {
        var details;
        try {
          details = JSON.stringify(err.details);
        } catch (stringifyError) {
          details = String(err.details);
        }
        cause = String(err.message) + ' ' + details;
      } else {
        cause = String(err && err.name) + ': ' + String(err && err.message);
      }
      var stack = err && typeof err.stack === 'string' ? err.stack.split('\n').slice(0, 4).join(' | ') : '';
      Main.write_('error', 'INTERNAL correlationId=' + correlationId + ' ' + Main.scrub_(cause + ' ' + stack));
    } catch (loggingError) {
      Main.write_('error', 'INTERNAL correlationId=' + correlationId);
    }
  },

  /** The response contract for a failure (section 4.2). Anything that is not a known AppError_ is INTERNAL. */
  failure_: function (err) {
    if (!(err instanceof AppError_) || err.code === 'INTERNAL') {
      var correlationId = Util.id_();
      Main.logInternal_(correlationId, err);
      return { ok: false, code: 'INTERNAL', message: Main.INTERNAL_MESSAGE_, retryable: false, details: { correlationId: correlationId } };
    }
    if (err.code === 'DB_UNAVAILABLE') {
      // the Turso client puts the failing call's text in details; the operator may read it, the page may not
      try {
        Main.write_('warn', 'DB_UNAVAILABLE ' + Main.scrub_(JSON.stringify(err.details)));
      } catch (stringifyError) {
        Main.write_('warn', 'DB_UNAVAILABLE');
      }
    }
    return {
      ok: false,
      code: err.code,
      message: String(err.message),
      retryable: err.retryable === true,
      details: Main.publicDetails_(err.code, err.details)
    };
  },

  /** A response as plain JSON, the way google.script.run will carry it. Throws if it cannot be. */
  plain_: function (response) {
    return JSON.parse(JSON.stringify(response));
  },

  /**
   * One log line per request: the action (only once it is a known one, never text the caller made up), the outcome,
   * the time taken, and the caller's user id once known. Never payloads, emails or tokens.
   */
  log_: function (state, response, milliseconds) {
    var line = 'request action=' + (state.action === null ? '(unknown)' : state.action) +
      ' outcome=' + (response.ok ? 'OK' : response.code) + ' ms=' + milliseconds;
    if (state.userId !== null) line += ' user=' + state.userId;
    Main.write_('log', line);
  },

  /** Steps 1 to 11 for one request. Always returns a response. */
  handleClientRequest_: function (action, envelope) {
    var started = Date.now();
    var state = { action: null, userId: null };
    var response;
    try {
      var data = Main.run_(action, envelope, state, started);
      response = Main.plain_({ ok: true, data: data === undefined ? {} : data, serverNow: Date.now() });
    } catch (err) {
      try {
        response = Main.failure_(err);
      } catch (failureError) {
        response = { ok: false, code: 'INTERNAL', message: Main.INTERNAL_MESSAGE_, retryable: false, details: {} };
      }
    }
    try {
      Main.log_(state, response, Date.now() - started);
    } catch (logError) {
      // the response matters more than its log line
    }
    return response;
  }
};
