/**
 * FLINK Time & Workforce Platform — Workspace Timezone Service
 * Keeps storage timestamps in UTC while deriving business dates/weeks in the
 * workspace's configured IANA timezone.
 */

const TimezoneService = {
  getWorkspaceTimezone(workspaceId) {
    const ws = MasterRepository.getWorkspace(workspaceId);
    return (ws && ws.Timezone) ||
      MasterRepository.getGlobalSetting('DEFAULT_TIMEZONE', 'UTC') ||
      'UTC';
  },

  _parseDateKey(dateKey) {
    const match = String(dateKey || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Invalid local date. Expected YYYY-MM-DD.', 400);
    }
    return {
      year: parseInt(match[1], 10),
      month: parseInt(match[2], 10),
      day: parseInt(match[3], 10)
    };
  },

  _offsetMinutes(date, timezone) {
    if (typeof Utilities !== 'undefined' && Utilities.formatDate) {
      const raw = Utilities.formatDate(date, timezone, 'Z'); // e.g. +0300
      const match = String(raw).match(/^([+-])(\d{2})(\d{2})$/);
      if (!match) {
        throw new AppError(ERROR_CODES.INTERNAL_ERROR, `Could not resolve timezone offset for ${timezone}.`, 500);
      }
      const sign = match[1] === '-' ? -1 : 1;
      return sign * (parseInt(match[2], 10) * 60 + parseInt(match[3], 10));
    }

    // Node/test fallback. Compute timezone offset by formatting parts in the
    // target timezone and comparing those wall-clock components to UTC.
    if (typeof Intl !== 'undefined' && Intl.DateTimeFormat) {
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23'
      });
      const parts = formatter.formatToParts(date);
      const obj = {};
      parts.forEach(p => {
        if (p.type !== 'literal') obj[p.type] = p.value;
      });
      const asUtc = Date.UTC(
        parseInt(obj.year, 10),
        parseInt(obj.month, 10) - 1,
        parseInt(obj.day, 10),
        parseInt(obj.hour, 10),
        parseInt(obj.minute, 10),
        parseInt(obj.second, 10)
      );
      return Math.round((asUtc - date.getTime()) / 60000);
    }

    return 0;
  },

  localDateTimeToUtc(dateKey, timezone, hour = 0, minute = 0, second = 0, millisecond = 0) {
    const { year, month, day } = this._parseDateKey(dateKey);
    const wallClockAsUtc = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
    let resolved = wallClockAsUtc;

    // Two/three passes handle DST offset changes around the target instant.
    for (let i = 0; i < 3; i++) {
      const offsetMinutes = this._offsetMinutes(new Date(resolved), timezone);
      const next = wallClockAsUtc - offsetMinutes * 60000;
      if (next === resolved) break;
      resolved = next;
    }
    return new Date(resolved);
  },

  formatDateKey(workspaceId, dateValue) {
    const date = dateValue instanceof Date ? dateValue : new Date(dateValue);
    if (isNaN(date.getTime())) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Invalid UTC timestamp.', 400);
    }
    const timezone = this.getWorkspaceTimezone(workspaceId);
    if (typeof Utilities !== 'undefined' && Utilities.formatDate) {
      return Utilities.formatDate(date, timezone, 'yyyy-MM-dd');
    }
    if (typeof Intl !== 'undefined' && Intl.DateTimeFormat) {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      }).formatToParts(date);
      const obj = {};
      parts.forEach(p => {
        if (p.type !== 'literal') obj[p.type] = p.value;
      });
      return `${obj.year}-${obj.month}-${obj.day}`;
    }
    return date.toISOString().substring(0, 10);
  },

  formatMonthKey(workspaceId, dateValue) {
    return this.formatDateKey(workspaceId, dateValue).substring(0, 7);
  },

  addLocalDays(dateKey, days) {
    const { year, month, day } = this._parseDateKey(dateKey);
    const d = new Date(Date.UTC(year, month - 1, day + days));
    return d.toISOString().substring(0, 10);
  },

  diffLocalDateDays(startDateKey, endDateKey) {
    const s = this._parseDateKey(startDateKey);
    const e = this._parseDateKey(endDateKey);
    const sMs = Date.UTC(s.year, s.month - 1, s.day);
    const eMs = Date.UTC(e.year, e.month - 1, e.day);
    return Math.round((eMs - sMs) / 86400000);
  },

  getWeekBounds(workspaceId, dateOrLocalKey) {
    const timezone = this.getWorkspaceTimezone(workspaceId);
    const input = String(dateOrLocalKey || '');
    const localDateKey = /^\d{4}-\d{2}-\d{2}$/.test(input)
      ? input
      : this.formatDateKey(workspaceId, dateOrLocalKey);

    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const configured = String(MasterRepository.getGlobalSetting('WEEK_STARTS', 'Sunday') || 'Sunday');
    const configuredIndex = dayNames.findIndex(d => d.toLowerCase() === configured.toLowerCase());
    const startDayIndex = configuredIndex >= 0 ? configuredIndex : 0;

    const p = this._parseDateKey(localDateKey);
    const calendarDate = new Date(Date.UTC(p.year, p.month - 1, p.day));
    const currentDayIndex = calendarDate.getUTCDay();
    const delta = (currentDayIndex - startDayIndex + 7) % 7;

    const startLocalDate = this.addLocalDays(localDateKey, -delta);
    const nextWeekLocalDate = this.addLocalDays(startLocalDate, 7);
    const endLocalDate = this.addLocalDays(startLocalDate, 6);

    const startUtc = this.localDateTimeToUtc(startLocalDate, timezone, 0, 0, 0, 0);
    const nextWeekUtc = this.localDateTimeToUtc(nextWeekLocalDate, timezone, 0, 0, 0, 0);
    const endUtc = new Date(nextWeekUtc.getTime() - 1);

    const dayLabels = [];
    for (let i = 0; i < 7; i++) {
      dayLabels.push(dayNames[(startDayIndex + i) % 7]);
    }

    return {
      timezone,
      startLocalDate,
      endLocalDate,
      startUtc,
      endUtc,
      dayLabels
    };
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { TimezoneService };
}
