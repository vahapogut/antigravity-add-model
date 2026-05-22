import { app, Menu, MenuItemConstructorOptions, nativeImage, Tray } from 'electron';
import * as path from 'path';
import { isMacOS } from './utils';

// Keep tray as a global variable to prevent it from being garbage collected.
let tray: Tray | null = null;
let contextMenu: Menu | null = null;

/**
 * Creates a system tray icon with a context menu to focus a window or quit the app.
 *
 * For macOS it uses a template image to automatically handle light/dark mode.
 * Other platforms use the normal app icon.
 */
export function createTray(actions: MenuItemConstructorOptions[]): void {
  // On macOS use a template image (auto-inverts for dark/light menu bar).
  // Otherwise use a full-color icon since template images are unsupported
  // and a solid-black glyph can be invisible on dark panels.
  const iconFile = isMacOS() ? 'trayTemplate.png' : 'icon.png';
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', iconFile));
  if (isMacOS()) {
    icon.setTemplateImage(true);
  }
  tray = new Tray(icon);
  tray.setToolTip(app.getName());
  contextMenu = Menu.buildFromTemplate(actions);
  tray.setContextMenu(contextMenu);
}

/**
 * Updates the active agents count in the tray menu.
 */
export function updateTrayAgentCount(count: number): void {
  if (tray && contextMenu) {
    const countItem = contextMenu.items.find((item) => item.id === 'running-agents');
    if (countItem) {
      countItem.label = (count > 0 ? `${count}` : 'No') + ' agent' + (count === 1 ? '' : 's') + ' running';
      tray.setContextMenu(contextMenu);
    }
  }
}
