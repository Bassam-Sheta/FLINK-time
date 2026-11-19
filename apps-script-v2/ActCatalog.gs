/**
 * ActCatalog.gs - clients.*, projects.*, tasks.*, projectAccess.*, tags.* (BUILD_SPEC sections 2, 6.2 and 6.3).
 * Top-level code only defines things (BUILD_SPEC section 2.1).
 *
 * Every member may list; workspace admins write. A write is one Db.tx_ transaction (the workspace is ACTIVE, the row is
 * in this workspace, the version matches, then the change and its audit row) and bumps gen:ws:{id}. The shared
 * create_, update_ and archive_ below do that for clients, projects, tasks and tags; each action only says which columns
 * it touches. What a list returns is built from field allowlists: a caller who is not a workspace admin never gets a
 * rate, a cost, a budget or an estimate (section 7.1, rule 6).
 */
var ActCatalog = {

  STALE_: 'Someone changed this; reload and try again.',

  /** Cached catalogs (cat:{wsId}:{gen}) are dropped by the next read after this. */
  invalidate_: function (workspaceId) {
    Cache.bump_(Cache.genWs_(workspaceId));
  },

  /** 1 and 0 from the database as true and false for the page; anything else (null) stays as it is. */
  bool_: function (value) {
    return value === null || value === undefined ? null : value === 1;
  },

  // ------------------------------------------------------------ generic writes

  /**
   * Inserts one row into table (clients, projects, tasks, tags): id, workspace_id, spec.columns, status ACTIVE, the
   * times and version 1. spec = { table, entity, action, columns: { column: value }, asserts(tx)?, out(row) }. A
   * duplicate name is the table's UNIQUE: CONFLICT. Returns { <spec.entity lower-case>: out(row) }.
   */
  create_: function (ctx, spec) {
    var id = Util.id_();
    var row = { id: id, workspace_id: ctx.workspace.id };
    Object.keys(spec.columns).forEach(function (column) { row[column] = spec.columns[column]; });
    row.status = 'ACTIVE';
    row.created_at = ctx.now;
    row.updated_at = ctx.now;
    row.version = 1;
    var names = Object.keys(row);

    var tx = Db.tx_(Auth.dbCtx_(ctx));
    Auth.assertWorkspaceActive_(tx, ctx.workspace.id);
    if (spec.asserts) spec.asserts(tx);
    tx.exec('create', 'INSERT INTO ' + spec.table + ' (' + names.join(', ') + ') VALUES (' + names.map(function () { return '?'; }).join(', ') + ')',
      names.map(function (name) { return row[name]; }));
    tx.audit(Audit.row_(ctx, {
      entityType: spec.entity, entityId: id, action: spec.entity + '_CREATED', workspaceId: ctx.workspace.id, after: spec.audit(row)
    }));
    var data = {};
    data[spec.entity.toLowerCase()] = spec.out(row);
    var done = Main.commit_(tx, data);
    if (!done.duplicate) ActCatalog.invalidate_(ctx.workspace.id);
    return done.data;
  },

  /** The row of table as the database has it now, in this workspace, or null. */
  current_: function (table, workspaceId, id, columns) {
    var rows = Db.read_([{
      sql: 'SELECT ' + columns.join(', ') + ' FROM ' + table + ' WHERE id = ? AND workspace_id = ?', args: [id, workspaceId]
    }], { token: 'rw' })[0];
    return rows.length === 0 ? null : rows[0];
  },

  /**
   * Changes some columns of one row. spec = { table, entity, columns (all it may read), changes: { column: value },
   * asserts(tx, before)?, out(row), audit(row), missing }. Absent fields were left out of `changes` by the caller
   * ("unchanged"); null clears. The asserts in the transaction decide: the row is in this workspace (NOT_FOUND), the
   * version is the one the caller saw (CONFLICT), then the update. Returns { <entity>: out(row) } with the new version.
   */
  update_: function (ctx, spec) {
    var p = ctx.payload;
    var before = ActCatalog.current_(spec.table, ctx.workspace.id, p.id, spec.columns);
    if (before === null) return Main.refuse_(ctx, 'NOT_FOUND', spec.missing);
    var after = Object.assign({}, before, spec.changes, { version: p.version + 1 });
    var names = Object.keys(spec.changes);

    var tx = Db.tx_(Auth.dbCtx_(ctx));
    Auth.assertWorkspaceActive_(tx, ctx.workspace.id);
    tx.assert('in workspace', 'EXISTS (SELECT 1 FROM ' + spec.table + ' WHERE id = ? AND workspace_id = ?)', [p.id, ctx.workspace.id], 'NOT_FOUND', spec.missing);
    tx.assert('version', '(SELECT version FROM ' + spec.table + ' WHERE id = ?) = ?', [p.id, p.version], 'CONFLICT', ActCatalog.STALE_);
    if (spec.asserts) spec.asserts(tx, before);
    tx.exec('update', 'UPDATE ' + spec.table + ' SET ' + names.map(function (n) { return n + ' = ?'; }).concat(['updated_at = ?', 'version = version + 1']).join(', ') +
      ' WHERE id = ? AND workspace_id = ?', names.map(function (n) { return spec.changes[n]; }).concat([ctx.now, p.id, ctx.workspace.id]));
    var was = {};
    var now = {};
    names.forEach(function (n) { was[n] = before[n]; now[n] = spec.changes[n]; });
    tx.audit(Audit.row_(ctx, {
      entityType: spec.entity, entityId: p.id, action: spec.entity + '_UPDATED', workspaceId: ctx.workspace.id, before: was, after: now
    }));
    var data = {};
    data[spec.entity.toLowerCase()] = spec.out(after);
    var done = Main.commit_(tx, data);
    if (!done.duplicate) ActCatalog.invalidate_(ctx.workspace.id);
    return done.data;
  },

  /** Archives one row (status ARCHIVED). Archiving what is archived already is CONFLICT. */
  archive_: function (ctx, spec) {
    var p = ctx.payload;
    var before = ActCatalog.current_(spec.table, ctx.workspace.id, p.id, ['id', 'status', 'version']);
    if (before === null) return Main.refuse_(ctx, 'NOT_FOUND', spec.missing);

    var tx = Db.tx_(Auth.dbCtx_(ctx));
    Auth.assertWorkspaceActive_(tx, ctx.workspace.id);
    tx.assert('in workspace', 'EXISTS (SELECT 1 FROM ' + spec.table + ' WHERE id = ? AND workspace_id = ?)', [p.id, ctx.workspace.id], 'NOT_FOUND', spec.missing);
    tx.assert('version', '(SELECT version FROM ' + spec.table + ' WHERE id = ?) = ?', [p.id, p.version], 'CONFLICT', ActCatalog.STALE_);
    tx.assert('not archived', "(SELECT status FROM " + spec.table + " WHERE id = ?) = 'ACTIVE'", [p.id], 'CONFLICT', 'This is archived already.');
    tx.exec('archive', "UPDATE " + spec.table + " SET status = 'ARCHIVED', updated_at = ?, version = version + 1 WHERE id = ? AND workspace_id = ?", [ctx.now, p.id, ctx.workspace.id]);
    tx.audit(Audit.row_(ctx, {
      entityType: spec.entity, entityId: p.id, action: spec.entity + '_ARCHIVED', workspaceId: ctx.workspace.id,
      before: { status: 'ACTIVE' }, after: { status: 'ARCHIVED' }
    }));
    var done = Main.commit_(tx, { id: p.id, status: 'ARCHIVED', version: p.version + 1 });
    if (!done.duplicate) ActCatalog.invalidate_(ctx.workspace.id);
    return done.data;
  },

  /** The columns of `changes` for the fields the payload has (absent ones are unchanged), via a key-to-column map. */
  changesFrom_: function (payload, map) {
    var changes = {};
    Object.keys(map).forEach(function (key) {
      if (Object.prototype.hasOwnProperty.call(payload, key)) changes[map[key]] = payload[key];
    });
    return changes;
  },

  // ------------------------------------------------------------ clients

  CLIENT_COLUMNS_: ['id', 'name', 'status', 'notes', 'version'],

  /** Everyone sees id, name and status; notes and version are for workspace admins. */
  clientOut_: function (row, admin) {
    var out = { id: row.id, name: row.name, status: row.status };
    if (admin) {
      out.notes = row.notes;
      out.version = row.version;
    }
    return out;
  },

  clientsList_: function (ctx) {
    var admin = ctx.workspace.isWsAdmin;
    var rows = Db.read_([{
      sql: 'SELECT ' + ActCatalog.CLIENT_COLUMNS_.join(', ') + ' FROM clients WHERE workspace_id = ?' + (admin ? '' : " AND status = 'ACTIVE'") + ' ORDER BY name, id',
      args: [ctx.workspace.id]
    }])[0];
    return { clients: rows.map(function (row) { return ActCatalog.clientOut_(row, admin); }) };
  },

  clientsCreate_: function (ctx) {
    var p = ctx.payload;
    return ActCatalog.create_(ctx, {
      table: 'clients', entity: 'CLIENT', columns: { name: p.name, notes: p.notes === undefined ? null : p.notes },
      out: function (row) { return ActCatalog.clientOut_(row, true); },
      audit: function (row) { return { name: row.name, notes: row.notes }; }
    });
  },

  clientsUpdate_: function (ctx) {
    return ActCatalog.update_(ctx, {
      table: 'clients', entity: 'CLIENT', columns: ActCatalog.CLIENT_COLUMNS_, missing: 'No such client.',
      changes: ActCatalog.changesFrom_(ctx.payload, { name: 'name', notes: 'notes' }),
      out: function (row) { return ActCatalog.clientOut_(row, true); }
    });
  },

  clientsArchive_: function (ctx) {
    return ActCatalog.archive_(ctx, { table: 'clients', entity: 'CLIENT', missing: 'No such client.' });
  },

  // ------------------------------------------------------------ projects

  PROJECT_COLUMNS_: ['id', 'client_id', 'name', 'code', 'status', 'restricted', 'billable_default', 'hourly_rate_minor', 'cost_rate_minor',
    'estimate_minutes', 'budget_minor', 'start_date', 'end_date', 'color', 'version'],
  /** payload key to column, for projects.create and projects.update */
  PROJECT_KEYS_: {
    name: 'name', code: 'code', clientId: 'client_id', restricted: 'restricted', billableDefault: 'billable_default',
    hourlyRateMinor: 'hourly_rate_minor', costRateMinor: 'cost_rate_minor', estimateMinutes: 'estimate_minutes',
    budgetMinor: 'budget_minor', startDate: 'start_date', endDate: 'end_date', color: 'color'
  },

  /**
   * A project for the page. The allowlist for everyone who is not a workspace admin has no rate, cost, budget or
   * estimate and does not say whether the project is restricted; a workspace admin gets everything.
   */
  projectOut_: function (row, admin) {
    var out = {
      id: row.id, clientId: row.client_id, name: row.name, code: row.code, billableDefault: ActCatalog.bool_(row.billable_default), color: row.color
    };
    if (admin) {
      out.status = row.status;
      out.restricted = ActCatalog.bool_(row.restricted);
      out.hourlyRateMinor = row.hourly_rate_minor;
      out.costRateMinor = row.cost_rate_minor;
      out.estimateMinutes = row.estimate_minutes;
      out.budgetMinor = row.budget_minor;
      out.startDate = row.start_date;
      out.endDate = row.end_date;
      out.version = row.version;
    }
    return out;
  },

  /** Section 6.3 as SQL for the caller's own row: unrestricted, or an Admin/Super Admin, or an access row with can_track. */
  TRACKABLE_: "p.status = 'ACTIVE' AND (p.restricted = 0 OR ? IN ('ADMIN', 'SUPER_ADMIN') OR " +
    'EXISTS (SELECT 1 FROM project_access a WHERE a.project_id = p.id AND a.user_id = ? AND a.can_track = 1))',

  /**
   * projects.list: a workspace admin gets every project with everything and who may track the restricted ones; anyone
   * else gets only the active projects they may track (section 6.3), without money.
   */
  projectsList_: function (ctx) {
    var ws = ctx.workspace.id;
    var columns = ActCatalog.PROJECT_COLUMNS_.map(function (c) { return 'p.' + c; }).join(', ');
    if (!ctx.workspace.isWsAdmin) {
      var mine = Db.read_([{
        sql: 'SELECT ' + columns + ' FROM projects p WHERE p.workspace_id = ? AND ' + ActCatalog.TRACKABLE_ + ' ORDER BY p.name, p.id',
        args: [ws, ctx.user.role, ctx.user.id]
      }])[0];
      return { projects: mine.map(function (row) { return ActCatalog.projectOut_(row, false); }) };
    }
    var read = Db.read_([
      { sql: 'SELECT ' + columns + ' FROM projects p WHERE p.workspace_id = ? ORDER BY p.name, p.id', args: [ws] },
      { sql: 'SELECT project_id, user_id, can_track FROM project_access WHERE workspace_id = ? ORDER BY project_id, user_id', args: [ws] }
    ]);
    var access = {};
    read[1].forEach(function (row) {
      if (!Object.prototype.hasOwnProperty.call(access, row.project_id)) access[row.project_id] = [];
      access[row.project_id].push({ userId: row.user_id, canTrack: row.can_track === 1 });
    });
    return {
      projects: read[0].map(function (row) {
        var out = ActCatalog.projectOut_(row, true);
        out.access = Object.prototype.hasOwnProperty.call(access, row.id) ? access[row.id] : [];
        return out;
      })
    };
  },

  /** The values of a project as the table would hold them, from a payload (booleans as 0/1, absent as the default). */
  projectColumns_: function (payload) {
    var columns = ActCatalog.changesFrom_(payload, ActCatalog.PROJECT_KEYS_);
    [['restricted', 'restricted'], ['billable_default', 'billableDefault']].forEach(function (pair) {
      var column = pair[0];
      if (!Object.prototype.hasOwnProperty.call(columns, column)) return;
      if (typeof columns[column] !== 'boolean') throw Validate.fail_(pair[1], pair[1] + ' must be true or false; it cannot be cleared');
      columns[column] = columns[column] ? 1 : 0;
    });
    return columns;
  },

  /** An end date before the start date is VALIDATION on endDate. */
  checkDates_: function (start, end) {
    if (typeof start === 'string' && typeof end === 'string' && end < start) {
      throw Validate.fail_('endDate', 'endDate must not be before startDate');
    }
  },

  /** The client, when given, must be in this workspace and ACTIVE. */
  clientAssert_: function (tx, workspaceId, clientId) {
    if (clientId === undefined || clientId === null) return;
    tx.assert('client', "EXISTS (SELECT 1 FROM clients WHERE id = ? AND workspace_id = ? AND status = 'ACTIVE')", [clientId, workspaceId], 'NOT_FOUND', 'No such client.');
  },

  projectsCreate_: function (ctx) {
    var p = ctx.payload;
    ActCatalog.checkDates_(p.startDate, p.endDate);
    var given = ActCatalog.projectColumns_(p);
    var columns = {
      client_id: null, name: null, code: null, restricted: 0, billable_default: 1, hourly_rate_minor: null, cost_rate_minor: null,
      estimate_minutes: null, budget_minor: null, start_date: null, end_date: null, color: null
    };
    Object.keys(given).forEach(function (c) { columns[c] = given[c]; });
    return ActCatalog.create_(ctx, {
      table: 'projects', entity: 'PROJECT', columns: columns,
      asserts: function (tx) { ActCatalog.clientAssert_(tx, ctx.workspace.id, columns.client_id); },
      out: function (row) { return ActCatalog.projectOut_(row, true); },
      audit: function (row) {
        var after = {};
        Object.keys(columns).forEach(function (c) { after[c] = row[c]; });
        return after;
      }
    });
  },

  projectsUpdate_: function (ctx) {
    var p = ctx.payload;
    var changes = ActCatalog.projectColumns_(p);
    var before = ActCatalog.current_('projects', ctx.workspace.id, p.id, ActCatalog.PROJECT_COLUMNS_);
    if (before !== null) {
      var merged = Object.assign({}, before, changes);
      ActCatalog.checkDates_(merged.start_date, merged.end_date);
    }
    return ActCatalog.update_(ctx, {
      table: 'projects', entity: 'PROJECT', columns: ActCatalog.PROJECT_COLUMNS_, missing: 'No such project.', changes: changes,
      asserts: function (tx) { ActCatalog.clientAssert_(tx, ctx.workspace.id, changes.client_id); },
      out: function (row) { return ActCatalog.projectOut_(row, true); }
    });
  },

  projectsArchive_: function (ctx) {
    return ActCatalog.archive_(ctx, { table: 'projects', entity: 'PROJECT', missing: 'No such project.' });
  },

  // ------------------------------------------------------------ tasks

  TASK_COLUMNS_: ['id', 'project_id', 'name', 'status', 'estimate_minutes', 'billable_default', 'sort_order', 'version'],

  taskOut_: function (row, admin) {
    var out = { id: row.id, projectId: row.project_id, name: row.name, billableDefault: ActCatalog.bool_(row.billable_default), sortOrder: row.sort_order };
    if (admin) {
      out.status = row.status;
      out.estimateMinutes = row.estimate_minutes;
      out.version = row.version;
    }
    return out;
  },

  /** tasks.list: a workspace admin gets every task; anyone else the active tasks of the projects they may track. */
  tasksList_: function (ctx) {
    var ws = ctx.workspace.id;
    var p = ctx.payload;
    var columns = ActCatalog.TASK_COLUMNS_.map(function (c) { return 't.' + c; }).join(', ');
    var sql = 'SELECT ' + columns + ' FROM tasks t WHERE t.workspace_id = ?';
    var args = [ws];
    if (p.projectId !== undefined && p.projectId !== null) {
      sql += ' AND t.project_id = ?';
      args.push(p.projectId);
    }
    var admin = ctx.workspace.isWsAdmin;
    if (!admin) {
      sql += " AND t.status = 'ACTIVE' AND EXISTS (SELECT 1 FROM projects p WHERE p.id = t.project_id AND p.workspace_id = t.workspace_id AND " + ActCatalog.TRACKABLE_ + ')';
      args.push(ctx.user.role, ctx.user.id);
    }
    var rows = Db.read_([{ sql: sql + ' ORDER BY t.sort_order, t.name, t.id', args: args }])[0];
    return { tasks: rows.map(function (row) { return ActCatalog.taskOut_(row, admin); }) };
  },

  tasksCreate_: function (ctx) {
    var p = ctx.payload;
    return ActCatalog.create_(ctx, {
      table: 'tasks', entity: 'TASK',
      columns: {
        project_id: p.projectId, name: p.name, estimate_minutes: p.estimateMinutes === undefined ? null : p.estimateMinutes,
        billable_default: p.billableDefault === undefined || p.billableDefault === null ? null : (p.billableDefault ? 1 : 0), sort_order: p.sortOrder === undefined ? 0 : p.sortOrder
      },
      asserts: function (tx) {
        tx.assert('project', "EXISTS (SELECT 1 FROM projects WHERE id = ? AND workspace_id = ? AND status = 'ACTIVE')", [p.projectId, ctx.workspace.id], 'NOT_FOUND', 'No such project.');
      },
      out: function (row) { return ActCatalog.taskOut_(row, true); },
      audit: function (row) { return { projectId: row.project_id, name: row.name, estimateMinutes: row.estimate_minutes, billableDefault: row.billable_default, sortOrder: row.sort_order }; }
    });
  },

  tasksUpdate_: function (ctx) {
    var changes = ActCatalog.changesFrom_(ctx.payload, { name: 'name', estimateMinutes: 'estimate_minutes', billableDefault: 'billable_default', sortOrder: 'sort_order' });
    if (typeof changes.billable_default === 'boolean') changes.billable_default = changes.billable_default ? 1 : 0;
    if (changes.sort_order === null) changes.sort_order = 0;
    return ActCatalog.update_(ctx, {
      table: 'tasks', entity: 'TASK', columns: ActCatalog.TASK_COLUMNS_, missing: 'No such task.', changes: changes,
      out: function (row) { return ActCatalog.taskOut_(row, true); }
    });
  },

  tasksArchive_: function (ctx) {
    return ActCatalog.archive_(ctx, { table: 'tasks', entity: 'TASK', missing: 'No such task.' });
  },

  // ------------------------------------------------------------ tags

  TAG_COLUMNS_: ['id', 'name', 'color', 'status', 'version'],

  tagOut_: function (row, admin) {
    var out = { id: row.id, name: row.name, color: row.color };
    if (admin) {
      out.status = row.status;
      out.version = row.version;
    }
    return out;
  },

  /** tags.list: a workspace admin gets every tag with status and version; anyone else the active ones. */
  tagsList_: function (ctx) {
    var admin = ctx.workspace.isWsAdmin;
    var rows = Db.read_([{
      sql: 'SELECT ' + ActCatalog.TAG_COLUMNS_.join(', ') + ' FROM tags WHERE workspace_id = ?' + (admin ? '' : " AND status = 'ACTIVE'") + ' ORDER BY name, id',
      args: [ctx.workspace.id]
    }])[0];
    return { tags: rows.map(function (row) { return ActCatalog.tagOut_(row, admin); }) };
  },

  tagsCreate_: function (ctx) {
    var p = ctx.payload;
    return ActCatalog.create_(ctx, {
      table: 'tags', entity: 'TAG', columns: { name: p.name, color: p.color === undefined ? null : p.color },
      out: function (row) { return ActCatalog.tagOut_(row, true); },
      audit: function (row) { return { name: row.name, color: row.color }; }
    });
  },

  tagsUpdate_: function (ctx) {
    return ActCatalog.update_(ctx, {
      table: 'tags', entity: 'TAG', columns: ActCatalog.TAG_COLUMNS_, missing: 'No such tag.',
      changes: ActCatalog.changesFrom_(ctx.payload, { name: 'name', color: 'color' }),
      out: function (row) { return ActCatalog.tagOut_(row, true); }
    });
  },

  tagsArchive_: function (ctx) {
    return ActCatalog.archive_(ctx, { table: 'tags', entity: 'TAG', missing: 'No such tag.' });
  },

  /**
   * The tag validation that timer.start, timer.switch and entries.update share (section 6.4): every tag must be an
   * ACTIVE tag of this workspace, one assert inside the transaction, so a tag archived a moment ago is caught. An empty
   * list needs no assert. The label must be unique within the transaction.
   */
  tagAssert_: function (tx, workspaceId, tagIds, label) {
    if (!Array.isArray(tagIds) || tagIds.length === 0) return;
    tx.assert(label || 'tags',
      "NOT EXISTS (SELECT 1 FROM json_each(?) j LEFT JOIN tags t ON t.id = j.value AND t.workspace_id = ? AND t.status = 'ACTIVE' WHERE t.id IS NULL)",
      [Util.canonicalJson_(tagIds), workspaceId], 'VALIDATION', 'One of the tags does not exist or is archived.', { field: 'tagIds' });
  },

  /**
   * When FEATURE_TAGS is off for the workspace a non-empty tag list is refused (section 6.2). Returns null, or
   * { code, message, details } for the handler to refuse with (through Main.refuse_, so a retry stays idempotent).
   */
  tagsRefusal_: function (ctx, tagIds) {
    if (!Array.isArray(tagIds) || tagIds.length === 0) return null;
    if (ctx.setting('FEATURE_TAGS')) return null;
    return { code: 'POLICY', message: 'Tags are switched off for this workspace.', details: { rule: 'FEATURE_TAGS' } };
  },

  // ------------------------------------------------------------ project access

  /**
   * Whether a user may track a restricted project (section 6.3). The user must be an active member of the workspace and
   * the project must be in it. Admins and Super Admins are never restricted, so a row for them changes nothing.
   */
  projectAccessSet_: function (ctx) {
    var p = ctx.payload;
    var ws = ctx.workspace.id;
    var before = Db.read_([{
      sql: 'SELECT can_track FROM project_access WHERE project_id = ? AND user_id = ? AND workspace_id = ?', args: [p.projectId, p.userId, ws]
    }], { token: 'rw' })[0];

    var tx = Db.tx_(Auth.dbCtx_(ctx));
    Auth.assertWorkspaceActive_(tx, ws);
    tx.assert('project', 'EXISTS (SELECT 1 FROM projects WHERE id = ? AND workspace_id = ?)', [p.projectId, ws], 'NOT_FOUND', 'No such project.');
    tx.assert('member', 'EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND active = 1)', [ws, p.userId], 'NOT_FOUND', 'No such member.');
    tx.exec('set',
      'INSERT INTO project_access (workspace_id, project_id, user_id, can_track, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(project_id, user_id) DO UPDATE SET can_track = excluded.can_track, updated_at = excluded.updated_at',
      [ws, p.projectId, p.userId, p.canTrack ? 1 : 0, ctx.now, ctx.now]);
    tx.audit(Audit.row_(ctx, {
      entityType: 'PROJECT_ACCESS', entityId: p.projectId + ':' + p.userId, action: 'PROJECT_ACCESS_SET', workspaceId: ws,
      before: before.length === 0 ? null : { canTrack: before[0].can_track === 1 }, after: { canTrack: p.canTrack }
    }));
    var done = Main.commit_(tx, { projectId: p.projectId, userId: p.userId, canTrack: p.canTrack });
    if (!done.duplicate) ActCatalog.invalidate_(ws);
    return done.data;
  }
};
