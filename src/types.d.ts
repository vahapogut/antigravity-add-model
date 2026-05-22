declare namespace NodeJS {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  interface Process extends EventEmitter {
    resourcesPath: string;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const process: Process;
  interface ErrnoException extends Error {
    code?: string;
  }
}

declare namespace Electron {
  interface IpcRendererEvent {
    sender: unknown;
    senderId: number;
  }

  class IpcMainEvent {
    sender: unknown;
    reply(channel: string, ...args: unknown[]): void;
  }

  interface MessageBoxOptions {
    type?: string;
    buttons?: string[];
    defaultId?: number;
    cancelId?: number;
    title?: string;
    message?: string;
    detail?: string;
    checkboxLabel?: string;
    checkboxChecked?: boolean;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: string]: any;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare class EventEmitter {
  on(event: string, listener: (...args: any[]) => void): this;
  once(event: string, listener: (...args: any[]) => void): this;
  removeListener(event: string, listener: (...args: any[]) => void): this;
  removeAllListeners(event: string): this;
  emit(event: string, ...args: any[]): boolean;
}

declare module 'electron' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const app: {
    getPath(name: string): string;
    getAppPath(): string;
    getVersion(): string;
    isPackaged: boolean;
    commandLine: {
      appendSwitch(switchStr: string, value?: string): void;
      hasSwitch(switchStr: string): boolean;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      [key: string]: any;
    };
    requestSingleInstanceLock(): boolean;
    on(event: string, listener: (...args: any[]) => void): void;
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
      setIcon(image: unknown): void;
    };
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const protocol: {
    handle(scheme: string, handler: (request: any) => Promise<Response>): void;
    registerSchemesAsPrivileged(schemes: unknown[]): void;
  };

  export class Notification {
    constructor(options: { title: string; body: string; silent?: boolean; icon?: string });
    show(): void;
    on(event: string, listener: () => void): void;
  }

  export class Menu {
    constructor();
    static buildFromTemplate(template: MenuItemConstructorOptions[]): Menu;
    static setApplicationMenu(menu: Menu | null): void;
    static getApplicationMenu(): Menu | null;
    getMenuItemById(id: string): MenuItem | null;
    insert(pos: number, item: MenuItem): void;
    popup(options?: Record<string, unknown>): void;
    items: MenuItem[];
  }

  export interface MenuItemConstructorOptions {
    label?: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    click?: (...args: any[]) => void;
    type?: string;
    submenu?: MenuItemConstructorOptions[];
    id?: string;
    accelerator?: string;
    role?: string;
    checked?: boolean;
    enabled?: boolean;
  }

  export class MenuItem {
    constructor(options: MenuItemConstructorOptions);
    id: string;
    label: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    click: (...args: any[]) => void;
    submenu?: Menu;
    enabled: boolean;
  }

  export class Tray {
    constructor(image: NativeImage);
    setContextMenu(menu: Menu): void;
    setToolTip(tip: string): void;
    on(event: string, listener: (...args: unknown[]) => void): void;
    destroy(): void;
  }

  export interface NativeImage {
    toDataURL(): string;
    getSize(): { width: number; height: number };
    setTemplateImage(option: boolean): void;
  }

  export const nativeImage: {
    createFromPath(path: string): NativeImage;
    createEmpty(): NativeImage;
    createFromDataURL(dataURL: string): NativeImage;
  };

  export const nativeTheme: {
    shouldUseDarkColors: boolean;
    themeSource: 'system' | 'light' | 'dark';
    on(event: string, listener: (...args: unknown[]) => void): void;
  };

  export const powerSaveBlocker: {
    start(type: 'prevent-app-suspension' | 'prevent-display-sleep'): number;
    stop(id: number): void;
  };

  export const shell: {
    openExternal(url: string, options?: Record<string, unknown>): Promise<void>;
  };

  export const contextBridge: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    exposeInMainWorld(key: string, api: any): void;
  };

  export const ipcRenderer: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    on(channel: string, listener: (...args: any[]) => void): void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    once(channel: string, listener: (...args: any[]) => void): void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    removeListener(channel: string, listener: (...args: any[]) => void): void;
    removeAllListeners(channel: string): void;
    send(channel: string, ...args: unknown[]): void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    invoke(channel: string, ...args: unknown[]): Promise<any>;
  };

  export const ipcMain: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    on(channel: string, listener: (event: Electron.IpcMainEvent, ...args: any[]) => void): void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handle(channel: string, listener: (...args: any[]) => any): void;
    removeHandler(channel: string): void;
  };

  export const webFrame: {
    setZoomLevel(level: number): void;
    getZoomLevel(): number;
    getZoomFactor(): number;
    setZoomFactor(factor: number): void;
  };

  // Type-only export for function signatures that need BrowserWindow as a type
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type BrowserWindowType = BrowserWindowInstance;

  export const BrowserWindow: {
    new (options?: Record<string, unknown>): BrowserWindowInstance;
    getAllWindows(): BrowserWindowInstance[];
    getFocusedWindow(): BrowserWindowInstance | null;
    fromWebContents(webContents: unknown): BrowserWindowInstance | null;
  };

  export interface BrowserWindowInstance {
    isMinimized(): boolean;
    isMaximized(): boolean;
    isFullScreen(): boolean;
    isVisible(): boolean;
    isDestroyed(): boolean;
    restore(): void;
    show(): void;
    focus(): void;
    loadURL(url: string): Promise<void>;
    loadFile(filePath: string): Promise<void>;
    once(event: string, listener: (...args: unknown[]) => void): void;
    off(event: string, listener: (...args: unknown[]) => void): void;
    contentView: {
      addChildView(view: unknown): void;
      removeChildView(view: unknown): void;
    };
    getContentSize(): [number, number];
    webContents: WebContentsType;
    destroy(): void;
    close(): void;
    hide(): void;
    on(event: string, listener: (...args: unknown[]) => void): void;
    setTitle(title: string): void;
    setTitleBarOverlay(options: Record<string, unknown>): void;
    center(): void;
    minimize(): void;
    maximize(): void;
    unmaximize(): void;
    setFullScreen(flag: boolean): void;
    getBounds(): { x: number; y: number; width: number; height: number };
    setBounds(bounds: { x: number; y: number; width: number; height: number }): void;
  }

  export interface WebContentsType {
    send(channel: string, ...args: unknown[]): void;
    openDevTools(options?: Record<string, unknown>): void;
    closeDevTools(): void;
    toggleDevTools(): void;
    loadURL(url: string): Promise<void>;
    on(channel: string, listener: (...args: any[]) => void): void;
    once(channel: string, listener: (...args: any[]) => void): void;
    removeListener(channel: string, listener: (...args: any[]) => void): void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setWindowOpenHandler(handler: (details: { url: string }) => any): void;
  }

  export class WebContentsView {
    constructor(options?: Record<string, unknown>);
    webContents: WebContentsType;
    setBounds(bounds: { x: number; y: number; width: number; height: number }): void;
    setBackgroundColor(color: string): void;
  }

  export const session: {
    defaultSession: {
      webRequest: {
        onBeforeRequest(callback: (details: { url: string }, cb: (arg: { cancel?: boolean }) => void) => void): void;
      };
      closeAllConnections(): Promise<void>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setCertificateVerifyProc(proc: (request: any, callback: (verificationResult: number) => void) => void): void;
    };
  };

  export const dialog: {
    showErrorBox(title: string, content: string): void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    showMessageBox(window: any, options?: Record<string, unknown>): Promise<{ response: number; filePaths?: string[] }>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    showOpenDialog(window: any, options?: Record<string, unknown>): Promise<{ canceled: boolean; filePaths: string[] }>;
  };

  export const net: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fetch(input: string | Request, init?: RequestInit): Promise<any>;
    AddressInfo: { new (): { port: number } };
  };
}
