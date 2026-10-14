/**
 * TrackerService — storage v2 orchestration: start / switch / stop / manual add / edit / delete.
 * Pure logic over injected dependencies (registry, store, gate, routing, clock, sha256Hex).
 *
 * Registry contract (Master/Home sheets in production, in-memory in tests):
 *   getMembership(userId, workspaceId) -> {cohortId} | null
 *   getCohort(workspaceId, cohortId)   -> {CurrentPart}
 *   getPartCells(workspaceId, cohortId, part) -> number   (cached counter, refreshed nightly)
 *   openPart(workspaceId, cohortId, part) -> spreadsheet | null
 *   createPart(workspaceId, cohortId, part) -> spreadsheet (also moves CurrentPart to `part`)
 *   setCurrentPart(workspaceId, cohortId, part)  (used when the next part already exists)
 *   getActive(userId) / setActive(userId, {workspaceId,cohortId,entryId,token}) / clearActive(userId)
 *   validateProjectTask(workspaceId, projectId, taskId) -> boolean
 *
 * Rules: one running timer per user; switching is stop+start under one per-user gate and is
 * retry-safe (the same operationId completes a half-finished switch without double work);
 * a running timer always stops in the part it started in; durations are capped at 24 h.
 * Known limit: a retry of a START that arrives after the entry was already stopped AND after a
 * part rollover could create a second entry (the id embeds the part). Retries arrive within seconds.
 */
