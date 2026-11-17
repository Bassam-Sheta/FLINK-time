/**
 * Auth.gs - identity, account loading, permission map, server rules (BUILD_SPEC sections 2, 4.4, 6.1 and 7.3).
 * Top-level code only defines things (BUILD_SPEC section 2.1).
 *
 * Each step of the request pipeline (section 4.4) that is about WHO is calling lives here, as its own function:
 *
 *   actionEntry_      step 1   the action's entry in ACTIONS
 *   identity_         steps 2-3  the signed-in email, trimmed, lower-cased and in the company domain
 *   loadAccount_      step 4   the account and its memberships (cache 60 s, key acct:{gen}:{email})
 *   checkAccount_     step 4   NOT_PROVISIONED, ACCOUNT_INACTIVE
 *   checkRole_        step 5
 *   checkWorkspace_   step 6
 *   checkGrant_       step 7   a valid admin grant, and a fresh step-up code when the action asks for one
 *
 * Main.gs calls them in that order. Handlers use requireStepUp_ (when they decide that a step-up is needed, such as
 * editing someone else's entry) and dbCtx_ (the context Db.tx_ wants).
 */

/**
 * The permission map (BUILD_SPEC section 6.1): one entry per action, filled in by ticket T1.9. An entry is
 * { roles, ws, wsAdmin, grant, stepUp, write, readOnlyOk, schema, handler } where ws is true, false or 'optional'
 * and handler is the name of a function in a module, such as 'ActTimer.start_'.
 */
var ACTIONS = {};

