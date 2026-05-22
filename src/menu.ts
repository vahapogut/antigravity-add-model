import { Menu, MenuItem, MenuItemConstructorOptions, shell } from 'electron';
import { createWindow, isMacOS } from './utils';
import { MenuUpdateStep, updateActions } from './updater';

/**
 * Applies modifications to the default application menu.
 */
export function setupApplicationMenu(url: string): void {
  const menu = Menu.getApplicationMenu();
  if (!menu) {
    return;
  }
  // Adds a "New Window" item to the top of the existing File menu.
  addItemToSubmenu(
    menu,
    'File',
    0,
    new MenuItem({
      label: 'New Window',
      accelerator: 'CmdOrCtrl+Shift+N',
      click: () => {
        createWindow(url);
      },
    }),
  );
  // Add "Check for Updates" to the application menu on macOS.
  if (isMacOS()) {
    const appSubmenu = menu.items[0]?.submenu;
    if (appSubmenu) {
      appSubmenu.insert(
        1,
        new MenuItem({
          id: 'check-for-updates',
          label: MenuUpdateStep.CheckForUpdates,
          click: (menuItem) => {
            const action = updateActions[menuItem.label];
            action?.();
          },
        }),
      );
    }
  }
  // Adds Docs and Toggle Developer Tools to the Help menu
  addItemToSubmenu(
    menu,
    'Help',
    0,
    new MenuItem({
      label: 'Docs',
      click: async () => {
        await shell.openExternal('https://antigravity.google/docs');
      },
    }),
  );
  addItemToSubmenu(
    menu,
    'Help',
    1,
    new MenuItem({
      role: 'toggleDevTools',
    }),
  );
  // Re-apply the menu so the change takes effect.
  Menu.setApplicationMenu(menu);
}

/**
 * Adds a menu item to a submenu of the main application menu.
 */
function addItemToSubmenu(appMenu: Menu, submenuLabel: string, position: number, item: MenuItem): void {
  const submenuItem = appMenu.items.find((item) => item.label === submenuLabel);
  if (!submenuItem?.submenu) {
    return;
  }
  submenuItem.submenu.insert(position, item);
}
