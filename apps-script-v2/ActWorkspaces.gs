/**
 * ActWorkspaces.gs - workspaces.*, members.* (BUILD_SPEC sections 2 and 6.2, decision D6).
 * Top-level code only defines things (BUILD_SPEC section 2.1).
 *
 * Every write here is one Db.tx_ transaction: asserts first (the workspace is ACTIVE, the version matches, the target
 * exists), then the changes, then audit rows. What the pipeline already knows is only a shortcut; the transaction is
 * the authority, so a cache that is up to a minute stale can never make a write succeed that the database forbids.
 *
 * The cached account (acct:{gen}:{email}) holds each member's workspaces and, for a Super Admin, every workspace. So a
 * change to a workspace or to a membership bumps gen:acct as well as gen:ws:{id}.
 */
var ActWorkspaces = {

  /** gen:acct (cached accounts embed workspaces and memberships) and gen:ws:{id} (BUILD_SPEC section 5.4). */
  invalidate_: function (workspaceId) {
    Cache.bump_(Cache.GEN_ACCT_);
    Cache.bump_(Cache.genWs_(workspaceId));
  },

  /** A Super Admin acting as a workspace admin needs a fresh step-up; a workspace admin does not (section 6.2). */
  stepUpForSuperAdmin_: function (ctx) {
    if (ctx.user.role === 'SUPER_ADMIN') Auth.requireStepUp_(ctx);
  },

  notFound_: function (message) {
    return new AppError_('NOT_FOUND', message);
  },

  // ------------------------------------------------------------ workspaces.*

  /**
   * workspaces.list: a user's own active memberships (from the cached account: no database call); a Super Admin sees
   * every workspace, with the code and version they need to manage them.
   */
  workspacesList_: function (ctx) {
    if (ctx.user.role !== 'SUPER_ADMIN') {
      return {
        workspaces: ctx.memberships.map(function (m) {
          return { id: m.workspaceId, name: m.name, status: m.status, timezone: m.timezone, weekStart: m.weekStart, wsRole: m.wsRole };
        })
      };
    }
    var rows = Db.read_([{ sql: 'SELECT id, code, name, status, timezone, week_start, version FROM workspaces ORDER BY created_at, id' }])[0];
    var roles = {};
    ctx.memberships.forEach(function (m) { roles[m.workspaceId] = m.wsRole; });
    return {
      workspaces: rows.map(function (row) {
        return {
          id: row.id, code: row.code, name: row.name, status: row.status, timezone: row.timezone, weekStart: row.week_start,
          version: row.version, wsRole: Object.prototype.hasOwnProperty.call(roles, row.id) ? roles[row.id] : null
        };
      })
    };
  },

  workspacesCreate_: function (ctx) {
    var p = ctx.payload;
    var id = Util.id_();
    var workspace = { id: id, code: p.code, name: p.name, status: 'ACTIVE', timezone: p.timezone, weekStart: p.weekStart, version: 1 };
    var tx = Db.tx_(Auth.dbCtx_(ctx));
    tx.exec('create', 'INSERT INTO workspaces (id, code, name, status, timezone, week_start, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)',
      [id, p.code, p.name, 'ACTIVE', p.timezone, p.weekStart, ctx.now, ctx.now]);
    tx.audit(Audit.row_(ctx, {
      entityType: 'WORKSPACE', entityId: id, action: 'WORKSPACE_CREATED', workspaceId: id,
      after: { code: p.code, name: p.name, status: 'ACTIVE', timezone: p.timezone, weekStart: p.weekStart }
    }));
    var done = Main.commit_(tx, { workspace: workspace });
    if (!done.duplicate) ActWorkspaces.invalidate_(id);
    return done.data;
  },

  /** The workspace row as the database has it now, or null. */
  currentWorkspace_: function (workspaceId) {
    var rows = Db.read_([{
      sql: 'SELECT id, code, name, status, timezone, week_start, version FROM workspaces WHERE id = ?', args: [workspaceId]
    }], { token: 'rw' })[0];
    return rows.length === 0 ? null : rows[0];
  },

  STALE_: 'Someone changed this workspace; reload and try again.',

  workspacesUpdate_: function (ctx) {
    var p = ctx.payload;
    var id = ctx.workspace.id;
    var current = ActWorkspaces.currentWorkspace_(id);
    if (current === null) return Main.refuse_(ctx, 'NOT_FOUND', 'No such workspace.');
    var timezoneChanged = current.timezone !== p.timezone;

    var tx = Db.tx_(Auth.dbCtx_(ctx));
    Auth.assertWorkspaceActive_(tx, id);
    tx.assert('version', '(SELECT version FROM workspaces WHERE id = ?) = ?', [id, p.version], 'CONFLICT', ActWorkspaces.STALE_);
    tx.exec('update', 'UPDATE workspaces SET name = ?, timezone = ?, week_start = ?, updated_at = ?, version = version + 1 WHERE id = ?',
      [p.name, p.timezone, p.weekStart, ctx.now, id]);
    if (timezoneChanged) {
      // The local_date of this workspace's entries and running timers is rewritten by a resumable job (T2.9), which
      // looks for this row. A second change before it ran just updates the target.
      tx.exec('schedule local_date rewrite',
        "INSERT INTO export_state (name, last_seq, last_run_at, status, cursor_json) VALUES (?, 0, 0, 'PENDING', ?) " +
        "ON CONFLICT(name) DO UPDATE SET status = 'PENDING', last_seq = 0, cursor_json = excluded.cursor_json",
        ['tzrewrite:' + id, Util.canonicalJson_({ at: ctx.now, from: current.timezone, to: p.timezone })]);
    }
    tx.audit(Audit.row_(ctx, {
      entityType: 'WORKSPACE', entityId: id, action: 'WORKSPACE_UPDATED', workspaceId: id,
      before: { name: current.name, timezone: current.timezone, weekStart: current.week_start },
      after: { name: p.name, timezone: p.timezone, weekStart: p.weekStart }
    }));
    var workspace = {
      id: id, code: current.code, name: p.name, status: 'ACTIVE', timezone: p.timezone, weekStart: p.weekStart, version: current.version + 1
    };
    var done = Main.commit_(tx, { workspace: workspace, timezoneRewriteScheduled: timezoneChanged });
    if (!done.duplicate) ActWorkspaces.invalidate_(id);
    return done.data;
  },

  /** The running timers of a workspace (and optionally of one user), read from the primary. */
  timersIn_: function (workspaceId, userId) {
    var sql = 'SELECT user_id, timer_id, started_at, project_id FROM active_timers WHERE workspace_id = ?';
    var args = [workspaceId];
    if (userId !== undefined) {
      sql += ' AND user_id = ?';
      args.push(userId);
    }
    return Db.read_([{ sql: sql + ' ORDER BY user_id', args: args }], { token: 'rw' })[0];
  },

  /**
   * Adds the stop of each timer to the transaction, as the SYSTEM would do it (stop_reason USER, section 6.2), and the
   * audit row of each. A timer that is gone or a new one that appeared between the read and the transaction makes the
   * whole thing CONFLICT, to be tried again; nothing is half done.
   */
  addStops_: function (ctx, tx, timers, capMs, race) {
    timers.forEach(function (timer, index) {
      var entryId = Util.id_();
      var endAt = Math.min(Math.max(ctx.now, timer.started_at), timer.started_at + capMs);
      ActTimer.addStop_(tx, {
        label: 'stop ' + index, entryId: entryId, userId: timer.user_id, timerId: timer.timer_id, endAt: ctx.now, capMs: capMs,
        stopReason: 'USER', now: ctx.now, missing: { code: 'CONFLICT', message: race }
      });
      tx.audit(Audit.row_({ requestId: ctx.requestId, now: ctx.now }, {
        entityType: 'TIME_ENTRY', entityId: entryId, action: 'TIMER_STOPPED', workspaceId: ctx.workspace.id,
        after: {
          userId: timer.user_id, projectId: timer.project_id, startAt: timer.started_at, endAt: endAt,
          durationS: Math.floor((endAt - timer.started_at) / 1000), stopReason: 'USER'
        }
      }));
    });
  },

  /** The longest an entry may be: AUTO_STOP_HOURS, at most 24, in ms. */
  capMs_: function (ctx) {
    return Math.min(ctx.setting('AUTO_STOP_HOURS'), 24) * 3600000;
  },

  workspacesArchive_: function (ctx) {
    var p = ctx.payload;
    var id = ctx.workspace.id;
    var current = ActWorkspaces.currentWorkspace_(id);
    if (current === null) return Main.refuse_(ctx, 'NOT_FOUND', 'No such workspace.');
    var timers = ActWorkspaces.timersIn_(id);
    var race = 'A timer changed while the workspace was being archived; try again.';

    var tx = Db.tx_(Auth.dbCtx_(ctx));
    Auth.assertWorkspaceActive_(tx, id);
    tx.assert('version', '(SELECT version FROM workspaces WHERE id = ?) = ?', [id, p.version], 'CONFLICT', ActWorkspaces.STALE_);
    tx.exec('archive', "UPDATE workspaces SET status = 'ARCHIVED', updated_at = ?, version = version + 1 WHERE id = ?", [ctx.now, id]);
    ActWorkspaces.addStops_(ctx, tx, timers, ActWorkspaces.capMs_(ctx), race);
    tx.assert('no timer left', 'NOT EXISTS (SELECT 1 FROM active_timers WHERE workspace_id = ?)', [id], 'CONFLICT', race);
    tx.audit(Audit.row_(ctx, {
      entityType: 'WORKSPACE', entityId: id, action: 'WORKSPACE_ARCHIVED', workspaceId: id,
      before: { status: 'ACTIVE' }, after: { status: 'ARCHIVED', stoppedTimers: timers.length }
    }));
    var done = Main.commit_(tx, { workspace: { id: id, status: 'ARCHIVED', version: current.version + 1 }, stoppedTimers: timers.length });
    if (!done.duplicate) ActWorkspaces.invalidate_(id);
    return done.data;
  },

  // ------------------------------------------------------------ members.*

  /** The caller-visible fields of one membership. */
  memberOut_: function (row) {
    return {
      userId: row.user_id, email: row.email, displayName: row.display_name, accountRole: row.role, accountStatus: row.account_status,
      wsRole: row.ws_role, active: row.active === 1, department: row.department, team: row.team, jobTitle: row.job_title
    };
  },

  membersList_: function (ctx) {
    var rows = Db.read_([{
      sql: 'SELECT m.user_id, a.email, a.display_name, a.role, a.status AS account_status, m.ws_role, m.active, m.department, m.team, m.job_title ' +
        'FROM workspace_members m JOIN accounts a ON a.id = m.user_id WHERE m.workspace_id = ? ORDER BY a.display_name, a.id',
      args: [ctx.workspace.id]
    }])[0];
    return { members: rows.map(ActWorkspaces.memberOut_) };
  },

  /** The target's account and its membership in this workspace as the database has them now. */
  targetMember_: function (workspaceId, userId) {
    var rows = Db.read_([{
      sql: 'SELECT a.role, a.status AS account_status, a.admin_ws_limit, m.active, m.ws_role, m.department, m.team, m.job_title ' +
        'FROM accounts a LEFT JOIN workspace_members m ON m.user_id = a.id AND m.workspace_id = ? WHERE a.id = ?',
      args: [workspaceId, userId]
    }], { token: 'rw' })[0];
    return rows.length === 0 ? null : rows[0];
  },

  membersAdd_: function (ctx) {
    ActWorkspaces.stepUpForSuperAdmin_(ctx);
    var p = ctx.payload;
    var id = ctx.workspace.id;
    var target = ActWorkspaces.targetMember_(id, p.userId);
    if (target === null || target.account_status !== 'ACTIVE') return Main.refuse_(ctx, 'NOT_FOUND', 'No such user.');
    if (target.active === 1) return Main.refuse_(ctx, 'CONFLICT', 'This user is already a member.');
    var fields = {
      department: p.department === undefined ? null : p.department, team: p.team === undefined ? null : p.team,
      jobTitle: p.jobTitle === undefined ? null : p.jobTitle
    };

    var tx = Db.tx_(Auth.dbCtx_(ctx));
    Auth.assertWorkspaceActive_(tx, id);
    tx.assert('user exists', "EXISTS (SELECT 1 FROM accounts WHERE id = ? AND status = 'ACTIVE')", [p.userId], 'NOT_FOUND', 'No such user.');
    tx.assert('not a member', 'NOT EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND active = 1)', [id, p.userId],
      'CONFLICT', 'This user is already a member.');
    // a person who was removed comes back as a plain member: only a Super Admin makes a workspace admin
    tx.exec('add',
      'INSERT INTO workspace_members (workspace_id, user_id, ws_role, active, department, team, job_title, created_at, updated_at, version) ' +
      "VALUES (?, ?, 'MEMBER', 1, ?, ?, ?, ?, ?, 1) " +
      "ON CONFLICT(workspace_id, user_id) DO UPDATE SET ws_role = 'MEMBER', active = 1, department = excluded.department, team = excluded.team, " +
      'job_title = excluded.job_title, updated_at = excluded.updated_at, version = workspace_members.version + 1',
      [id, p.userId, fields.department, fields.team, fields.jobTitle, ctx.now, ctx.now]);
    tx.audit(Audit.row_(ctx, {
      entityType: 'WORKSPACE_MEMBER', entityId: p.userId, action: 'MEMBER_ADDED', workspaceId: id,
      before: target.active === 0 ? { active: false, wsRole: target.ws_role } : null,
      after: { wsRole: 'MEMBER', active: true, department: fields.department, team: fields.team, jobTitle: fields.jobTitle }
    }));
    var member = { userId: p.userId, wsRole: 'MEMBER', active: true, department: fields.department, team: fields.team, jobTitle: fields.jobTitle };
    var done = Main.commit_(tx, { member: member });
    if (!done.duplicate) ActWorkspaces.invalidate_(id);
    return done.data;
  },

  membersUpdate_: function (ctx) {
    ActWorkspaces.stepUpForSuperAdmin_(ctx);
    var p = ctx.payload;
    var id = ctx.workspace.id;
    var columns = { department: 'department', team: 'team', jobTitle: 'job_title' };
    var provided = Object.keys(columns).filter(function (name) { return Object.prototype.hasOwnProperty.call(p, name); });
    if (provided.length === 0) throw Validate.fail_('payload', 'Nothing to change.');
    var target = ActWorkspaces.targetMember_(id, p.userId);
    if (target === null || target.active !== 1) return Main.refuse_(ctx, 'NOT_FOUND', 'No such member.');

    var before = {};
    var after = {};
    var sets = [];
    var args = [];
    provided.forEach(function (name) {
      before[name] = target[columns[name]];
      after[name] = p[name];
      sets.push(columns[name] + ' = ?');
      args.push(p[name]);
    });
    var tx = Db.tx_(Auth.dbCtx_(ctx));
    Auth.assertWorkspaceActive_(tx, id);
    tx.assert('is member', 'EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND active = 1)', [id, p.userId],
      'NOT_FOUND', 'No such member.');
    tx.exec('update', 'UPDATE workspace_members SET ' + sets.join(', ') + ', updated_at = ?, version = version + 1 WHERE workspace_id = ? AND user_id = ?',
      args.concat([ctx.now, id, p.userId]));
    tx.audit(Audit.row_(ctx, {
      entityType: 'WORKSPACE_MEMBER', entityId: p.userId, action: 'MEMBER_UPDATED', workspaceId: id, before: before, after: after
    }));
    var done = Main.commit_(tx, { member: Object.assign({ userId: p.userId }, after) });
    if (!done.duplicate) ActWorkspaces.invalidate_(id);
    return done.data;
  },

  membersRemove_: function (ctx) {
    ActWorkspaces.stepUpForSuperAdmin_(ctx);
    var p = ctx.payload;
    var id = ctx.workspace.id;
    var target = ActWorkspaces.targetMember_(id, p.userId);
    if (target === null || target.active !== 1) return Main.refuse_(ctx, 'NOT_FOUND', 'No such member.');
    var timers = ActWorkspaces.timersIn_(id, p.userId);
    var race = 'A timer changed while the member was being removed; try again.';

    var tx = Db.tx_(Auth.dbCtx_(ctx));
    Auth.assertWorkspaceActive_(tx, id);
    tx.assert('is member', 'EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND active = 1)', [id, p.userId],
      'NOT_FOUND', 'No such member.');
    tx.exec('remove', 'UPDATE workspace_members SET active = 0, updated_at = ?, version = version + 1 WHERE workspace_id = ? AND user_id = ?',
      [ctx.now, id, p.userId]);
    ActWorkspaces.addStops_(ctx, tx, timers, ActWorkspaces.capMs_(ctx), race);
    tx.assert('no timer left', 'NOT EXISTS (SELECT 1 FROM active_timers WHERE workspace_id = ? AND user_id = ?)', [id, p.userId], 'CONFLICT', race);
    tx.audit(Audit.row_(ctx, {
      entityType: 'WORKSPACE_MEMBER', entityId: p.userId, action: 'MEMBER_REMOVED', workspaceId: id,
      before: { active: true, wsRole: target.ws_role }, after: { active: false, stoppedTimers: timers.length }
    }));
    var done = Main.commit_(tx, { removed: true, stoppedTimers: timers.length });
    if (!done.duplicate) ActWorkspaces.invalidate_(id);
    return done.data;
  },

  /**
   * members.setAdmin (Super Admin, step-up): the only way ws_role becomes ADMIN or goes back to MEMBER. The target must
   * be an active member whose account role is ADMIN or SUPER_ADMIN. Granting asserts that the number of ACTIVE
   * workspaces they already administer is below COALESCE(admin_ws_limit, ADMIN_MAX_ACTIVE_WORKSPACES) (D6): POLICY.
   * Asking for what already is the case changes nothing, whatever the limit.
   */
  membersSetAdmin_: function (ctx) {
    var p = ctx.payload;
    var id = ctx.workspace.id;
    var target = ActWorkspaces.targetMember_(id, p.userId);
    if (target === null || target.account_status !== 'ACTIVE' || target.active !== 1) return Main.refuse_(ctx, 'NOT_FOUND', 'No such member.');
    if (p.isAdmin && target.role === 'USER') {
      return Main.refuse_(ctx, 'FORBIDDEN', 'Only an Admin or a Super Admin can be a workspace admin.');
    }
    var wanted = p.isAdmin ? 'ADMIN' : 'MEMBER';
    if (target.ws_role === wanted) return Main.noop_(ctx, { member: { userId: p.userId, wsRole: wanted }, changed: false });

    var tx = Db.tx_(Auth.dbCtx_(ctx));
    Auth.assertWorkspaceActive_(tx, id);
    tx.assert('is member', 'EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND active = 1)', [id, p.userId],
      'NOT_FOUND', 'No such member.');
    if (p.isAdmin) {
      tx.assert('account role', "EXISTS (SELECT 1 FROM accounts WHERE id = ? AND role IN ('ADMIN', 'SUPER_ADMIN'))", [p.userId],
        'FORBIDDEN', 'Only an Admin or a Super Admin can be a workspace admin.');
      tx.assert('admin limit',
        '(SELECT COUNT(*) FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id ' +
        "WHERE m.user_id = ? AND m.active = 1 AND m.ws_role = 'ADMIN' AND w.status = 'ACTIVE') < " +
        'COALESCE((SELECT admin_ws_limit FROM accounts WHERE id = ?), ?)',
        [p.userId, p.userId, ctx.setting('ADMIN_MAX_ACTIVE_WORKSPACES')],
        'POLICY', 'This admin already administers as many active workspaces as they may.', { rule: 'ADMIN_MAX_ACTIVE_WORKSPACES' });
    }
    tx.exec('set role', 'UPDATE workspace_members SET ws_role = ?, updated_at = ?, version = version + 1 WHERE workspace_id = ? AND user_id = ?',
      [wanted, ctx.now, id, p.userId]);
    tx.audit(Audit.row_(ctx, {
      entityType: 'WORKSPACE_MEMBER', entityId: p.userId, action: 'MEMBER_ADMIN_SET', workspaceId: id,
      before: { wsRole: target.ws_role }, after: { wsRole: wanted }
    }));
    var done = Main.commit_(tx, { member: { userId: p.userId, wsRole: wanted }, changed: true });
    if (!done.duplicate) ActWorkspaces.invalidate_(id);
    return done.data;
  }
};