var Auth = {

  /** A grant token: 128 lower-case hex digits (section 7.3). Anything else is refused without a lookup. */
  GRANT_PATTERN_: /^[0-9a-f]{128}$/,
  /** A step-up code stays fresh for 5 minutes (section 4.4, step 7). */
  STEP_UP_WINDOW_MS_: 300000,
  /** Printable ASCII with no space: the only kind of address the app accepts. */
  EMAIL_PATTERN_: /^[!-~]+$/,
  MAX_EMAIL_LENGTH_: 254,

  // ------------------------------------------------------------ errors

  forbidden_: function (message) {
    return new AppError_('FORBIDDEN', message || 'You do not have access to this.');
  },

  bug_: function (detail) {
    return new AppError_('INTERNAL', 'An internal error occurred.', { error: detail });
  },

  // ------------------------------------------------------------ step 1: the action

  /** The entry of ACTIONS for an action name. A name that is not an own property of ACTIONS is FORBIDDEN. */
  actionEntry_: function (action) {
    if (typeof action !== 'string' || !Object.prototype.hasOwnProperty.call(ACTIONS, action)) {
      throw Auth.forbidden_();
    }
    return ACTIONS[action];
  },

  // ------------------------------------------------------------ steps 2 and 3: the email

  /** The signed-in Google account's email, trimmed. Blank means Google did not reveal it: AUTH_UNAVAILABLE. */
  sessionEmail_: function () {
    var raw = Session.getActiveUser().getEmail();
    var text = typeof raw === 'string' ? raw.trim() : '';
    if (text === '') {
      throw new AppError_('AUTH_UNAVAILABLE', 'Your Google account email could not be read. Sign in with your company account and reload.');
    }
    return text;
  },

  /**
   * The email trimmed and lower-cased, or null when it is not an address this app accepts. Only printable ASCII is
   * accepted, and it is checked BEFORE lower-casing: some non-ASCII letters (the Kelvin sign, for one) lower-case to
   * ASCII ones and would otherwise pass for another address.
   */
  normalizeEmail_: function (text) {
    var trimmed = String(text).trim();
    if (trimmed === '' || trimmed.length > Auth.MAX_EMAIL_LENGTH_ || !Auth.EMAIL_PATTERN_.test(trimmed)) return null;
    return trimmed.toLowerCase();
  },

  /** The text after the last @, or null when there is none. */
  domainOf_: function (email) {
    var at = String(email).lastIndexOf('@');
    return at < 0 ? null : String(email).slice(at + 1);
  },

  /** Script Property COMPANY_DOMAIN, trimmed and lower-cased. Missing means setup was not done: fail closed. */
  companyDomain_: function () {
    var raw = PropertiesService.getScriptProperties().getProperty('COMPANY_DOMAIN');
    var domain = raw === null || raw === undefined ? '' : String(raw).trim().toLowerCase();
    if (domain === '') throw Auth.bug_('COMPANY_DOMAIN is not set');
    return domain;
  },

  /**
   * Steps 2 and 3: the caller's normalised email. FORBIDDEN unless it is a plain address whose domain (the text after
   * the last @) equals COMPANY_DOMAIN exactly.
   */
  identity_: function () {
    var email = Auth.normalizeEmail_(Auth.sessionEmail_());
    if (email === null) throw Auth.forbidden_();
    var domain = Auth.domainOf_(email);
    // no @ at all, or nothing in front of it
    if (domain === null || email.length === domain.length + 1) throw Auth.forbidden_();
    if (domain !== Auth.companyDomain_()) throw Auth.forbidden_();
    return email;
  },

  // ------------------------------------------------------------ step 4: the account

  /** True for an object that looks like what loadAccount_ stores. */
  isAccount_: function (value) {
    return value !== null && typeof value === 'object' && value.user !== null && typeof value.user === 'object' &&
      typeof value.user.id === 'string' && Array.isArray(value.memberships);
  },

  /**
   * The account for an email, with its active memberships (and, for a Super Admin, every workspace), or null when
   * there is no such account. Cached 60 s under acct:{gen}:{email}; bumping gen:acct drops every entry at once.
   * One Turso call on a miss. Holds nothing secret: admin_mfa is never read here.
   */
  loadAccount_: function (email) {
    var key = Cache.acctKey_(email);
    var cached = Cache.get_(key);
    if (Auth.isAccount_(cached)) return cached;

    var results = Db.read_([
      {
        sql: 'SELECT id, email, display_name, role, status, employee_code, is_root, auth_epoch, admin_ws_limit, version ' +
          'FROM accounts WHERE email = ?',
        args: [email]
      },
      {
        sql: 'SELECT m.workspace_id, m.ws_role, w.name, w.status, w.timezone, w.week_start ' +
          'FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id ' +
          'WHERE m.user_id = (SELECT id FROM accounts WHERE email = ?) AND m.active = 1 ORDER BY w.created_at, w.id',
        args: [email]
      },
      {
        sql: 'SELECT id, name, status, timezone, week_start FROM workspaces ' +
          "WHERE (SELECT role FROM accounts WHERE email = ?) = 'SUPER_ADMIN' ORDER BY created_at, id",
        args: [email]
      }
    ]);
    if (results[0].length === 0) return null;

    var row = results[0][0];
    var account = {
      user: {
        id: row.id,
        email: row.email,
        displayName: row.display_name,
        role: row.role,
        status: row.status,
        employeeCode: row.employee_code,
        isRoot: row.is_root === 1,
        authEpoch: row.auth_epoch,
        adminWsLimit: row.admin_ws_limit,
        version: row.version
      },
      memberships: results[1].map(function (m) {
        return {
          workspaceId: m.workspace_id, wsRole: m.ws_role, name: m.name, status: m.status,
          timezone: m.timezone, weekStart: m.week_start
        };
      }),
      workspaces: row.role === 'SUPER_ADMIN' ? results[2].map(function (w) {
        return { id: w.id, name: w.name, status: w.status, timezone: w.timezone, weekStart: w.week_start };
      }) : null
    };
    Cache.put_(key, account, Cache.TTL_.ACCT);
    return account;
  },

  /** Step 4: NOT_PROVISIONED when there is no account, ACCOUNT_INACTIVE when it is switched off. */
  checkAccount_: function (account) {
    if (account === null || account === undefined) {
      throw new AppError_('NOT_PROVISIONED', 'Your account has not been set up yet. Ask your administrator.');
    }
    if (account.user.status !== 'ACTIVE') {
      throw new AppError_('ACCOUNT_INACTIVE', 'Your account is inactive. Ask your administrator.');
    }
  },

  // ------------------------------------------------------------ step 5: the role

  checkRole_: function (entry, account) {
    if (!Array.isArray(entry.roles) || entry.roles.indexOf(account.user.role) < 0) throw Auth.forbidden_();
  },

  // ------------------------------------------------------------ step 6: the workspace

  /** The first element of list whose property `name` equals value, or null. */
  find_: function (list, name, value) {
    for (var i = 0; i < list.length; i++) {
      if (list[i][name] === value) return list[i];
    }
    return null;
  },

  /**
   * Step 6. Returns null for an action without a workspace, else { id, name, status, timezone, weekStart, wsRole,
   * isWsAdmin } for the workspace the request is about.
   *
   * The caller must be an active member (the cached memberships hold only active ones); a Super Admin passes for any
   * workspace that exists. A workspace the caller may not see and one that does not exist get the same FORBIDDEN, so
   * ids cannot be probed. An archived workspace is open only to actions marked readOnlyOk, for everybody (section 7.1,
   * rule 5). A workspace-admin action needs isWsAdmin: a Super Admin, or an ADMIN account whose ws_role is ADMIN there.
   * ws: 'optional' means the workspace is checked only when the request names one.
   */
  checkWorkspace_: function (entry, account, workspaceId) {
    var mode = entry.ws;
    if (mode !== true && mode !== 'optional') return null;
    if (mode === 'optional' && (workspaceId === undefined || workspaceId === null)) return null;
    if (typeof workspaceId !== 'string' || !Validate.UUID_PATTERN_.test(workspaceId)) {
      throw Validate.fail_('workspaceId', 'workspaceId is required and must be an id');
    }

    var role = account.user.role;
    var membership = Auth.find_(account.memberships, 'workspaceId', workspaceId);
    var workspace = null;
    if (membership !== null) {
      workspace = { id: membership.workspaceId, name: membership.name, status: membership.status,
        timezone: membership.timezone, weekStart: membership.weekStart };
    } else if (role === 'SUPER_ADMIN' && Array.isArray(account.workspaces)) {
      var found = Auth.find_(account.workspaces, 'id', workspaceId);
      if (found !== null) {
        workspace = { id: found.id, name: found.name, status: found.status, timezone: found.timezone, weekStart: found.weekStart };
      }
    }
    if (workspace === null) throw Auth.forbidden_('You do not have access to this workspace.');
    if (workspace.status !== 'ACTIVE' && entry.readOnlyOk !== true) {
      throw Auth.forbidden_('This workspace is archived and read-only.');
    }

    var isWsAdmin = role === 'SUPER_ADMIN' || (role === 'ADMIN' && membership !== null && membership.wsRole === 'ADMIN');
    if (entry.wsAdmin === true && !isWsAdmin) throw Auth.forbidden_('You do not have access to this workspace.');
    workspace.wsRole = membership === null ? null : membership.wsRole;
    workspace.isWsAdmin = isWsAdmin;
    return workspace;
  },

  // ------------------------------------------------------------ step 7: grant and step-up

  /**
   * A valid admin grant for the user, or CODE_REQUIRED. A token that is not 128 hex digits is refused without a
   * lookup. The check itself is Grants.check_(token, user, now) (ticket T3.3): it returns the grant, an object with
   * stepupAt (ms), or throws CODE_REQUIRED.
   */
  validGrant_: function (token, user, now) {
    if (typeof token !== 'string' || !Auth.GRANT_PATTERN_.test(token)) {
      throw new AppError_('CODE_REQUIRED', 'Enter your authenticator code.');
    }
    var grant = Grants.check_(token, user, now);
    if (grant === null || typeof grant !== 'object') throw Auth.bug_('Grants.check_ returned no grant');
    return grant;
  },

  /** STEP_UP_REQUIRED unless the grant's step-up is at most 5 minutes old. Anything unreadable counts as stale. */
  requireFresh_: function (grant, now) {
    var at = grant.stepupAt;
    if (!Number.isSafeInteger(at) || now - at > Auth.STEP_UP_WINDOW_MS_) {
      throw new AppError_('STEP_UP_REQUIRED', 'Enter a fresh authenticator code to continue.');
    }
  },

  /**
   * Step 7 for an action's flags: null when it needs neither, else the valid grant. An action that needs a step-up
   * needs a grant first, whether or not it says grant: true.
   */
  checkGrant_: function (entry, token, user, now) {
    if (entry.grant !== true && entry.stepUp !== true) return null;
    var grant = Auth.validGrant_(token, user, now);
    if (entry.stepUp === true) Auth.requireFresh_(grant, now);
    return grant;
  },

  /**
   * For a handler that decides itself that a step-up is needed (editing someone else's entry): uses the grant the
   * pipeline already checked, or checks ctx.grantToken now. Returns the grant and keeps it in ctx.grant.
   */
  requireStepUp_: function (ctx) {
    var grant = ctx.grant;
    if (grant === null || grant === undefined) {
      grant = Auth.validGrant_(ctx.grantToken, ctx.user, ctx.now);
      ctx.grant = grant;
    }
    Auth.requireFresh_(grant, ctx.now);
    return grant;
  },

  // ------------------------------------------------------------ for handlers

  /** The context Db.tx_ takes (BUILD_SPEC section 5.3), from a handler's ctx. Only for write actions. */
  dbCtx_: function (ctx) {
    return {
      userId: ctx.user.id,
      requestId: ctx.requestId,
      action: ctx.action,
      payloadHash: ctx.payloadHash,
      now: ctx.now,
      rateLimit: ctx.rateLimit
    };
  }
};
