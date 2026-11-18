/**
 * Setup.gs - the single-use owner setup page and the owner functions (BUILD_SPEC sections 7.2, 8 and 12).
 * Top-level code only defines things (BUILD_SPEC section 2.1).
 *
 * Every top-level function without a trailing underscore can be called from any employee's browser through
 * google.script.run, so the public functions below are the owner functions of section 8 plus setupSubmit (the one
 * server call of the setup page), and each starts with Setup.requireOwner_().
 *
 * The owner check is stricter than section 8's `getEffectiveUser() === OWNER_EMAIL`. The web app runs as its deployer
 * (executeAs USER_DEPLOYING), so for every visitor the effective user is the owner, and that check would pass for every
 * employee. Here the ACTIVE user, the person actually running the function or visiting the page, must be the effective
 * user, and both must be OWNER_EMAIL once the setup page has recorded it. Run from the editor, both are the owner.
 */

/** The setup page's one server call. */
function setupSubmit(form) {
  return Setup.submit_(form);
}

/** Owner function: applies pending database migrations. */
function runMigrations() {
  return Setup.runMigrations_();
}

/** Owner function: replaces this project's triggers with the schedule of section 8. */
function installTriggers() {
  return Setup.installTriggers_();
}

/** Owner function: makes an address in the company domain a Super Admin (the only way the role is granted). */
function ownerGrantSuperAdmin(email) {
  return Setup.grantSuperAdmin_(email);
}

/** Owner function: true stops the app answering requests, false lets it answer again. */
function ownerMaintenance(on) {
  return Setup.maintenance_(on);
}

/** Owner function: starts sealing the audit log with a new key; old rows keep verifying with the old one. */
function ownerRotateAuditKey() {
  return Setup.rotateKey_('AUDIT');
}

/** Owner function: new TOTP secrets are encrypted with a new key; old ones keep decrypting with the old one. */
function ownerRotateTotpKey() {
  return Setup.rotateKey_('TOTP');
}

