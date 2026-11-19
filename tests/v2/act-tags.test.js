'use strict';

// T2.3 — tags.* and the tag validation that timer.start, timer.switch and entries.update share (BUILD_SPEC 6.2, 6.4):
// every tag on an entry or timer must be an ACTIVE tag of the workspace, asserted inside the transaction, and the
// FEATURE_TAGS setting refuses a non-empty list when tags are switched off.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createActEnv, ok, failed } = require('./helpers/act');
const { expectCode } = require('./helpers/asserts');

const W3 = '00000000-0000-4000-8000-0000000000a3';
const wa = (t, action, payload, opts = {}) => t.call('admin1', action, payload, { ws: t.ids.w1, ...opts });
const audits = (t, action) => t.rows(`SELECT * FROM audit_log WHERE action = '${action}' ORDER BY seq`);
const addTag = (t, name = 'Urgent', color = '#ff0000') => ok(wa(t, 'tags.create', { name, color })).tag;
const foreignTag = t => {
  t.insert('workspaces', { id: W3, code: 'W3', name: 'Three', status: 'ACTIVE', timezone: 'Africa/Cairo', week_start: 'SUN', created_at: 2, updated_at: 2, version: 1 });
  t.insert('tags', { id: '00000000-0000-4000-8000-0000000000f3', workspace_id: W3, name: 'Elsewhere', color: null, status: 'ACTIVE', created_at: 1, updated_at: 1, version: 1 });
  return '00000000-0000-4000-8000-0000000000f3';
};

// ---------------------------------------------------------------- tags.list / create / update / archive

test('tags.create: a full tag for the workspace admin, audited, the catalog generation moves', () => {
  const t = createActEnv();
  const gen = t.env.run(`Cache.gen_(Cache.genWs_('${t.ids.w1}'))`);
  const tag = addTag(t);
  assert.deepEqual(tag, { id: tag.id, name: 'Urgent', color: '#ff0000', status: 'ACTIVE', version: 1 });
  assert.deepEqual(t.one(`SELECT workspace_id, status, version FROM tags WHERE id = '${tag.id}'`), { workspace_id: t.ids.w1, status: 'ACTIVE', version: 1 });
  const [audit] = audits(t, 'TAG_CREATED');
  assert.deepEqual([audit.actor_user_id, audit.entity_type, audit.entity_id, audit.workspace_id], [t.ids.admin1, 'TAG', tag.id, t.ids.w1]);
  assert.deepEqual(JSON.parse(audit.after_json), { name: 'Urgent', color: '#ff0000' });
  assert.equal(t.env.run(`Cache.gen_(Cache.genWs_('${t.ids.w1}'))`), gen + 1);
  assert.equal(ok(wa(t, 'tags.create', { name: 'Plain' })).tag.color, null);
});

test('tags.create: the name is 1 to 60 characters and unique in the workspace; plain members, Users and archived workspaces are refused', () => {
  const t = createActEnv();
  addTag(t);
  failed(wa(t, 'tags.create', { name: 'Urgent' }), 'CONFLICT');
  for (const name of ['', '   ', 'a'.repeat(61), 'two\nlines']) assert.equal(failed(wa(t, 'tags.create', { name }), 'VALIDATION').details.field, 'name');
  ok(wa(t, 'tags.create', { name: 'a'.repeat(60) }));
  failed(t.call('admin2', 'tags.create', { name: 'x' }, { ws: t.ids.w1 }), 'FORBIDDEN');
  failed(t.call('user1', 'tags.create', { name: 'x' }, { ws: t.ids.w1 }), 'FORBIDDEN');
  failed(t.call('admin1', 'tags.create', { name: 'x' }, { ws: t.ids.w2 }), 'FORBIDDEN');
  ok(t.call('sa', 'tags.create', { name: 'Elsewhere' }, { ws: t.ids.w1 }));
});

test('tags.create: a retry with the same request id returns the same tag once', () => {
  const t = createActEnv();
  const requestId = '88888888-8888-4888-8888-888888888888';
  const first = ok(wa(t, 'tags.create', { name: 'Once' }, { requestId }));
  assert.deepEqual(ok(wa(t, 'tags.create', { name: 'Once' }, { requestId })), first);
  assert.equal(t.rows("SELECT * FROM tags WHERE name = 'Once'").length, 1);
  assert.equal(audits(t, 'TAG_CREATED').length, 1);
});

