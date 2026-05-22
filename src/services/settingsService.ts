import { SleepBlocker } from '../utils';

// Setting keys
export enum SettingKey {
  RUN_IN_BACKGROUND = 'runInBackground',
  KEEP_COMPUTER_AWAKE = 'keepComputerAwake',
}

// Default values
export const DEFAULTS = new Map<SettingKey, boolean>([
  // The following setting is off by default for windows because the app
  // icon is not as discoverable in the bottom right corner menu bar as
  // it is on macOS and linux.
  [SettingKey.RUN_IN_BACKGROUND, process.platform !== 'win32'],
  [SettingKey.KEEP_COMPUTER_AWAKE, false],
]);

interface StorageManager {
  onDidChange(listener: (changes: Record<string, string | null>) => void): { dispose(): void };
  getItems(): Promise<Record<string, string | null>>;
}

/**
 * A thin wrapper around StorageManager to listen for changes
 * in settings and apply their side effects.
 */
export class SettingsService {
  private storageManager: StorageManager;

  constructor(storageManager: StorageManager) {
    this.storageManager = storageManager;
    this.storageManager.onDidChange((changes) => {
      this.applySideEffects(changes);
    });
    void this.initialize();
  }

  async initialize(): Promise<void> {
    const items = await this.storageManager.getItems();
    this.applySideEffects(items);
  }

  applySideEffects(settings: Record<string, string | null>): void {
    const val = settings[SettingKey.KEEP_COMPUTER_AWAKE];
    if (val !== undefined) {
      const preventSleep = val === null ? DEFAULTS.get(SettingKey.KEEP_COMPUTER_AWAKE) : val === 'true';
      SleepBlocker.getInstance().shouldKeepComputerAwake(preventSleep);
    }
  }

  async getSetting(key: SettingKey): Promise<boolean> {
    const items = await this.storageManager.getItems();
    return items[key] === 'true';
  }
}