var Setup = {

  TIMEZONE_: 'Africa/Cairo',

  /**
   * The schedule of section 8. unit/n: how often; hour and minute: when (the minute is "near", Apps Script runs it within
   * 15 minutes of it); weekDay: for a weekly trigger. jobBackup has two: weekly, and every 10 minutes so that a backup
   * that stopped at its time limit carries on (the job does nothing unless one is RUNNING).
   */
  TRIGGERS_: [
    { handler: 'jobSealAudit', unit: 'minutes', n: 1, text: 'every minute' },
    { handler: 'jobAutoStop', unit: 'hours', n: 1, text: 'every hour' },
    { handler: 'jobDailyExport', unit: 'days', n: 1, hour: 1, minute: 30, text: 'daily at 01:30' },
    { handler: 'jobVerifyChain', unit: 'days', n: 1, hour: 2, minute: 30, text: 'daily at 02:30' },
    { handler: 'jobBackup', unit: 'weeks', n: 1, weekDay: 'SUNDAY', hour: 3, minute: 0, text: 'Sundays at 03:00' },
    { handler: 'jobBackup', unit: 'minutes', n: 10, text: 'every 10 minutes' },
    { handler: 'jobPurge', unit: 'days', n: 1, hour: 4, minute: 0, text: 'daily at 04:00' },
    { handler: 'jobHealth', unit: 'hours', n: 1, text: 'every hour' }
  ],

  // ------------------------------------------------------------ the owner check

  normEmail_: function (raw) {
    return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  },

  /**
   * True when the person running is the effective user and, once OWNER_EMAIL is recorded, is that owner. Before the
   * setup page has run there is no OWNER_EMAIL, and the deployer (effective user) is the owner. A blank (Google did not
   * reveal who is running) is never the owner: active is non-blank and equal to effective, so both are.
   */
  isOwner_: function () {
    var active = Setup.normEmail_(Session.getActiveUser().getEmail());
    var effective = Setup.normEmail_(Session.getEffectiveUser().getEmail());
    var owner = Setup.normEmail_(PropertiesService.getScriptProperties().getProperty('OWNER_EMAIL'));
    return active !== '' && active === effective && (owner === '' || owner === effective);
  },

  requireOwner_: function () {
    if (!Setup.isOwner_()) throw new AppError_('FORBIDDEN', 'This can only be run by the owner of the script.');
  },

  // ------------------------------------------------------------ the setup page

  PAGE_STYLE_: 'body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem}' +
    'label{display:block;margin-top:1rem;font-weight:600}input{width:100%;box-sizing:border-box;padding:.5rem;font:inherit}' +
    'button{margin-top:1.5rem;padding:.6rem 1.2rem;font:inherit}pre{white-space:pre-wrap}',

  shell_: function (body, script) {
    return '<!DOCTYPE html><html><head><base target="_top"><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1"><title>FLINK Time setup</title>' +
      '<style>' + Setup.PAGE_STYLE_ + '</style></head><body>' + body + (script ? '<script>' + script + '</script>' : '') + '</body></html>';
  },

  /** The form: static markup, no stored value, answers shown with textContent. */
  formHtml_: function () {
    var field = function (id, label, type, hint) {
      return '<label for="' + id + '">' + label + '</label><input id="' + id + '" name="' + id + '" type="' + type +
        '" autocomplete="off" spellcheck="false"><small>' + hint + '</small>';
    };
    var body = '<h1>FLINK Time setup</h1>' +
      '<p>Run once, by the owner of this script. It stores the connection settings, generates the keys, creates the ' +
      'database tables and your root Super Admin account.</p>' +
      '<form id="setup">' +
      field('tursoUrl', 'Turso database URL', 'text', 'libsql://... or https://...') +
      field('rwToken', 'Read-write token', 'password', 'Used for every change.') +
      field('roToken', 'Read-only token', 'password', 'Must be different from the read-write token.') +
      field('companyDomain', 'Company email domain', 'text', 'For example example.com. Your own address must be in it.') +
      field('alertEmail', 'Alert email address', 'text', 'Where security alerts are sent.') +
      '<button type="submit" id="go">Run setup</button></form><pre id="out"></pre>';
    var script = "var ids=['tursoUrl','rwToken','roToken','companyDomain','alertEmail'];" +
      "document.getElementById('setup').addEventListener('submit',function(e){e.preventDefault();" +
      "var data={};ids.forEach(function(id){data[id]=document.getElementById(id).value;});" +
      "var out=document.getElementById('out');var go=document.getElementById('go');go.disabled=true;out.textContent='Working...';" +
      "google.script.run.withSuccessHandler(function(r){out.textContent=r.steps.join('\\n');})" +
      ".withFailureHandler(function(err){go.disabled=false;out.textContent='Failed: '+(err&&err.message?err.message:err);})" +
      '.setupSubmit(data);});';
    return Setup.shell_(body, script);
  },

  /** The page for ?view=setup: the form for the owner before setup, otherwise a plain message with nothing to fill in. */
  page_: function () {
    var done = PropertiesService.getScriptProperties().getProperty('SETUP_DONE') === '1';
    var html;
    if (done) {
      html = Setup.shell_('<h1>FLINK Time setup</h1><p>Setup is complete.</p>');
    } else if (Setup.isOwner_()) {
      html = Setup.formHtml_();
    } else {
      html = Setup.shell_('<h1>FLINK Time setup</h1><p>This page is for the owner of the script.</p>');
    }
    return HtmlService.createHtmlOutput(html)
      .setTitle('FLINK Time setup')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
  },

  // ------------------------------------------------------------ the setup form

  /**
   * The database URL as https://host[:port] with no path: libsql:// becomes https://, the host is lower-cased and
   * trailing slashes are dropped. Anything else (http, a path, a query, a user, a host with no dot) is VALIDATION.
   */
  tursoUrl_: function (text) {
    var bad = Validate.fail_('tursoUrl', 'tursoUrl must be the database address, such as libsql://name-org.turso.io');
    if (typeof text !== 'string') throw bad;
    var match = /^(?:libsql|https):\/\/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)(?::([0-9]{1,5}))?$/i
      .exec(text.trim().replace(/\/+$/, ''));
    if (match === null) throw bad;
    if (match[2] !== undefined && Number(match[2]) > 65535) throw bad;
    return 'https://' + match[1].toLowerCase() + (match[2] === undefined ? '' : ':' + match[2]);
  },

  /** A plain dotted domain in lower case, or VALIDATION. */
  companyDomain_: function (text) {
    var domain = typeof text === 'string' ? text.trim().toLowerCase() : '';
    var label = '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?';
    if (!new RegExp('^(?:' + label + '\\.)+(?:[a-z]{2,}|xn--[a-z0-9-]+)$').test(domain) || domain.length > 253) {
      throw Validate.fail_('companyDomain', 'companyDomain must be a domain such as example.com');
    }
    return domain;
  },

  /** 64 hex digits from three UUIDs hashed with SHA-256 (section 8): the keys and the pepper. */
  newKey_: function () {
    return Util.sha256Hex_(Util.id_() + Util.id_() + Util.id_());
  },

  displayName_: function (email) {
    var local = String(email).split('@')[0];
    return local.slice(0, 120);
  },

  /** Writes a property only when it is not set yet: regenerating a key after rows were sealed would break the chain. */
  ensure_: function (properties, name, make) {
    var current = properties.getProperty(name);
    if (current === null || current === undefined || current === '') properties.setProperty(name, make());
  },

  /**
   * Steps, in order, each safe to repeat: check the owner and that setup is not done; check the whole form (nothing is
   * written if any field is wrong); store the connection settings and OWNER_EMAIL; create the keys that do not exist;
   * apply the migrations; create the root Super Admin (the owner, D1) unless a root exists; then SETUP_DONE = 1, which
   * closes the page for good. A setup that stops half way leaves the page open and is simply run again.
   */
  submit_: function (form) {
    Setup.requireOwner_();
    var properties = PropertiesService.getScriptProperties();
    if (properties.getProperty('SETUP_DONE') === '1') throw new AppError_('FORBIDDEN', 'Setup is already complete.');

    var input = Validate.payload_({
      tursoUrl: 'text:8:300', rwToken: 'text:6:4000', roToken: 'text:6:4000', companyDomain: 'text:3:253', alertEmail: 'email'
    }, form);
    var url = Setup.tursoUrl_(input.tursoUrl);
    var domain = Setup.companyDomain_(input.companyDomain);
    if (/\s/.test(input.rwToken)) throw Validate.fail_('rwToken', 'rwToken must not contain spaces');
    if (/\s/.test(input.roToken)) throw Validate.fail_('roToken', 'roToken must not contain spaces');
    if (input.roToken === input.rwToken) throw Validate.fail_('roToken', 'The read-only token must be different from the read-write token');
    var owner = Setup.normEmail_(Session.getEffectiveUser().getEmail());
    if (Auth.domainOf_(owner) !== domain) {
      throw Validate.fail_('companyDomain', 'The company domain must be the domain of your own address, or you would lock yourself out');
    }

    var steps = [];
    properties.setProperties({
      TURSO_URL: url, TURSO_RW_TOKEN: input.rwToken, TURSO_RO_TOKEN: input.roToken, COMPANY_DOMAIN: domain,
      ALERT_EMAIL: input.alertEmail, OWNER_EMAIL: owner
    });
    steps.push('Saved the connection settings.');
    ['AUDIT_HMAC_KEY_v1', 'TOTP_ENC_KEY_v1', 'CODE_PEPPER'].forEach(function (name) { Setup.ensure_(properties, name, Setup.newKey_); });
    Setup.ensure_(properties, 'AUDIT_KEY_VERSION', function () { return '1'; });
    Setup.ensure_(properties, 'TOTP_KEY_VERSION', function () { return '1'; });
    steps.push('Generated the keys that were missing.');

    var migrated = Migrations.run_();
    steps.push(migrated.applied.length > 0 ? 'Created the database tables.' : 'The database tables were already there.');

    steps.push(Setup.createRoot_(owner) ? 'Created your root Super Admin account.' : 'Your root Super Admin account was already there.');
    Cache.bump_(Cache.GEN_ACCT_);

    properties.setProperty('SETUP_DONE', '1');
    steps.push('Setup is complete and this page is now closed.');
    console.log('setup completed');
    return { ok: true, steps: steps };
  },

  /** The root account (is_root = 1) for the owner, once. Returns whether it was created now. */
  createRoot_: function (owner) {
    var existing = Db.read_([{ sql: 'SELECT COUNT(*) AS n FROM accounts WHERE is_root = 1' }], { token: 'rw' })[0][0].n;
    if (existing > 0) return false;
    var now = Date.now();
    var id = Util.id_();
    var tx = Db.tx_({ userId: 'SYSTEM', requestId: 'setup:root', action: 'setup.root', payloadHash: Util.sha256Hex_(owner), now: now });
    tx.assert('no root', 'NOT EXISTS (SELECT 1 FROM accounts WHERE is_root = 1)', [], 'CONFLICT', 'A root account already exists.');
    tx.exec('root',
      'INSERT INTO accounts (id, email, display_name, role, status, employee_code, is_root, auth_epoch, admin_ws_limit, created_at, updated_at, version) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, owner, Setup.displayName_(owner), 'SUPER_ADMIN', 'ACTIVE', null, 1, 1, null, now, now, 1]);
    tx.audit(Audit.row_({ requestId: 'setup:root', now: now }, {
      entityType: 'ACCOUNT', entityId: id, action: 'ROOT_CREATED', after: { role: 'SUPER_ADMIN', status: 'ACTIVE', root: true }, reason: 'setup'
    }));
    tx.result({ id: id });
    return tx.commit().duplicate !== true;
  },

  // ------------------------------------------------------------ owner functions

  runMigrations_: function () {
    Setup.requireOwner_();
    return Migrations.run_();
  },

  /** The functions the schedule names must exist: a trigger for a missing function only fails later, by mail. */
  installTriggers_: function () {
    Setup.requireOwner_();
    var missing = [];
    Setup.TRIGGERS_.forEach(function (spec) {
      if (typeof globalThis[spec.handler] !== 'function' && missing.indexOf(spec.handler) < 0) missing.push(spec.handler);
    });
    if (missing.length > 0) throw Setup.bug_('these job functions are not defined yet: ' + missing.join(', '));

    ScriptApp.getProjectTriggers().forEach(function (trigger) { ScriptApp.deleteTrigger(trigger); });
    var created = Setup.TRIGGERS_.map(function (spec) {
      var builder = ScriptApp.newTrigger(spec.handler).timeBased();
      if (spec.weekDay) builder = builder.onWeekDay(ScriptApp.WeekDay[spec.weekDay]);
      if (spec.hour !== undefined) builder = builder.atHour(spec.hour);
      if (spec.minute !== undefined) builder = builder.nearMinute(spec.minute);
      switch (spec.unit) {
        case 'minutes': builder = builder.everyMinutes(spec.n); break;
        case 'hours': builder = builder.everyHours(spec.n); break;
        case 'days': builder = builder.everyDays(spec.n); break;
        default: builder = builder.everyWeeks(spec.n); break;
      }
      if (spec.hour !== undefined) builder = builder.inTimezone(Setup.TIMEZONE_);
      builder.create();
      return { handler: spec.handler, schedule: spec.text };
    });
    console.log('installed ' + created.length + ' triggers');
    return { created: created };
  },

  bug_: function (detail) {
    return new AppError_('INTERNAL', 'An internal error occurred.', { error: detail });
  },

  /**
   * Makes an address in the company domain an active Super Admin, creating the account if there is none. One SYSTEM
   * transaction with an audit row, then the account cache is dropped and ALERT_EMAIL is told (plan: an alert on every
   * Super Admin change). Someone who already is one is left alone. The root keeps its place; nothing here makes a root.
   */
  grantSuperAdmin_: function (email) {
    Setup.requireOwner_();
    var input = Validate.payload_({ email: 'email' }, { email: email });
    if (Auth.domainOf_(input.email) !== Auth.companyDomain_()) {
      throw Validate.fail_('email', 'email must be an address in the company domain');
    }

    var found = Db.read_([{
      sql: 'SELECT id, role, status, version FROM accounts WHERE email = ?', args: [input.email]
    }], { token: 'rw' })[0];
    var current = found.length > 0 ? found[0] : null;
    if (current !== null && current.role === 'SUPER_ADMIN' && current.status === 'ACTIVE') {
      return { email: input.email, changed: false, created: false };
    }

    var now = Date.now();
    var id = current === null ? Util.id_() : current.id;
    var requestId = 'owner:sa:' + Util.id_();
    var tx = Db.tx_({
      userId: 'SYSTEM', requestId: requestId, action: 'owner.grantSuperAdmin',
      payloadHash: Util.sha256Hex_(Util.canonicalJson_({ email: input.email })), now: now
    });
    if (current === null) {
      tx.exec('create',
        'INSERT INTO accounts (id, email, display_name, role, status, employee_code, is_root, auth_epoch, admin_ws_limit, created_at, updated_at, version) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [id, input.email, Setup.displayName_(input.email), 'SUPER_ADMIN', 'ACTIVE', null, 0, 1, null, now, now, 1],
        { code: 'CONFLICT', message: 'An account with this email was just created; run this again.' });
    } else {
      tx.assert('unchanged', '(SELECT version FROM accounts WHERE id = ?) = ?', [id, current.version], 'CONFLICT',
        'The account changed while this ran; run it again.');
      tx.exec('promote', "UPDATE accounts SET role = 'SUPER_ADMIN', status = 'ACTIVE', updated_at = ?, version = version + 1 WHERE id = ?", [now, id]);
    }
    tx.audit(Audit.row_({ requestId: requestId, now: now }, {
      entityType: 'ACCOUNT', entityId: id, action: 'SUPER_ADMIN_GRANTED',
      before: current === null ? null : { role: current.role, status: current.status },
      after: current === null ? { role: 'SUPER_ADMIN', status: 'ACTIVE', created: true } : { role: 'SUPER_ADMIN', status: 'ACTIVE' },
      reason: 'ownerGrantSuperAdmin'
    }));
    tx.result({ id: id });
    tx.commit();

    Cache.bump_(Cache.GEN_ACCT_);
    Audit.alert_('FLINK Time: Super Admin granted',
      'The script owner granted the Super Admin role to ' + input.email + ' (ownerGrantSuperAdmin). If this was not expected, act now.');
    return { email: input.email, changed: true, created: current === null };
  },

  /** MAINTENANCE = 1 makes the request pipeline answer every request with a retryable "down for maintenance". */
  maintenance_: function (on) {
    Setup.requireOwner_();
    if (typeof on !== 'boolean') throw Validate.fail_('on', 'on must be true or false');
    var properties = PropertiesService.getScriptProperties();
    if (on) {
      properties.setProperty('MAINTENANCE', '1');
    } else {
      properties.deleteProperty('MAINTENANCE');
    }
    console.log('maintenance ' + (on ? 'on' : 'off'));
    return { maintenance: on };
  },

  /**
   * Adds key version n + 1 for the audit chain ('AUDIT') or the TOTP secrets ('TOTP') and makes it current. The old
   * key stays: rows and secrets made with it still need it. The audit row is written first, so a failed record means
   * no rotation. No key material is logged, mailed or audited.
   */
  rotateKey_: function (kind) {
    Setup.requireOwner_();
    var names = kind === 'AUDIT'
      ? { version: 'AUDIT_KEY_VERSION', key: 'AUDIT_HMAC_KEY_v', entity: 'AUDIT_HMAC', action: 'AUDIT_KEY_ROTATED', label: 'audit' }
      : { version: 'TOTP_KEY_VERSION', key: 'TOTP_ENC_KEY_v', entity: 'TOTP_ENC', action: 'TOTP_KEY_ROTATED', label: 'TOTP' };
    var properties = PropertiesService.getScriptProperties();
    var recorded = String(properties.getProperty(names.version));
    if (!/^[1-9][0-9]{0,5}$/.test(recorded)) throw Setup.bug_(names.version + ' is not set to a whole number');
    var current = Number(recorded);
    if (!properties.getProperty(names.key + current)) throw Setup.bug_(names.key + current + ' is not set');
    var next = current + 1;

    var now = Date.now();
    var requestId = 'owner:rotate:' + names.entity + ':' + Util.id_();
    var tx = Db.tx_({
      userId: 'SYSTEM', requestId: requestId, action: 'owner.rotateKey', payloadHash: Util.sha256Hex_(names.entity + ':' + next), now: now
    });
    tx.audit(Audit.row_({ requestId: requestId, now: now }, {
      entityType: 'KEY', entityId: names.entity, action: names.action, before: { version: current }, after: { version: next },
      reason: 'owner function'
    }));
    tx.result({ version: next });
    tx.commit();

    properties.setProperty(names.key + next, Setup.newKey_());
    properties.setProperty(names.version, String(next));
    Audit.alert_('FLINK Time: ' + names.label + ' key rotated', 'The script owner rotated the ' + names.label + ' key to version ' + next + '.');
    return { version: next };
  }
};