const TrackerService = (function () {
  'use strict';

  const MAX_DURATION_SEC = 86400;
  const FUTURE_SKEW_MS = 60000;
  const OP_RE = /^[A-Za-z0-9_-]{8,64}$/;
  const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  const EDITABLE = ['ProjectId', 'TaskId', 'Tags', 'Billable', 'Description', 'WorkMode', 'StartUTC', 'EndUTC'];
  const LIMITS = { Description: 2000, Tags: 500, ProjectId: 64, TaskId: 64 };

  function fail_(code, message) {
    const e = new Error('TrackerService: ' + message);
    e.code = code;
    throw e;
  }

  function create(deps) {
    ['registry', 'store', 'gate', 'routing', 'now', 'sha256Hex'].forEach(function (k) {
      if (!deps || !deps[k]) fail_('BAD_DEPS', 'missing dependency ' + k);
    });
    const R = deps.registry, S = deps.store, G = deps.gate, P = deps.routing;

    function need_(cond, code, msg) { if (!cond) fail_(code, msg); }

    function checkCommon_(a) {
      need_(a && typeof a.userId === 'string' && a.userId, 'BAD_INPUT', 'userId is required');
      need_(typeof a.workspaceId === 'string' && a.workspaceId, 'BAD_INPUT', 'workspaceId is required');
    }
    function checkOp_(a) {
      need_(OP_RE.test(a.operationId || ''), 'BAD_INPUT', 'operationId must be 8-64 of A-Z a-z 0-9 _ -');
    }
    function checkText_(obj) {
      Object.keys(LIMITS).forEach(function (k) {
        if (obj[k] !== undefined && obj[k] !== null) {
          need_(typeof obj[k] === 'string', 'BAD_INPUT', k + ' must be text');
          need_(obj[k].length <= LIMITS[k], 'BAD_INPUT', k + ' is too long');
        }
      });
      if (obj.Billable !== undefined) need_(typeof obj.Billable === 'boolean', 'BAD_INPUT', 'Billable must be true/false');
      if (obj.WorkMode !== undefined) need_(['', 'OFFICE', 'WFH'].indexOf(obj.WorkMode) !== -1, 'BAD_INPUT', 'invalid WorkMode');
    }
    function checkProject_(ws, projectId, taskId) {
      if (!projectId) { need_(!taskId, 'PROJECT_INVALID', 'a task needs a project'); return; }
      need_(R.validateProjectTask(ws, projectId, taskId || ''), 'PROJECT_INVALID', 'project/task is not available');
    }
    function member_(userId, ws) {
      const m = R.getMembership(userId, ws);
      need_(m && m.cohortId, 'NOT_MEMBER', 'user is not a member of this workspace');
      return m;
    }
    function openPart_(ws, cohortId, part) {
      const ss = R.openPart(ws, cohortId, part);
      need_(ss, 'PART_MISSING', 'part ' + part + ' of ' + cohortId + ' is not available');
      return ss;
    }
    function keyOf_(userId, ws, cohortId, part) {
      return P.chainKey(userId, ws + '-' + cohortId + '-P' + part);
    }
    function token_(userId, operationId) {
      return deps.sha256Hex(userId + '|' + operationId).slice(0, 24);
    }
    function nowIso_() {
      const ts = deps.now();
      need_(ISO_RE.test(ts), 'BAD_CLOCK', 'clock must return ISO UTC with milliseconds');
      return ts;
    }

    /** Where does a NEW entry go? Creates the next part when the current one is >= 70% full. */
    function writeTarget_(ws, cohortId, userId) {
      const cohort = R.getCohort(ws, cohortId);
      const plan = P.planNewWrite(cohort, R.getPartCells(ws, cohortId, cohort.CurrentPart));
      let ss = R.openPart(ws, cohortId, plan.part);
      if (!ss) ss = R.createPart(ws, cohortId, plan.part);
      else if (plan.createPart) R.setCurrentPart(ws, cohortId, plan.part);
      S.ensureUserTabs(ss, userId);
      return { ss: ss, part: plan.part };
    }

    function stopEntry_(userId, ws, cohortId, entryId, ts) {
      const part = P.partOfEntryId(entryId);
      const ss = openPart_(ws, cohortId, part);
      const e = S.getEntry(ss, userId, entryId);
      need_(e, 'NO_ENTRY', 'entry not found: ' + entryId);
      if (e.Status !== 'RUNNING') return { alreadyStopped: true, entry: e, clamped: false };
      let end = ts < e.StartUTC ? e.StartUTC : ts;
      let clamped = false;
      const cap = new Date(Date.parse(e.StartUTC) + MAX_DURATION_SEC * 1000).toISOString();
      if (end > cap) { end = cap; clamped = true; }
      const r = S.change(ss, userId, keyOf_(userId, ws, cohortId, part), ts, userId, 'STOP', entryId, { EndUTC: end });
      return { alreadyStopped: false, entry: r.entry, clamped: clamped };
    }

    /** a: {userId, workspaceId, operationId, switchIfRunning?, ProjectId?, TaskId?, Tags?, Billable?, Description?, WorkMode?} */
    function startTimer(a) {
      checkCommon_(a); checkOp_(a); checkText_(a);
      const m = member_(a.userId, a.workspaceId);
      checkProject_(a.workspaceId, a.ProjectId, a.TaskId);
      const tok = token_(a.userId, a.operationId);
      return G.run(a.userId, function () {
        const ts = nowIso_();
        let stopped = null;
        const active = R.getActive(a.userId);
        if (active) {
          if (active.token === tok) {                       // retry of an already completed start
            const part = P.partOfEntryId(active.entryId);
            const e = S.getEntry(openPart_(active.workspaceId, active.cohortId, part), a.userId, active.entryId);
            if (e) return { entry: e, duplicate: true, stopped: null };
          }
          const part = P.partOfEntryId(active.entryId);
          const cur = S.getEntry(openPart_(active.workspaceId, active.cohortId, part), a.userId, active.entryId);
          if (cur && cur.Status === 'RUNNING') {
            need_(a.switchIfRunning === true, 'TIMER_RUNNING', 'a timer is already running');
            stopped = stopEntry_(a.userId, active.workspaceId, active.cohortId, active.entryId, ts);
          }
          R.clearActive(a.userId);
        }
        const tgt = writeTarget_(a.workspaceId, m.cohortId, a.userId);
        const entryId = P.makeEntryId(tgt.part, tok);
        const res = S.start(tgt.ss, a.userId, keyOf_(a.userId, a.workspaceId, m.cohortId, tgt.part), ts, a.userId, {
          EntryId: entryId, StartUTC: ts, ProjectId: a.ProjectId || '', TaskId: a.TaskId || '',
          Tags: a.Tags || '', Billable: a.Billable === true, Description: a.Description || '', WorkMode: a.WorkMode || ''
        }, 'START');
        if (res.entry.Status === 'RUNNING') {
          R.setActive(a.userId, { workspaceId: a.workspaceId, cohortId: m.cohortId, entryId: entryId, token: tok });
        }
        return { entry: res.entry, duplicate: res.duplicate, stopped: stopped };
      });
    }

    /** a: {userId, workspaceId?, entryId?}. Without entryId the user's active pointer is used. */
    function stopTimer(a) {
      need_(a && a.userId, 'BAD_INPUT', 'userId is required');
      return G.run(a.userId, function () {
        const ts = nowIso_();
        const active = R.getActive(a.userId);
        const entryId = a.entryId || (active && active.entryId);
        need_(entryId, 'NO_TIMER', 'no running timer');
        let ws, cohortId;
        if (active && active.entryId === entryId) { ws = active.workspaceId; cohortId = active.cohortId; }
        else { need_(a.workspaceId, 'BAD_INPUT', 'workspaceId is required'); ws = a.workspaceId; cohortId = member_(a.userId, ws).cohortId; }
        const r = stopEntry_(a.userId, ws, cohortId, entryId, ts);
        if (active && active.entryId === entryId) R.clearActive(a.userId);
        return r;
      });
    }

    /** a: {userId, workspaceId, operationId, StartUTC, EndUTC, ProjectId?, ...} — a finished entry. */
    function addManual(a) {
      checkCommon_(a); checkOp_(a); checkText_(a);
      need_(ISO_RE.test(a.StartUTC || '') && ISO_RE.test(a.EndUTC || ''), 'BAD_INPUT', 'StartUTC and EndUTC must be ISO UTC with milliseconds');
      const m = member_(a.userId, a.workspaceId);
      checkProject_(a.workspaceId, a.ProjectId, a.TaskId);
      const tok = token_(a.userId, a.operationId);
      return G.run(a.userId, function () {
        const ts = nowIso_();
        const dur = (Date.parse(a.EndUTC) - Date.parse(a.StartUTC)) / 1000;
        need_(dur > 0, 'BAD_TIME', 'EndUTC must be after StartUTC');
        need_(dur <= MAX_DURATION_SEC, 'BAD_TIME', 'an entry cannot exceed 24 hours');
        need_(Date.parse(a.EndUTC) <= Date.parse(ts) + FUTURE_SKEW_MS, 'BAD_TIME', 'entry ends in the future');
        const tgt = writeTarget_(a.workspaceId, m.cohortId, a.userId);
        const entryId = P.makeEntryId(tgt.part, tok);
        const res = S.start(tgt.ss, a.userId, keyOf_(a.userId, a.workspaceId, m.cohortId, tgt.part), ts, a.userId, {
          EntryId: entryId, StartUTC: a.StartUTC, EndUTC: a.EndUTC, ProjectId: a.ProjectId || '', TaskId: a.TaskId || '',
          Tags: a.Tags || '', Billable: a.Billable === true, Description: a.Description || '', WorkMode: a.WorkMode || ''
        }, 'MANUAL_ADD');
        return { entry: res.entry, duplicate: res.duplicate };
      });
    }

    function changeEntry_(a, event, patch) {
      checkCommon_(a);
      need_(a.actor && typeof a.actor === 'string', 'BAD_INPUT', 'actor is required');
      need_(typeof a.entryId === 'string', 'BAD_INPUT', 'entryId is required');
      const m = member_(a.userId, a.workspaceId);
      const part = P.partOfEntryId(a.entryId);
      return G.run(a.userId, function () {
        const ts = nowIso_();
        const ss = openPart_(a.workspaceId, m.cohortId, part);
        const cur = S.getEntry(ss, a.userId, a.entryId);
        need_(cur, 'NO_ENTRY', 'entry not found: ' + a.entryId);
        need_(cur.Status === 'STOPPED', 'NOT_EDITABLE', 'only a stopped, unsubmitted entry can be changed (status ' + cur.Status + ')');
        if (event === 'EDIT') {
          const merged = Object.assign({}, cur, patch);
          const start = merged.StartUTC, end = merged.EndUTC;
          need_(ISO_RE.test(start) && ISO_RE.test(end), 'BAD_INPUT', 'times must be ISO UTC with milliseconds');
          const dur = (Date.parse(end) - Date.parse(start)) / 1000;
          need_(dur >= 0 && dur <= MAX_DURATION_SEC, 'BAD_TIME', 'duration must be between 0 and 24 hours');
          need_(Date.parse(end) <= Date.parse(ts) + FUTURE_SKEW_MS, 'BAD_TIME', 'entry ends in the future');
          if (patch.ProjectId !== undefined || patch.TaskId !== undefined) checkProject_(a.workspaceId, merged.ProjectId, merged.TaskId);
        }
        const r = S.change(ss, a.userId, keyOf_(a.userId, a.workspaceId, m.cohortId, part), ts, a.actor, event, a.entryId, patch);
        return { entry: r.entry, changes: r.changes };
      });
    }

    /** a: {userId, workspaceId, entryId, actor, patch:{...EDITABLE}} */
    function editEntry(a) {
      need_(a && a.patch && typeof a.patch === 'object', 'BAD_INPUT', 'patch is required');
      Object.keys(a.patch).forEach(function (k) { need_(EDITABLE.indexOf(k) !== -1, 'BAD_INPUT', 'field is not editable: ' + k); });
      need_(Object.keys(a.patch).length > 0, 'BAD_INPUT', 'patch is empty');
      checkText_(a.patch);
      return changeEntry_(a, 'EDIT', a.patch);
    }

    function deleteEntry(a) {
      return changeEntry_(a, 'DELETE', {});
    }

    return { startTimer: startTimer, stopTimer: stopTimer, addManual: addManual, editEntry: editEntry, deleteEntry: deleteEntry };
  }

  return { create: create, MAX_DURATION_SEC: MAX_DURATION_SEC };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = TrackerService;
}
