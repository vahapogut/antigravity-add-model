import { MenuItemConstructorOptions } from 'electron';
/**
 * Creates a system tray icon with a context menu to focus a window or quit the app.
 *
 * For macOS it uses a template image to automatically handle light/dark mode.
 * Other platforms use the normal app icon.
 */
export declare function createTray(actions: MenuItemConstructorOptions[]): void;
/**
 * Updates the active agents count in the tray menu.
 */
export declare function updateTrayAgentCount(count: number): void;
//# sourceMappingURL=tray.d.ts.map