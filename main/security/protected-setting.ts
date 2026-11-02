import * as fs from 'fs';
import * as path from 'path';
import { getSettingValue, upsertSettings } from '../db';

/**
 * Secrets that live in settings until OS-backed storage can hold them, the way the JWT secret
 * does: the row then carries only this marker, so a copied database or backup holds no key.
 */
export const PROTECTED_SETTING_MARKER = 'safe-storage:v1';

interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

/** Electron's safeStorage in a packaged app with OS encryption, else null (tests, development). */
function secureStore(key: string): { storage: SafeStorageLike; filePath: string } | null {
  try {
    const { app, safeStorage } = require('electron') as {
      app?: { isPackaged?: boolean; getPath(name: string): string };
      safeStorage?: SafeStorageLike;
    };
    if (!app?.isPackaged || !safeStorage || !safeStorage.isEncryptionAvailable()) return null;
    return { storage: safeStorage, filePath: path.join(app.getPath('userData'), `${key}.enc`) };
  } catch {
    return null;
  }
}

function readFile(store: { storage: SafeStorageLike; filePath: string }): string {
  try {
    return store.storage.decryptString(fs.readFileSync(store.filePath)) || '';
  } catch {
    return '';
  }
}

function writeFile(store: { storage: SafeStorageLike; filePath: string }, value: string): boolean {
  try {
    fs.writeFileSync(store.filePath, store.storage.encryptString(value), { mode: 0o600 });
    return readFile(store) === value;
  } catch {
    return false;
  }
}

/**
 * The secret, or '' when none is set or the OS store no longer yields it (a backup restored on
 * another machine): callers then issue a new secret or ask to pair again. A plaintext value left
 * by an older version moves into the OS store on first read.
 */
export function readProtectedSetting(key: string): string {
  const value = getSettingValue(key) ?? '';
  const store = secureStore(key);
  if (value === PROTECTED_SETTING_MARKER) return store ? readFile(store) : '';
  if (value && store && writeFile(store, value)) {
    upsertSettings({ [key]: PROTECTED_SETTING_MARKER });
  }
  return value;
}

/** Stores the secret in the OS store when there is one; '' clears it everywhere. */
export function writeProtectedSetting(key: string, value: string): void {
  const store = secureStore(key);
  if (!value) {
    if (store) fs.rmSync(store.filePath, { force: true });
    upsertSettings({ [key]: '' });
    return;
  }
  if (store && writeFile(store, value)) {
    upsertSettings({ [key]: PROTECTED_SETTING_MARKER });
    return;
  }
  upsertSettings({ [key]: value });
}
