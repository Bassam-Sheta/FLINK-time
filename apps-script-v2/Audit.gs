/**
 * Audit.gs - audit row builder, sealer, verifier, checkpoint (BUILD_SPEC sections 2 and 5.5).
 * Top-level code only defines things (BUILD_SPEC section 2.1).
 *
 * Every write that matters adds an audit_log row in the same transaction (Audit.row_ + Db.tx_.audit). A row starts
 * unsealed. The sealer, run every minute under the script lock, links unsealed rows into a hash chain:
 *
 *   record_hash = HMAC_SHA256(AUDIT_HMAC_KEY_v{n}, prev_hash + "\n" + canonical row)
 *
 * and moves chain_head forward in the same transaction. The newest sealed seq and hash are also written to the Script
 * Property CHAIN_CHECKPOINT, which lives outside the database: someone who rewrites the database, head included,
 * cannot also rewrite the checkpoint. The verifier recomputes the chain and compares it with both.
 */
var Audit = {

  /** Keys that never reach audit_log, at any depth of before/after (section 5.5). */
  REDACT_KEYS_: ['secret_enc', 'pending_secret_enc', 'backup_hashes_json', 'enroll_code_hash', 'token_hash'],
  /** Rows sealed per run (section 5.5, step 1). */
  SEAL_BATCH_: 200,
  /** Rows the verifier reads per page (section 5.5). */
  VERIFY_PAGE_: 1000,
  /** At most this many problems are listed in a verification result; the security event holds the first few. */
  MAX_PROBLEMS_: 100,
  EVENT_PROBLEMS_: 20,
  /** prev_hash of the first row: the head the migration inserts. */
  GENESIS_: '0000000000000000000000000000000000000000000000000000000000000000',

  bug_: function (detail) {
    return new AppError_('INTERNAL', 'An internal error occurred.', { error: detail });
  },

  // ------------------------------------------------------------ rows

  /**
   * A copy of value without any key in REDACT_KEYS_, at every depth, through arrays too. Anything that is not an
   * object or array is returned as it is (undefined becomes null). The input is never changed.
   */
  redact_: function (value) {
    if (value === undefined) return null;
    if (Array.isArray(value)) return value.map(function (item) { return Audit.redact_(item); });
    if (value === null || typeof value !== 'object') return value;
    var out = {};
    Object.keys(value).forEach(function (key) {
      if (Audit.REDACT_KEYS_.indexOf(key) < 0) out[key] = Audit.redact_(value[key]);
    });
    return out;
  },

  /** before/after as canonical JSON of the redacted value, or null when there is none. */
  json_: function (value) {
    if (value === undefined || value === null) return null;
    return Util.canonicalJson_(Audit.redact_(value));
  },

  nonEmpty_: function (value) {
    return typeof value === 'string' && value !== '';
  },

  /**
   * The row for Db.tx_.audit(row): { ts, actor_user_id, actor_role, workspace_id, entity_type, entity_id, action,
   * before_json, after_json, reason, request_id }. ctx is a handler's ctx ({ user, requestId, now }) or, for a job,
   * { requestId, now }, whose actor is SYSTEM. spec = { entityType, entityId, action, before?, after?, reason?,
   * workspaceId?, requestId? }; requestId overrides ctx.requestId for a read action that writes one row under a derived
   * id (such as 'export:{id}'). A row the table would refuse is an INTERNAL error here, at the line that built it.
   */
  row_: function (ctx, spec) {
    if (ctx === null || typeof ctx !== 'object' || spec === null || typeof spec !== 'object') throw Audit.bug_('Audit.row_ needs a context and a spec');
    if (!Number.isSafeInteger(ctx.now)) throw Audit.bug_('Audit.row_: ctx.now must be an integer number of milliseconds');
    var requestId = spec.requestId !== undefined ? spec.requestId : ctx.requestId;
    if (!Audit.nonEmpty_(requestId)) throw Audit.bug_('Audit.row_ needs a request id');
    ['entityType', 'entityId', 'action'].forEach(function (name) {
      if (!Audit.nonEmpty_(spec[name])) throw Audit.bug_('Audit.row_ needs ' + name + ' as text');
    });
    var workspaceId = spec.workspaceId === undefined || spec.workspaceId === null ? null : spec.workspaceId;
    if (workspaceId !== null && !Audit.nonEmpty_(workspaceId)) throw Audit.bug_('Audit.row_: workspaceId must be text or null');
    var reason = spec.reason === undefined || spec.reason === null ? null : spec.reason;
    if (reason !== null && typeof reason !== 'string') throw Audit.bug_('Audit.row_: reason must be text or null');

    var user = ctx.user;
    var known = user !== null && user !== undefined && typeof user === 'object' && Audit.nonEmpty_(user.id) && Audit.nonEmpty_(user.role);
    return {
      ts: ctx.now,
      actor_user_id: known ? user.id : 'SYSTEM',
      actor_role: known ? user.role : 'SYSTEM',
      workspace_id: workspaceId,
      entity_type: spec.entityType,
      entity_id: spec.entityId,
      action: spec.action,
      before_json: Audit.json_(spec.before),
      after_json: Audit.json_(spec.after),
      reason: reason,
      request_id: requestId
    };
  },

  // ------------------------------------------------------------ keys, hashes, checkpoint

  /** { version, key } for sealing: AUDIT_KEY_VERSION and the matching AUDIT_HMAC_KEY_v{n}. Missing or odd means INTERNAL. */
  sealKey_: function () {
    var properties = PropertiesService.getScriptProperties();
    var version = String(properties.getProperty('AUDIT_KEY_VERSION'));
    if (!/^[1-9][0-9]{0,5}$/.test(version)) throw Audit.bug_('AUDIT_KEY_VERSION is not set to a whole number');
    var key = properties.getProperty('AUDIT_HMAC_KEY_v' + version);
    if (!key) throw Audit.bug_('AUDIT_HMAC_KEY_v' + version + ' is not set');
    return { version: Number(version), key: key };
  },

  /** The stored key for a row's key_version, or null. */
  keyFor_: function (version) {
    if (!Number.isSafeInteger(version) || version < 1) return null;
    var key = PropertiesService.getScriptProperties().getProperty('AUDIT_HMAC_KEY_v' + version);
    return key ? key : null;
  },

  /** The text that is hashed for a row (section 5.5, step 4). Integers are decimal strings, nulls stay null. */
  canonical_: function (row) {
    return Util.canonicalJson_([String(row.seq), String(row.ts), row.actor_user_id, row.actor_role, row.workspace_id,
      row.entity_type, row.entity_id, row.action, row.before_json, row.after_json, row.reason, row.request_id]);
  },

  recordHash_: function (key, prevHash, row) {
    return Util.hmacSha256Hex_(key, prevHash + '\n' + Audit.canonical_(row));
  },

  /** { state: 'missing' } | { state: 'unreadable' } | { state: 'ok', seq, hash, at } from CHAIN_CHECKPOINT. */
  readCheckpoint_: function () {
    var raw = PropertiesService.getScriptProperties().getProperty('CHAIN_CHECKPOINT');
    if (raw === null || raw === undefined) return { state: 'missing' };
    try {
      var parsed = JSON.parse(raw);
      if (parsed !== null && typeof parsed === 'object' && Number.isSafeInteger(parsed.seq) && parsed.seq >= 0 &&
          typeof parsed.hash === 'string' && /^[0-9a-f]{64}$/.test(parsed.hash)) {
        return { state: 'ok', seq: parsed.seq, hash: parsed.hash, at: parsed.at };
      }
    } catch (err) {
      // falls through: unreadable
    }
    return { state: 'unreadable' };
  },

  /** Writes CHAIN_CHECKPOINT = {"seq","hash","at"} only if seq is greater than the stored one (an unreadable one is replaced). */
  writeCheckpoint_: function (seq, hash, at) {
    var current = Audit.readCheckpoint_();
    if (current.state === 'ok' && current.seq >= seq) return false;
    PropertiesService.getScriptProperties().setProperty('CHAIN_CHECKPOINT', JSON.stringify({ seq: seq, hash: hash, at: at }));
    return true;
  },

  // ------------------------------------------------------------ alarms

  /** Records a security event in its own SYSTEM transaction. Returns false when this request id was recorded before. */
  securityEvent_: function (eventType, detail, requestId, now) {
    var json = Util.canonicalJson_(detail);
    var tx = Db.tx_({ userId: 'SYSTEM', requestId: requestId, action: 'security.event', payloadHash: Util.sha256Hex_(json), now: now });
    tx.exec('event', 'INSERT INTO security_events (ts, email, user_id, event_type, success, detail_json) VALUES (?, ?, ?, ?, ?, ?)',
      [now, null, null, eventType, 0, json]);
    tx.result({ recorded: true });
    return tx.commit().duplicate !== true;
  },

  /** Mails ALERT_EMAIL. Never throws: an alert that cannot be sent must not stop the work that found the problem. */
  alert_: function (subject, body) {
    try {
      var to = PropertiesService.getScriptProperties().getProperty('ALERT_EMAIL');
      if (!to) {
        console.warn('ALERT_EMAIL is not set; not sent: ' + subject);
        return false;
      }
      MailApp.sendEmail(to, subject, body);
      return true;
    } catch (err) {
      console.warn('alert mail failed: ' + String(err && err.message).slice(0, 200));
      return false;
    }
  },

  rangeText_: function (range) {
    return range.from === range.to ? String(range.from) : range.from + '-' + range.to;
  },

  /**
   * Seq numbers that are missing (gaps) or that sit below the chain head (below) are a security event and a mail,
   * once: the request id comes from the findings, so a rerun after a failed seal finds the event already recorded.
   */
  reportGap_: function (gaps, below, now) {
    var detail = { gaps: gaps, below: below };
    var requestId = 'sec:gap:' + Util.sha256Hex_(Util.canonicalJson_(detail)).slice(0, 32);
    if (!Audit.securityEvent_('AUDIT_SEQ_GAP', detail, requestId, now)) return;
    var lines = ['The audit log has sequence numbers that should exist and do not, or that are out of order.'];
    if (gaps.length) lines.push('Missing: ' + gaps.map(Audit.rangeText_).join(', '));
    if (below.length) lines.push('Unsealed rows below the chain head: ' + below.join(', '));
    lines.push('The chain links across the gap and sealing carries on. Look at the security events and the audit log.');
    Audit.alert_('FLINK Time: audit log sequence gap', lines.join('\n'));
  },

  // ------------------------------------------------------------ the sealer

  /**
   * One sealing run (section 5.5): under the script lock (a run that cannot take it does nothing), reads the head and up
   * to 200 unsealed rows, builds the chain, and writes the hashes, the new head and nothing else in ONE transaction
   * that asserts the head did not move. Returns { sealed, fromSeq, toSeq, gaps }, or { skipped: true, sealed: 0 }.
   * A crash before the write changes nothing and the next run does the same work again; a write whose answer was lost
   * leaves nothing to do next time.
   */
  seal_: function () {
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(0)) return { skipped: true, sealed: 0 };
    try {
      return Audit.sealLocked_();
    } finally {
      lock.releaseLock();
    }
  },

  sealLocked_: function () {
    var now = Date.now();
    var seal = Audit.sealKey_();
    var read = Db.read_([
      { sql: 'SELECT seq, hash FROM chain_head WHERE id = 1' },
      { sql: 'SELECT * FROM audit_log WHERE sealed_at IS NULL ORDER BY seq LIMIT ' + Audit.SEAL_BATCH_ }
    ]);
    var head = read[0][0];
    if (!head) throw Audit.bug_('chain_head has no row');
    if (read[1].length === 0) return { sealed: 0, gaps: [] };

    var rows = [];
    var below = [];
    var gaps = [];
    var expected = head.seq + 1;
    read[1].forEach(function (row) {
      if (row.seq <= head.seq) {
        below.push(row.seq);
        return;
      }
      if (row.seq > expected) gaps.push({ from: expected, to: row.seq - 1 });
      expected = row.seq + 1;
      rows.push(row);
    });
    if (gaps.length > 0 || below.length > 0) Audit.reportGap_(gaps, below, now);
    if (rows.length === 0) return { sealed: 0, gaps: gaps };

    var previous = head.hash;
    var links = rows.map(function (row) {
      var hash = Audit.recordHash_(seal.key, previous, row);
      var link = { seq: row.seq, prev: previous, hash: hash };
      previous = hash;
      return link;
    });
    var first = links[0].seq;
    var last = links[links.length - 1].seq;

    var tx = Db.tx_({
      userId: 'SYSTEM', requestId: 'seal:' + first + '-' + last, action: 'audit.seal',
      payloadHash: Util.sha256Hex_(first + '-' + last + ':' + previous), now: now
    });
    tx.assert('head unchanged', '(SELECT seq FROM chain_head WHERE id = 1) = ?', [head.seq], 'CONFLICT', 'The audit chain moved while sealing.');
    links.forEach(function (link) {
      tx.exec('seal ' + link.seq, 'UPDATE audit_log SET prev_hash = ?, record_hash = ?, key_version = ?, sealed_at = ? WHERE seq = ? AND sealed_at IS NULL',
        [link.prev, link.hash, seal.version, now, link.seq]);
    });
    tx.exec('head move', 'UPDATE chain_head SET seq = ?, hash = ?, updated_at = ? WHERE id = 1', [last, previous, now]);
    tx.result({ sealed: links.length, fromSeq: first, toSeq: last });
    tx.commit();

    Audit.writeCheckpoint_(last, previous, now);
    return { sealed: links.length, fromSeq: first, toSeq: last, gaps: gaps };
  },

  // ------------------------------------------------------------ the verifier

  /** A whole number of at least 0, or INTERNAL. undefined means 0. */
  fromSeq_: function (value) {
    if (value === undefined) return 0;
    if (!Number.isSafeInteger(value) || value < 0) throw Audit.bug_('verify_ needs a whole number of at least 0');
    return value;
  },

  /**
   * Re-reads sealed rows from fromSeq in pages of 1,000 and recomputes each hash with the key its row names. A row is
   * a problem when its hash does not match its content (RECORD_HASH), its prev_hash is not the stored hash of the
   * sealed row before it (PREV_HASH), or its key is gone (KEY_MISSING). Once it has reached the end it also checks the
   * head against the newest sealed row (HEAD_MISMATCH) and CHAIN_CHECKPOINT against the head and the row at its seq
   * (CHECKPOINT_AHEAD, CHECKPOINT_ROW_MISSING, CHECKPOINT_HASH, CHECKPOINT_UNREADABLE). A gap the sealer already
   * recorded is not a problem: the chain links across it.
   *
   * opts.deadlineMs: stop after the page that crosses this time and say how far it got (complete: false).
   * Returns { verifiedTo, ok, problems: [{ seq, type }], complete }. Any problem is a security event, a mail to
   * ALERT_EMAIL and the Script Property ALARM_AUDIT = 1 (the Super Admin banner). A clean run changes nothing.
   */
  verify_: function (fromSeq, opts) {
    var start = Audit.fromSeq_(fromSeq);
    var deadline = opts && Number.isSafeInteger(opts.deadlineMs) ? opts.deadlineMs : null;
    var problems = [];
    var note = function (seq, type) {
      if (problems.length < Audit.MAX_PROBLEMS_) problems.push({ seq: seq, type: type });
    };

    var previousHash = Audit.GENESIS_;
    if (start > 0) {
      var before = Db.read_([{
        sql: 'SELECT record_hash FROM audit_log WHERE sealed_at IS NOT NULL AND seq < ? ORDER BY seq DESC LIMIT 1', args: [start]
      }])[0];
      if (before.length > 0) previousHash = before[0].record_hash;
    }

    var verifiedTo = 0;
    var next = start;
    var complete = true;
    for (;;) {
      var page = Db.read_([{
        sql: 'SELECT * FROM audit_log WHERE sealed_at IS NOT NULL AND seq >= ? ORDER BY seq LIMIT ' + Audit.VERIFY_PAGE_, args: [next]
      }])[0];
      page.forEach(function (row) {
        var key = Audit.keyFor_(row.key_version);
        if (key === null) {
          note(row.seq, 'KEY_MISSING');
        } else if (Audit.recordHash_(key, String(row.prev_hash), row) !== row.record_hash) {
          note(row.seq, 'RECORD_HASH');
        }
        if (row.prev_hash !== previousHash) note(row.seq, 'PREV_HASH');
        previousHash = row.record_hash;
        verifiedTo = row.seq;
      });
      if (page.length < Audit.VERIFY_PAGE_) break;
      next = page[page.length - 1].seq + 1;
      if (deadline !== null && Date.now() >= deadline) {
        complete = false;
        break;
      }
    }

    if (complete) Audit.checkHeadAndCheckpoint_(note);

    var ok = problems.length === 0;
    if (!ok) Audit.raiseAlarm_(problems);
    return { verifiedTo: verifiedTo, ok: ok, problems: problems, complete: complete };
  },

  /** The checks that need the whole chain: the head, and the checkpoint kept outside the database. */
  checkHeadAndCheckpoint_: function (note) {
    var checkpoint = Audit.readCheckpoint_();
    var statements = [
      { sql: 'SELECT seq, hash FROM chain_head WHERE id = 1' },
      { sql: 'SELECT seq, record_hash FROM audit_log WHERE sealed_at IS NOT NULL ORDER BY seq DESC LIMIT 1' }
    ];
    if (checkpoint.state === 'ok') statements.push({ sql: 'SELECT record_hash FROM audit_log WHERE seq = ?', args: [checkpoint.seq] });
    var read = Db.read_(statements);
    var head = read[0][0];
    var newest = read[1][0];
    if (!head) throw Audit.bug_('chain_head has no row');

    var headMatches = newest === undefined
      ? head.seq === 0 && head.hash === Audit.GENESIS_
      : head.seq === newest.seq && head.hash === newest.record_hash;
    if (!headMatches) note(head.seq, 'HEAD_MISMATCH');

    if (checkpoint.state === 'unreadable') {
      note(null, 'CHECKPOINT_UNREADABLE');
    } else if (checkpoint.state === 'ok') {
      if (checkpoint.seq > head.seq) {
        note(checkpoint.seq, 'CHECKPOINT_AHEAD');
      } else if (read[2].length === 0) {
        note(checkpoint.seq, 'CHECKPOINT_ROW_MISSING');
      } else if (read[2][0].record_hash !== checkpoint.hash) {
        note(checkpoint.seq, 'CHECKPOINT_HASH');
      }
    }
  },

  /** A broken chain: one security event, one mail (types and seq numbers only, never row content), the banner flag. */
  raiseAlarm_: function (problems) {
    var now = Date.now();
    PropertiesService.getScriptProperties().setProperty('ALARM_AUDIT', '1');
    var listed = problems.slice(0, Audit.EVENT_PROBLEMS_);
    try {
      Audit.securityEvent_('AUDIT_CHAIN_BROKEN', { total: problems.length, problems: listed }, 'sec:' + Util.id_(), now);
    } catch (err) {
      console.warn('could not record the AUDIT_CHAIN_BROKEN event: ' + String(err && err.message).slice(0, 200));
    }
    var lines = ['The audit log chain does not verify: ' + problems.length + ' problem(s).'];
    listed.forEach(function (problem) {
      lines.push(problem.type + (problem.seq === null ? '' : ' at seq ' + problem.seq));
    });
    lines.push('Super Admins see a banner. Check the security events and restore from the daily export if rows were changed.');
    Audit.alert_('FLINK Time: audit log verification failed', lines.join('\n'));
  }
};
