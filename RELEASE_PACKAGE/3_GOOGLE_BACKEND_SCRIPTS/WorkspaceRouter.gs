/**
 * FLINK Time & Workforce Platform — Workspace Router
 * Resolves logical workspace IDs to physical Google Spreadsheet instances
 * via the Master Control Sheet registry. Prevents raw Sheet ID manipulation.
 */

const WorkspaceRouter = {
  // In-memory request cache for spreadsheet references
  cache: {},

  /**
   * Resolves physical Google Spreadsheet for a logical workspace ID
   */
  resolveSpreadsheet(workspaceId) {
    if (!workspaceId) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Workspace ID is required.');
    }

    if (this.cache[workspaceId]) {
      return this.cache[workspaceId];
    }

    const wsRecord = MasterRepository.getWorkspace(workspaceId);
    if (!wsRecord) {
      throw new AppError(ERROR_CODES.WORKSPACE_NOT_FOUND, `Workspace '${workspaceId}' does not exist in registry.`, 404);
    }

    if (wsRecord.Status === CONSTANTS.WORKSPACE_STATUS.ARCHIVED) {
      throw new AppError(ERROR_CODES.WORKSPACE_NOT_FOUND, `Workspace '${workspaceId}' has been archived.`, 410);
    }

    if (!wsRecord.SpreadsheetID) {
      throw new AppError(ERROR_CODES.INTERNAL_ERROR, `Spreadsheet ID not registered for workspace '${workspaceId}'.`, 500);
    }

    if (typeof SpreadsheetApp === 'undefined') {
      throw new AppError(ERROR_CODES.INTERNAL_ERROR, 'SpreadsheetApp runtime is unavailable.');
    }

    const ss = SpreadsheetApp.openById(wsRecord.SpreadsheetID);
    this.cache[workspaceId] = ss;
    return ss;
  },

  /**
   * Clears in-memory router cache
   */
  clearCache() {
    this.cache = {};
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    WorkspaceRouter
  };
}
