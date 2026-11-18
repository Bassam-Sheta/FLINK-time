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
  }
};
