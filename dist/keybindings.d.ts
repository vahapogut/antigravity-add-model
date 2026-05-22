import { type BrowserWindowInstance } from 'electron';
interface KeybindingActions {
    createNewWindow(): void;
    onQuitRequested(): void;
}
export declare function registerKeybindings(win: BrowserWindowInstance, actions: KeybindingActions): void;
export {};
//# sourceMappingURL=keybindings.d.ts.map