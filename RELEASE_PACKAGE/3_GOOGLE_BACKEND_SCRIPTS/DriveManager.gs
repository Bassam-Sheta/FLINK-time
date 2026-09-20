/**
 * Ultra-Account: Super Admin Master Google Drive Vault Manager
 * ALL screenshots are stored EXCLUSIVELY in the Super Admin's Google Drive storage.
 * Employee personal Google Drive accounts are NEVER used or touched.
 * 
 * Strict Master Vault Hierarchy:
 * /UltraAccount_Master_Vault/
 *    ├── [Workspace_Name]/
 *    │     └── [User_Email]/
 *    │           └── [YYYY-MM-DD]/
 *    │                 ├── sc_20260917_120530_ent123.jpg
 *    │                 └── sc_20260917_121030_ent123.jpg
 */

const MASTER_VAULT_ROOT = "UltraAccount_Master_Vault";

/**
 * Stores a screenshot directly into the Super Admin's Google Drive.
 * Executed under the Super Admin's identity via Apps Script Web App (executeAs: USER_DEPLOYING).
 * 
 * @param {string} workspaceName Name of assigned workspace (e.g. "Engineering Core")
 * @param {string} userEmail Email of employee (e.g. "developer@gmail.com")
 * @param {string} dateStr Format "YYYY-MM-DD"
 * @param {string} screenshotId Unique ID (e.g. "sc_a8f9c12e")
 * @param {string} base64ImageBytes Base64 JPEG/WebP image string
 * @returns {object} file_id and view URL in Super Admin's Drive
 */
function saveScreenshotToMasterVault(workspaceName, userEmail, dateStr, screenshotId, base64ImageBytes) {
  try {
    const rootFolder = getOrCreateMasterVault();
    
    // 1. Workspace Folder: /UltraAccount_Master_Vault/{Workspace_Name}
    const sanitizedWs = (workspaceName || 'Default_Workspace').replace(/[^a-zA-Z0-9_ -]/g, '_');
    const wsFolder = getOrCreateSubFolder(rootFolder, sanitizedWs);
    
    // 2. User Folder: /UltraAccount_Master_Vault/{Workspace_Name}/{User_Email}
    const sanitizedUser = (userEmail || 'unassigned_user').replace(/[^a-zA-Z0-9@._-]/g, '_');
    const userFolder = getOrCreateSubFolder(wsFolder, sanitizedUser);
    
    // 3. Date Folder: /UltraAccount_Master_Vault/{Workspace_Name}/{User_Email}/{YYYY-MM-DD}
    const dateFolder = getOrCreateSubFolder(userFolder, dateStr);
    
    // 4. Save file into Super Admin's Drive
    const cleanBase64 = base64ImageBytes.replace(/^data:image\/(jpeg|png|webp);base64,/, '');
    const decodedBytes = Utilities.base64Decode(cleanBase64);
    const blob = Utilities.newBlob(decodedBytes, 'image/jpeg', screenshotId + '.jpg');
    
    const file = dateFolder.createFile(blob);
    file.setDescription('Ultra-Account monitored screenshot. Workspace: ' + workspaceName + ' | User: ' + userEmail);

    return {
      status: 'SUCCESS',
      file_id: file.getId(),
      file_url: file.getUrl(),
      size_bytes: file.getSize(),
      vault_path: MASTER_VAULT_ROOT + '/' + sanitizedWs + '/' + sanitizedUser + '/' + dateStr + '/' + screenshotId + '.jpg'
    };
  } catch (err) {
    Logger.log('Failed to save to master vault: ' + err.toString());
    throw new Error('Master Drive Vault Error: ' + err.toString());
  }
}

function getOrCreateMasterVault() {
  const folders = DriveApp.getFoldersByName(MASTER_VAULT_ROOT);
  if (folders.hasNext()) return folders.next();
  const folder = DriveApp.createFolder(MASTER_VAULT_ROOT);
  folder.setDescription('Ultra-Account Super Admin Master Vault (All workspaces & screenshots)');
  return folder;
}

function getOrCreateSubFolder(parent, name) {
  const folders = parent.getFoldersByName(name);
  if (folders.hasNext()) return folders.next();
  return parent.createFolder(name);
}

/**
 * Scheduled cleanup trigger: moves archive folders older than retention period to Trash
 */
function runMasterVaultRetention(retentionDays) {
  const days = retentionDays || 90;
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);
  const cutoffStr = Utilities.formatDate(cutoffDate, 'GMT', 'yyyy-MM-dd');

  Logger.log('Running Master Vault Retention for dates prior to: ' + cutoffStr);
  const root = getOrCreateMasterVault();
  const wsFolders = root.getFolders();

  while (wsFolders.hasNext()) {
    const ws = wsFolders.next();
    const userFolders = ws.getFolders();
    while (userFolders.hasNext()) {
      const uFolder = userFolders.next();
      const dateFolders = uFolder.getFolders();
      while (dateFolders.hasNext()) {
        const dFolder = dateFolders.next();
        if (/^\d{4}-\d{2}-\d{2}$/.test(dFolder.getName()) && dFolder.getName() < cutoffStr) {
          dFolder.setTrashed(true);
        }
      }
    }
  }
}
