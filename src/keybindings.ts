import { BrowserWindow, type BrowserWindowInstance } from 'electron';
import { isMacOS } from './utils';

interface KeybindingActions {
  createNewWindow(): void;
  onQuitRequested(): void;
}

export function registerKeybindings(win: BrowserWindowInstance, actions: KeybindingActions): void {
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown') {
      const isCmdOrCtrl = isMacOS() ? input.meta : input.control;
      if (isCmdOrCtrl && input.shift && input.key.toLowerCase() === 'n') {
        actions.createNewWindow();
        event.preventDefault();
      }
      if (isCmdOrCtrl && input.key.toLowerCase() === 'q') {
        actions.onQuitRequested();
        event.preventDefault();
      }
    }
  });
}