test('tags.list: a workspace admin sees all tags with status and version; anyone else only the active ones, id name color', () => {
  const t = createActEnv();
  foreignTag(t);                                   // another workspace's tag must never appear
  const a = addTag(t, 'Alpha');
  addTag(t, 'Beta');
  ok(wa(t, 'tags.archive', { id: a.id, version: 1 }));
  const admin = ok(wa(t, 'tags.list')).tags;
  assert.deepEqual(admin.map(g => [g.name, g.status, g.version]), [['Alpha', 'ARCHIVED', 2], ['Beta', 'ACTIVE', 1], ['Tag A', 'ACTIVE', 1], ['Tag B', 'ARCHIVED', 1]]);
  for (const persona of ['user1', 'admin2']) {
    const rows = ok(t.call(persona, 'tags.list', {}, { ws: t.ids.w1 })).tags;
    assert.deepEqual(rows.map(g => g.name), ['Beta', 'Tag A'], persona);
    assert.deepEqual(Object.keys(rows[0]).sort(), ['color', 'id', 'name']);
  }
});

test('tags.update: changes what is sent, null clears the colour, the version moves, before and after are audited', () => {
  const t = createActEnv();
  const tag = addTag(t);
  assert.deepEqual(ok(wa(t, 'tags.update', { id: tag.id, version: 1, name: 'Critical' })).tag, { id: tag.id, name: 'Critical', color: '#ff0000', status: 'ACTIVE', version: 2 });
  assert.equal(ok(wa(t, 'tags.update', { id: tag.id, version: 2, name: 'Critical', color: null })).tag.color, null);
  const [first] = audits(t, 'TAG_UPDATED');
  assert.deepEqual([JSON.parse(first.before_json), JSON.parse(first.after_json)], [{ name: 'Urgent' }, { name: 'Critical' }]);
});

test('tags.update: a stale version, a taken name and another workspace\'s tag are refused', () => {
  const t = createActEnv();
  const foreign = foreignTag(t);
  const a = addTag(t, 'Alpha');
  addTag(t, 'Beta');
  failed(wa(t, 'tags.update', { id: a.id, version: 4, name: 'Alpha' }), 'CONFLICT');
  failed(wa(t, 'tags.update', { id: a.id, version: 1, name: 'Beta' }), 'CONFLICT');
  failed(wa(t, 'tags.update', { id: foreign, version: 1, name: 'Hijacked' }), 'NOT_FOUND');
  assert.equal(t.one(`SELECT name FROM tags WHERE id = '${foreign}'`).name, 'Elsewhere');
});

test('tags.archive: archives once; old entries keep the tag; archiving again or a foreign tag is refused', () => {
  const t = createActEnv();
  const foreign = foreignTag(t);
  const tag = addTag(t);
  t.insert('time_entries', { id: '00000000-0000-4000-8000-0000000000b1', workspace_id: t.ids.w1, user_id: t.ids.user1, project_id: null, task_id: null, description: '', start_at: 1000, end_at: 2000,
    duration_s: 1, local_date: '2026-11-05', billable: 1, hourly_rate_minor: null, cost_rate_minor: null, source: 'TIMER', stop_reason: 'USER', timer_id: null, deleted_at: null, deleted_by: null,
    created_at: 1, updated_at: 1, version: 1 });
  t.insert('entry_tags', { entry_id: '00000000-0000-4000-8000-0000000000b1', tag_id: tag.id, workspace_id: t.ids.w1 });
  assert.deepEqual(ok(wa(t, 'tags.archive', { id: tag.id, version: 1 })), { id: tag.id, status: 'ARCHIVED', version: 2 });
  assert.equal(t.rows('SELECT * FROM entry_tags').length, 1, 'the archived tag stays on the old entry');
  failed(wa(t, 'tags.archive', { id: tag.id, version: 2 }), 'CONFLICT');
  failed(wa(t, 'tags.archive', { id: foreign, version: 1 }), 'NOT_FOUND');
  assert.equal(audits(t, 'TAG_ARCHIVED').length, 1);
});

