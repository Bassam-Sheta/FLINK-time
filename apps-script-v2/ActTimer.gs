/**
 * ActTimer.gs - timer.* (BUILD_SPEC sections 2 and 6.2).
 * Top-level code only defines things (BUILD_SPEC section 2.1).
 */
var ActTimer = {

  STOP_REASONS_: ['USER', 'AUTO_STOP', 'DEACTIVATION'],
  /** time_entries has CHECK (end_at - start_at <= 86400000). */
  MAX_CAP_MS_: 86400000,

  /**
   * Adds to a Db.tx_ transaction the steps that stop ONE running timer into ONE entry: an assert that the timer exists,
   * then the three statements of BUILD_SPEC section 6.4, as written there (the entry with its rate snapshot, the entry's
   * tags, the removal of the timer). Every way of stopping a timer uses this: timer.stop, the auto-stop job, archiving a
   * workspace, removing a member, deactivating a user.
   *
   * spec = { label, entryId, userId, timerId, endAt, capMs, stopReason, now, missing }
   *   label       unique within the transaction; the steps are labelled "{label} exists", "{label} entry", ...
   *   entryId     the new entry's id, made by the caller (the stored result must be known before the call)
   *   endAt       the proposed end in ms; the stored end is MIN(MAX(endAt, started_at), started_at + capMs)
   *   capMs       the longest an entry may be: min(AUTO_STOP_HOURS, 24) hours, in ms, at most 24 hours
   *   stopReason  USER, AUTO_STOP or DEACTIVATION
   *   missing     { code, message, details? } thrown when the user has no timer with this id
   */
  addStop_: function (tx, spec) {
    var bug = function (detail) { return new AppError_('INTERNAL', 'An internal error occurred.', { error: 'ActTimer.addStop_: ' + detail }); };
    var text = function (name) {
      if (typeof spec[name] !== 'string' || spec[name] === '') throw bug(name + ' must be non-empty text');
    };
    if (spec === null || typeof spec !== 'object') throw bug('needs a spec');
    ['label', 'entryId', 'userId', 'timerId'].forEach(text);
    ['endAt', 'now'].forEach(function (name) {
      if (!Number.isSafeInteger(spec[name])) throw bug(name + ' must be a whole number of milliseconds');
    });
    if (!Number.isSafeInteger(spec.capMs) || spec.capMs < 1 || spec.capMs > ActTimer.MAX_CAP_MS_) throw bug('capMs must be 1 ms to 24 hours');
    if (ActTimer.STOP_REASONS_.indexOf(spec.stopReason) < 0) throw bug('unknown stopReason');
    if (spec.missing === null || typeof spec.missing !== 'object') throw bug('missing must say what to throw when there is no such timer');

    tx.assert(spec.label + ' exists', 'EXISTS (SELECT 1 FROM active_timers WHERE user_id = ? AND timer_id = ?)',
      [spec.userId, spec.timerId], spec.missing.code, spec.missing.message, spec.missing.details);
    tx.exec(spec.label + ' entry',
      'INSERT INTO time_entries (id, workspace_id, user_id, project_id, task_id, description, start_at, end_at, ' +
      'duration_s, local_date, billable, hourly_rate_minor, cost_rate_minor, source, stop_reason, timer_id, created_at, updated_at) ' +
      'SELECT ?, t.workspace_id, t.user_id, t.project_id, t.task_id, t.description, t.started_at, ' +
      'MIN(MAX(?, t.started_at), t.started_at + ?), ' +
      '(MIN(MAX(?, t.started_at), t.started_at + ?) - t.started_at) / 1000, ' +
      't.local_date, t.billable, ' +
      '(SELECT hourly_rate_minor FROM projects WHERE id = t.project_id), ' +
      '(SELECT cost_rate_minor FROM projects WHERE id = t.project_id), ' +
      "'TIMER', ?, t.timer_id, ?, ? " +
      'FROM active_timers t WHERE t.user_id = ? AND t.timer_id = ?',
      [spec.entryId, spec.endAt, spec.capMs, spec.endAt, spec.capMs, spec.stopReason, spec.now, spec.now, spec.userId, spec.timerId]);
    tx.exec(spec.label + ' tags',
      'INSERT INTO entry_tags (entry_id, tag_id, workspace_id) ' +
      'SELECT ?, j.value, t.workspace_id FROM active_timers t, json_each(t.tag_ids_json) j WHERE t.user_id = ?',
      [spec.entryId, spec.userId]);
    tx.exec(spec.label + ' delete', 'DELETE FROM active_timers WHERE user_id = ? AND timer_id = ?', [spec.userId, spec.timerId]);
    return tx;
  },

  // ------------------------------------------------------------ the timer as the page sees it

  TIMER_COLUMNS_: 'user_id, timer_id, workspace_id, project_id, task_id, description, billable, tag_ids_json, started_at, local_date, version',

  /** The longest an entry may be: AUTO_STOP_HOURS, at most 24, in ms. */
  capMs_: function (ctx) {
    return Math.min(ctx.setting('AUTO_STOP_HOURS'), 24) * 3600000;
  },

  timerOut_: function (row) {
    return {
      timerId: row.timer_id, workspaceId: row.workspace_id, projectId: row.project_id, taskId: row.task_id, description: row.description,
      billable: row.billable === 1, tagIds: JSON.parse(row.tag_ids_json), startedAt: row.started_at, localDate: row.local_date, version: row.version
    };
  },

  /** The caller's timer with this id as the database has it now, or null. */
  readTimer_: function (userId, timerId) {
    var rows = Db.read_([{
      sql: 'SELECT ' + ActTimer.TIMER_COLUMNS_ + ' FROM active_timers WHERE user_id = ? AND timer_id = ?', args: [userId, timerId]
    }], { token: 'rw' })[0];
    return rows.length === 0 ? null : rows[0];
  },

  /** { timer } for a timer id (the answer to a retry: the timer as it is now, or null if it is gone). */
  timerAnswer_: function (userId, timerId) {
    var row = ActTimer.readTimer_(userId, timerId);
    return { timer: row === null ? null : ActTimer.timerOut_(row) };
  },

  ENTRY_COLUMNS_: 'id, project_id, task_id, description, start_at, end_at, duration_s, local_date, billable',

  /** An entry for its owner: no rate, cost or money field of any kind. */
  entryOut_: function (row, tagIds) {
    return {
      id: row.id, projectId: row.project_id, taskId: row.task_id, description: row.description, startAt: row.start_at, endAt: row.end_at,
      durationS: row.duration_s, localDate: row.local_date, billable: row.billable === 1, tagIds: tagIds
    };
  },

  /** { entry } for an entry id of this user, read now (the answer to a retry of a stop), or { entry: null }. */
  entryAnswer_: function (userId, entryId) {
    var read = Db.read_([
      { sql: 'SELECT ' + ActTimer.ENTRY_COLUMNS_ + ' FROM time_entries WHERE id = ? AND user_id = ?', args: [entryId, userId] },
      { sql: 'SELECT tag_id FROM entry_tags WHERE entry_id = ? ORDER BY tag_id', args: [entryId] }
    ], { token: 'rw' });
    if (read[0].length === 0) return { entry: null };
    return { entry: ActTimer.entryOut_(read[0][0], read[1].map(function (r) { return r.tag_id; })) };
  },

  // ------------------------------------------------------------ the rules

  RULE_MESSAGES_: {
    RULE_PROJECT_REQUIRED: 'This workspace requires a project.',
    RULE_TASK_REQUIRED: 'This workspace requires a task.',
    REQUIRE_DESCRIPTION: 'This workspace requires a description.',
    ALLOW_USER_PROJECT_SWITCH: 'Changing the project of a running timer is switched off in this workspace.'
  },

  /** The first of the three entry rules that the timer as it will be breaks (section 6.2), or null. */
  ruleBroken_: function (ctx, state) {
    if (ctx.setting('RULE_PROJECT_REQUIRED') && !state.projectId) return 'RULE_PROJECT_REQUIRED';
    if (ctx.setting('RULE_TASK_REQUIRED') && !state.taskId) return 'RULE_TASK_REQUIRED';
    if (ctx.setting('REQUIRE_DESCRIPTION') && String(state.description === undefined || state.description === null ? '' : state.description).trim() === '') {
      return 'REQUIRE_DESCRIPTION';
    }
    return null;
  },

  /** { code, message, details } for a POLICY refusal of a rule, for Main.refuse_. */
  policy_: function (rule) {
    return { code: 'POLICY', message: ActTimer.RULE_MESSAGES_[rule], details: { rule: rule } };
  },

  /** The refusal (or null) for a timer that will have this project, task, description and tags. */
  refusal_: function (ctx, state, tagIds) {
    var rule = ActTimer.ruleBroken_(ctx, state);
    if (rule !== null) return ActTimer.policy_(rule);
    return ActCatalog.tagsRefusal_(ctx, tagIds);
  },

  // ------------------------------------------------------------ the asserts timer.start and timer.switch share

  /** Section 6.3 for the caller, as an assert; the role is read in the transaction, not taken from the cache. */
  assertProject_: function (tx, workspaceId, userId, projectId) {
    tx.assert('project',
      "EXISTS (SELECT 1 FROM projects p WHERE p.id = ? AND p.workspace_id = ? AND p.status = 'ACTIVE' AND (p.restricted = 0 OR " +
      "(SELECT role FROM accounts WHERE id = ?) IN ('ADMIN', 'SUPER_ADMIN') OR " +
      'EXISTS (SELECT 1 FROM project_access a WHERE a.project_id = p.id AND a.user_id = ? AND a.can_track = 1)))',
      [projectId, workspaceId, userId, userId], 'NOT_FOUND', 'No such project.');
  },

  assertTask_: function (tx, workspaceId, projectId, taskId) {
    tx.assert('task', "EXISTS (SELECT 1 FROM tasks WHERE id = ? AND project_id = ? AND workspace_id = ? AND status = 'ACTIVE')",
      [taskId, projectId, workspaceId], 'NOT_FOUND', 'No such task.');
  },

  // ------------------------------------------------------------ timer.start

  /** A new timer's billable when the caller did not say: the task's default, else the project's, else true. */
  defaultBillable_: function (projectId, taskId) {
    if (!projectId) return true;
    var row = Db.read_([{
      sql: 'SELECT (SELECT billable_default FROM tasks WHERE id = ?) AS task_default, (SELECT billable_default FROM projects WHERE id = ?) AS project_default',
      args: [taskId === undefined ? null : taskId, projectId]
    }], { token: 'rw' })[0][0];
    if (row.task_default !== null) return row.task_default === 1;
    return row.project_default === null ? true : row.project_default === 1;
  },

  /**
   * timer.start. Rules first, in Apps Script (POLICY); then the asserts of section 6.2 in the transaction: the caller is
   * an active member of an ACTIVE workspace, has no timer, may track the project, the task is an active task of it, the
   * tags are active tags of the workspace. The database's primary key on active_timers.user_id is the final word on
   * "one timer": the handler's own assert only gives a clear message.
   */
  start_: function (ctx) {
    var p = ctx.payload;
    var ws = ctx.workspace.id;
    var userId = ctx.user.id;
    var projectId = p.projectId === undefined ? null : p.projectId;
    var taskId = p.taskId === undefined ? null : p.taskId;
    var tagIds = p.tagIds === undefined || p.tagIds === null ? [] : p.tagIds;
    var description = p.description === undefined || p.description === null ? '' : p.description;
    if (taskId !== null && projectId === null) throw Validate.fail_('taskId', 'taskId needs a projectId');

    var refusal = ActTimer.refusal_(ctx, { projectId: projectId, taskId: taskId, description: description }, tagIds);
    if (refusal !== null) {
      return ActTimer.timerAnswer_(userId, Main.refuse_(ctx, refusal.code, refusal.message, refusal.details).timerId);
    }

    var billable = p.billable === undefined || p.billable === null ? ActTimer.defaultBillable_(projectId, taskId) : p.billable;
    var timerId = Util.id_();
    var startedAt = Util.clampClientTime_(p.clientAt, ctx.now, ctx.setting('TIMER_CLIENT_SKEW_SECONDS'));
    var localDate = Util.localDate_(startedAt, ctx.workspace.timezone);

    var tx = Db.tx_(Auth.dbCtx_(ctx));
    Auth.assertWorkspaceActive_(tx, ws);
    tx.assert('member', 'EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND active = 1)', [ws, userId],
      'FORBIDDEN', 'You are not a member of this workspace.');
    tx.assert('no timer', 'NOT EXISTS (SELECT 1 FROM active_timers WHERE user_id = ?)', [userId], 'CONFLICT', 'A timer is already running.');
    if (projectId !== null) ActTimer.assertProject_(tx, ws, userId, projectId);
    if (taskId !== null) ActTimer.assertTask_(tx, ws, projectId, taskId);
    ActCatalog.tagAssert_(tx, ws, tagIds, 'tags');
    tx.exec('start',
      'INSERT INTO active_timers (user_id, timer_id, workspace_id, project_id, task_id, description, billable, tag_ids_json, started_at, local_date, version) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)',
      [userId, timerId, ws, projectId, taskId, description, billable, Util.canonicalJson_(tagIds), startedAt, localDate]);
    tx.select('timer', 'SELECT ' + ActTimer.TIMER_COLUMNS_ + ' FROM active_timers WHERE user_id = ?', [userId]);
    tx.audit(Audit.row_(ctx, {
      entityType: 'TIMER', entityId: timerId, action: 'TIMER_STARTED', workspaceId: ws,
      after: { projectId: projectId, taskId: taskId, description: description, billable: billable, tagIds: tagIds, startedAt: startedAt }
    }));
    var done = Main.commit_(tx, { timerId: timerId });
    return done.duplicate ? ActTimer.timerAnswer_(userId, done.data.timerId) : { timer: ActTimer.timerOut_(done.selects.timer[0]) };
  },

  // ------------------------------------------------------------ timer.stop

  /**
   * timer.stop: the caller's own timer, in this workspace, becomes one entry, in one transaction (ActTimer.addStop_).
   * The end is the client's time when it is close to the server's (never before the start), capped at AUTO_STOP_HOURS
   * after the start. The stored result is the entry's id; the entry is read back inside the transaction.
   */
  stop_: function (ctx) {
    var p = ctx.payload;
    var ws = ctx.workspace.id;
    var userId = ctx.user.id;
    var missing = { code: 'NOT_FOUND', message: 'No such timer.' };
    var timer = ActTimer.readTimer_(userId, p.timerId);
    if (timer === null || timer.workspace_id !== ws) {
      return ActTimer.entryAnswer_(userId, Main.refuse_(ctx, missing.code, missing.message).entryId);
    }
    var entryId = Util.id_();
    var endAt = Util.clampClientTime_(p.clientAt, ctx.now, ctx.setting('TIMER_CLIENT_SKEW_SECONDS'));
    var capMs = ActTimer.capMs_(ctx);
    var storedEnd = Math.min(Math.max(endAt, timer.started_at), timer.started_at + capMs);

    var tx = Db.tx_(Auth.dbCtx_(ctx));
    Auth.assertWorkspaceActive_(tx, ws);
    tx.assert('own timer', 'EXISTS (SELECT 1 FROM active_timers WHERE user_id = ? AND timer_id = ? AND workspace_id = ?)', [userId, p.timerId, ws],
      missing.code, missing.message);
    ActTimer.addStop_(tx, {
      label: 'stop', entryId: entryId, userId: userId, timerId: p.timerId, endAt: endAt, capMs: capMs, stopReason: 'USER', now: ctx.now, missing: missing
    });
    tx.select('entry', 'SELECT ' + ActTimer.ENTRY_COLUMNS_ + ' FROM time_entries WHERE id = ?', [entryId]);
    tx.select('tags', 'SELECT tag_id FROM entry_tags WHERE entry_id = ? ORDER BY tag_id', [entryId]);
    tx.audit(Audit.row_(ctx, {
      entityType: 'TIME_ENTRY', entityId: entryId, action: 'TIMER_STOPPED', workspaceId: ws,
      after: {
        timerId: p.timerId, projectId: timer.project_id, taskId: timer.task_id, startAt: timer.started_at, endAt: storedEnd,
        durationS: Math.floor((storedEnd - timer.started_at) / 1000), stopReason: 'USER'
      }
    }));
    var done = Main.commit_(tx, { entryId: entryId });
    if (done.duplicate) return ActTimer.entryAnswer_(userId, done.data.entryId);
    return { entry: ActTimer.entryOut_(done.selects.entry[0], done.selects.tags.map(function (r) { return r.tag_id; })) };
  },

  // ------------------------------------------------------------ timer.switch

  has_: function (payload, key) {
    return Object.prototype.hasOwnProperty.call(payload, key);
  },

  /**
   * timer.switch: changes the project, task, description, billable flag or tags of the caller's running timer; the
   * start time stays. Absent = unchanged, null clears (a new project drops the old task unless a task is sent).
   * ALLOW_USER_PROJECT_SWITCH must be on if the project changes; the entry rules apply to the timer as it will be; the
   * project, task and tag asserts are those of timer.start, for what changes; the version must be the one the page saw.
   */
  switch_: function (ctx) {
    var p = ctx.payload;
    var ws = ctx.workspace.id;
    var userId = ctx.user.id;
    var has = function (key) { return ActTimer.has_(p, key); };
    if (has('billable') && p.billable === null) throw Validate.fail_('billable', 'billable cannot be cleared');
    var cur = ActTimer.readTimer_(userId, p.timerId);
    if (cur === null || cur.workspace_id !== ws) {
      return ActTimer.timerAnswer_(userId, Main.refuse_(ctx, 'NOT_FOUND', 'No such timer.').timerId);
    }

    var projectChanged = has('projectId') && p.projectId !== cur.project_id;
    var next = {
      projectId: has('projectId') ? p.projectId : cur.project_id,
      taskId: has('taskId') ? p.taskId : (projectChanged ? null : cur.task_id),
      description: has('description') ? (p.description === null ? '' : p.description) : cur.description,
      billable: has('billable') ? p.billable : cur.billable === 1,
      tagIds: has('tagIds') ? (p.tagIds === null ? [] : p.tagIds) : JSON.parse(cur.tag_ids_json)
    };
    if (next.taskId !== null && next.projectId === null) throw Validate.fail_('taskId', 'taskId needs a projectId');
    var taskChanged = next.taskId !== cur.task_id;

    var refusal = null;
    if (projectChanged && !ctx.setting('ALLOW_USER_PROJECT_SWITCH')) refusal = ActTimer.policy_('ALLOW_USER_PROJECT_SWITCH');
    if (refusal === null) refusal = ActTimer.refusal_(ctx, next, has('tagIds') ? next.tagIds : []);
    if (refusal !== null) {
      return ActTimer.timerAnswer_(userId, Main.refuse_(ctx, refusal.code, refusal.message, refusal.details).timerId);
    }

    var before = {};
    var after = {};
    var note = function (key, was, now) {
      if (JSON.stringify(was) !== JSON.stringify(now)) {
        before[key] = was;
        after[key] = now;
      }
    };
    note('projectId', cur.project_id, next.projectId);
    note('taskId', cur.task_id, next.taskId);
    note('description', cur.description, next.description);
    note('billable', cur.billable === 1, next.billable);
    note('tagIds', JSON.parse(cur.tag_ids_json), next.tagIds);

    var tx = Db.tx_(Auth.dbCtx_(ctx));
    Auth.assertWorkspaceActive_(tx, ws);
    tx.assert('own timer', 'EXISTS (SELECT 1 FROM active_timers WHERE user_id = ? AND timer_id = ? AND workspace_id = ?)', [userId, p.timerId, ws],
      'NOT_FOUND', 'No such timer.');
    tx.assert('version', '(SELECT version FROM active_timers WHERE user_id = ? AND timer_id = ?) = ?', [userId, p.timerId, p.version],
      'CONFLICT', 'Someone changed this; reload and try again.');
    if (projectChanged && next.projectId !== null) ActTimer.assertProject_(tx, ws, userId, next.projectId);
    if ((taskChanged || projectChanged) && next.taskId !== null) ActTimer.assertTask_(tx, ws, next.projectId, next.taskId);
    if (has('tagIds')) ActCatalog.tagAssert_(tx, ws, next.tagIds, 'tags');
    tx.exec('switch',
      'UPDATE active_timers SET project_id = ?, task_id = ?, description = ?, billable = ?, tag_ids_json = ?, version = version + 1 WHERE user_id = ? AND timer_id = ?',
      [next.projectId, next.taskId, next.description, next.billable, Util.canonicalJson_(next.tagIds), userId, p.timerId]);
    tx.select('timer', 'SELECT ' + ActTimer.TIMER_COLUMNS_ + ' FROM active_timers WHERE user_id = ? AND timer_id = ?', [userId, p.timerId]);
    tx.audit(Audit.row_(ctx, {
      entityType: 'TIMER', entityId: p.timerId, action: 'TIMER_UPDATED', workspaceId: ws, before: before, after: after
    }));
    var done = Main.commit_(tx, { timerId: p.timerId, version: p.version + 1 });
    return done.duplicate ? ActTimer.timerAnswer_(userId, done.data.timerId) : { timer: ActTimer.timerOut_(done.selects.timer[0]) };
  }
};
