declare namespace NodeJS {
  interface ErrnoException extends Error {
    code?: string;
  }
}

declare module 'electron' {
  export const app: {
    getPath(name: string): string;
    getVersion(): string;
    commandLine: {
      appendSwitch(switchStr: string, value?: string): void;
      hasSwitch(switchStr: string): boolean;
    };
    requestSingleInstanceLock(): boolean;
    on(event: string, listener: (...args: unknown[]) => void): void;
    isDefaultProtocolClient(protocol: string): boolean;
    setAsDefaultProtocolClient(protocol: string): boolean;
    whenReady(): Promise<void>;
    quit(): void;
    getName(): string;
    setAboutPanelOptions(options: Record<string, unknown>): void;
    focus(options?: Record<string, unknown>): void;
    dock?: {
      setMenu(menu: unknown): void;
      hide(): void;
      show(): void;
    };
  };
  export const BrowserWindow: {
    getAllWindows(): BrowserWindowInstance[];
    getFocusedWindow(): BrowserWindowInstance | null;
    fromWebContents(webContents: unknown): BrowserWindowInstance | null;
  };
  export interface BrowserWindowInstance {
    isMinimized(): boolean;
    restore(): void;
    show(): void;
    focus(): void;
    loadURL(url: string): Promise<void>;
    webContents: { send(channel: string, ...args: unknown[]): void };
    destroy(): void;
  }
  export const session: {
    defaultSession: {
      webRequest: {
        onBeforeRequest(callback: (details: { url: string }, cb: (arg: { cancel?: boolean }) => void) => void): void;
      };
      closeAllConnections(): Promise<void>;
    };
  };
  export const dialog: {
    showErrorBox(title: string, content: string): Promise<void>;
    showMessageBox(window: BrowserWindowInstance, options: Record<string, unknown>): Promise<{ response: number }>;
  };
  export const net: {
    AddressInfo: { new(): { port: number } };
  };
}