test('race: a version that moved, or an archive of the workspace, between the read and the write is refused by the transaction', () => {
  const t = createActEnv();
  const tag = addTag(t);
  t.env.fakes.fetch.route(t.env.origin + '/', request => {
    if (request.payload.includes('BEGIN IMMEDIATE')) t.env.turso.db.exec('UPDATE tags SET version = version + 1');
    return t.env.turso.handleHttp(request);
  }, { first: true });
  failed(wa(t, 'tags.update', { id: tag.id, version: 1, name: 'x' }), 'CONFLICT');
  failed(wa(t, 'tags.archive', { id: tag.id, version: 1 }), 'CONFLICT');
});

// ---------------------------------------------------------------- the shared tag validation

function check(t, tagIds, workspaceId = t.ids.w1) {
  const tx = t.env.ctx.Db.tx_({ userId: t.ids.user1, requestId: t.env.ctx.Util.id_(), action: 'x', payloadHash: 'h'.repeat(64), now: t.env.fakes.clock.now() });
  t.env.ctx.ActCatalog.tagAssert_(tx, workspaceId, tagIds, 'tags');
  tx.commit();
}

test('tagAssert_: active tags of the workspace pass, and so does an empty list', () => {
  const t = createActEnv();
  const tag = addTag(t);
  assert.doesNotThrow(() => check(t, []));
  assert.doesNotThrow(() => check(t, [t.ids.tagA]));
  assert.doesNotThrow(() => check(t, [t.ids.tagA, tag.id]));
});

test('tagAssert_: an archived, unknown or foreign tag fails the whole list with VALIDATION on tagIds', () => {
  const t = createActEnv();
  const foreign = foreignTag(t);
  const unknown = '00000000-0000-4000-8000-0000000000ff';
  for (const ids of [[t.ids.tagB], [unknown], [foreign], [t.ids.tagA, t.ids.tagB], [t.ids.tagA, foreign], [t.ids.tagA, unknown]]) {
    const err = expectCode(() => check(t, ids), 'VALIDATION');
    assert.deepEqual(t.env.ctx.__plain(err.details), { field: 'tagIds' });
  }
  expectCode(() => check(t, [t.ids.tagA], W3), 'VALIDATION');            // the tag is in W1, not in W3
});

test('tagAssert_: the check runs inside the transaction, so it sees a tag archived after the lookup', () => {
  const t = createActEnv();
  const tx = t.env.ctx.Db.tx_({ userId: t.ids.user1, requestId: t.env.ctx.Util.id_(), action: 'x', payloadHash: 'h'.repeat(64), now: 1 });
  t.env.ctx.ActCatalog.tagAssert_(tx, t.ids.w1, [t.ids.tagA], 'tags');
  t.env.turso.db.exec(`UPDATE tags SET status = 'ARCHIVED' WHERE id = '${t.ids.tagA}'`);
  expectCode(() => tx.commit(), 'VALIDATION');
});

test('tagsRefusal_: FEATURE_TAGS off refuses a non-empty list with POLICY naming the setting, and only that', () => {
  const t = createActEnv();
  const ctx = on => ({ setting: key => { assert.equal(key, 'FEATURE_TAGS'); return on; } });
  const refusal = list => t.env.ctx.__plain(t.env.ctx.ActCatalog.tagsRefusal_(ctx(false), list));
  assert.deepEqual(refusal([t.ids.tagA]), { code: 'POLICY', message: refusal([t.ids.tagA]).message, details: { rule: 'FEATURE_TAGS' } });
  assert.equal(refusal([]), null, 'an empty list is always fine');
  assert.equal(refusal(undefined), null);
  assert.equal(refusal(null), null);
  assert.equal(t.env.ctx.ActCatalog.tagsRefusal_(ctx(true), [t.ids.tagA]), null);
});

test('tagsRefusal_ reads the real setting: per workspace, with the default on', () => {
  const t = createActEnv();
  const real = lists => {
    const ctx = { setting: key => t.env.ctx.Config.value_(t.env.ctx.Config.load_(), key, t.ids.w1) };
    return t.env.ctx.ActCatalog.tagsRefusal_(ctx, lists);
  };
  assert.equal(real([t.ids.tagA]), null);
  t.setSetting(t.ids.w1, 'FEATURE_TAGS', false);
  assert.equal(t.env.ctx.__plain(real([t.ids.tagA])).code, 'POLICY');
  assert.equal(real([]), null);
});
