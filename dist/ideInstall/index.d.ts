/**
 * IDE Install — Public API.
 *
 * Re-exports the public surface from the sub-modules so consumers
 * can simply `import { … } from './ideInstall'`.
 */
export { IDE_OLD_DATA_DIR, IDE_NEW_DATA_DIR, IDE_BACKUP_DATA_DIR } from '../paths';
export { WIZARD_SHOWN_KEY, fetchIdeDownloadUrl, getPlatformKey, getIdeInstallPath, shouldShowIdeInstallWizard, } from './constants';
export { downloadFile, extractIde, copyUserData, downloadAndInstallIde } from './service';
export { maybeShowIdeInstallWizard, showIdeInstallWizard } from './wizard';
//# sourceMappingURL=index.d.ts.map