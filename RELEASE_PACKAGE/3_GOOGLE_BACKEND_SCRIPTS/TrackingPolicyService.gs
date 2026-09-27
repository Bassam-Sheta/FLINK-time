/**
 * FLINK Time & Workforce Platform — Tracking Policy Service
 * Centralizes time-tracking policy and referential-integrity checks.
 */

const TrackingPolicyService = {
  _toBoolean(value, defaultValue = false) {
    if (value === true || value === 1 || value === 'TRUE' || value === 'true' || value === '1') return true;
    if (value === false || value === 0 || value === 'FALSE' || value === 'false' || value === '0') return false;
    return defaultValue;
  },

  _getBooleanSetting(key, defaultValue) {
    const raw = MasterRepository.getGlobalSetting(key, '');
    if (raw === '' || raw === null || raw === undefined) return defaultValue;
    return this._toBoolean(raw, defaultValue);
  },

  getPolicy(workspaceId) {
    const workspaceManual = MasterRepository.getGlobalSetting(`WS_${workspaceId}_ALLOW_MANUAL`, '');
    const globalManual = this._getBooleanSetting('RULE_ALLOW_MANUAL', true);

    return {
      projectRequired: this._getBooleanSetting('RULE_PROJECT_REQUIRED', false),
      taskRequired: this._getBooleanSetting('RULE_TASK_REQUIRED', false),
      descriptionRequired: this._getBooleanSetting('RULE_DESC_REQUIRED', false),
      tagsRequired: this._getBooleanSetting('RULE_TAGS_REQUIRED', false),
      allowManual: workspaceManual === '' ? globalManual : this._toBoolean(workspaceManual, globalManual),
      pastEntryEditDays: Math.max(
        0,
        parseInt(MasterRepository.getGlobalSetting('PAST_ENTRY_EDIT_DAYS', '7'), 10) || 0
      )
    };
  },

  normalizeTagIds(rawTags) {
    if (rawTags === null || rawTags === undefined || rawTags === '') return [];
    const values = Array.isArray(rawTags) ? rawTags : String(rawTags).split(',');
    return [...new Set(values.map(v => String(v).trim()).filter(Boolean))];
  },

  assertProjectAccess(authContext, workspaceId, projectId) {
    if (!projectId || authContext.role !== CONSTANTS.ROLES.USER) return true;

    const assignments = SheetRepository.listUserProjectAccess(workspaceId, authContext.userId);
    // Backwards-compatible default: if no project ACLs exist for this user, active projects are available.
    if (assignments.length === 0) return true;

    const assignment = assignments.find(row => row.ProjectID === projectId);
    const canTrack = assignment && this._toBoolean(assignment.CanTrack, false);
    if (!canTrack) {
      throw new AppError(
        ERROR_CODES.PERMISSION_DENIED,
        'You are not authorized to track time against the selected project.',
        403
      );
    }
    return true;
  },

  validateTrackingContext(authContext, workspaceId, payload = {}, options = {}) {
    AuthorizationService.assertWorkspaceAccess(authContext, workspaceId);

    const policy = this.getPolicy(workspaceId);
    const isManual = options.manual === true;

    if (isManual && !policy.allowManual) {
      throw new AppError(
        ERROR_CODES.PERMISSION_DENIED,
        'Manual time entry is disabled for this workspace.',
        403
      );
    }

    const projectId = payload.projectId ? String(payload.projectId).trim() : '';
    const taskId = payload.taskId ? String(payload.taskId).trim() : '';
    const description = payload.description
      ? Validation.sanitizeCellValue(String(payload.description).trim())
      : '';
    const tagIds = this.normalizeTagIds(
      payload.tagIds !== undefined ? payload.tagIds : payload.tags
    );

    if (policy.projectRequired && !projectId) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'A project is required by the tracking policy.', 400);
    }
    if (policy.taskRequired && !taskId) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'A task is required by the tracking policy.', 400);
    }
    if (policy.descriptionRequired && !description) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'A description is required by the tracking policy.', 400);
    }
    if (policy.tagsRequired && tagIds.length === 0) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'At least one tag is required by the tracking policy.', 400);
    }

    let project = null;
    if (projectId) {
      project = SheetRepository.getProject(workspaceId, projectId);
      if (!project) {
        throw new AppError(ERROR_CODES.NOT_FOUND, `Project ${projectId} was not found.`, 404);
      }
      if (String(project.Status || '').toUpperCase() !== 'ACTIVE') {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'The selected project is not active.', 400);
      }
      this.assertProjectAccess(authContext, workspaceId, projectId);
    }

    let task = null;
    if (taskId) {
      if (!projectId) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'A task cannot be selected without its project.', 400);
      }
      task = SheetRepository.getTask(workspaceId, taskId);
      if (!task) {
        throw new AppError(ERROR_CODES.NOT_FOUND, `Task ${taskId} was not found.`, 404);
      }
      if (task.ProjectID !== projectId) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'The selected task does not belong to the selected project.', 400);
      }
      const taskStatus = String(task.Status || '').toUpperCase();
      if (!['OPEN', 'ACTIVE'].includes(taskStatus)) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'The selected task is not open for time tracking.', 400);
      }
    }

    if (tagIds.length > 0) {
      const tags = SheetRepository.listTags(workspaceId);
      const tagMap = new Map(tags.map(tag => [tag.TagID, tag]));
      for (const tagId of tagIds) {
        const tag = tagMap.get(tagId);
        if (!tag) {
          throw new AppError(ERROR_CODES.NOT_FOUND, `Tag ${tagId} was not found.`, 404);
        }
        if (String(tag.Status || '').toUpperCase() !== 'ACTIVE') {
          throw new AppError(ERROR_CODES.VALIDATION_ERROR, `Tag ${tagId} is not active.`, 400);
        }
      }
    }

    let billable;
    if (payload.billable !== undefined) {
      billable = this._toBoolean(payload.billable, false);
    } else if (project) {
      billable = this._toBoolean(project.BillableDefault, true);
    } else {
      billable = true;
    }

    return {
      policy,
      project,
      task,
      projectId,
      taskId,
      description,
      tagIds,
      tagIdsCsv: tagIds.join(','),
      billable
    };
  },

  assertEntryEditableByAge(workspaceId, entry) {
    const policy = this.getPolicy(workspaceId);
    if (!policy.pastEntryEditDays) return true;

    const entryTime = new Date(entry.EndUTC || entry.StartUTC).getTime();
    if (isNaN(entryTime)) return true;

    const cutoff = Date.now() - policy.pastEntryEditDays * 24 * 3600 * 1000;
    if (entryTime < cutoff) {
      throw new AppError(
        ERROR_CODES.PERMISSION_DENIED,
        `This entry is older than the ${policy.pastEntryEditDays}-day edit window.`,
        403
      );
    }
    return true;
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { TrackingPolicyService };
}
