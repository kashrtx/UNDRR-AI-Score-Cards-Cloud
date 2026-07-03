/**
 * Browser-only encrypted key storage.
 *
 * API keys never touch the server or the repo. We generate a NON-EXTRACTABLE
 * AES-GCM key once per browser and keep it in IndexedDB (it cannot be read back
 * out as raw bytes — only used to encrypt/decrypt). Each secret is encrypted
 * with a fresh random IV and the ciphertext is stored in localStorage.
 *
 * Threat model: this protects keys from casual inspection of localStorage and
 * from being synced/exported as plaintext. It is device-local by design — keys
 * must be re-entered on a new browser or device. That is the correct trade-off
 * for "never stored on a server".
 */

const DB_NAME = "undrr-scorecard-secure";
const STORE = "keys";
const DEVICE_KEY_ID = "device-aes-gcm-key";
const LS_PREFIX = "undrr.secret.";

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key: string, value: unknown): Promise<void> {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getDeviceKey(): Promise<CryptoKey> {
  const existing = await idbGet<CryptoKey>(DEVICE_KEY_ID);
  if (existing) return existing;
  const key = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false, // non-extractable
    ["encrypt", "decrypt"]
  );
  await idbSet(DEVICE_KEY_ID, key);
  return key;
}

function toB64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function fromB64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Encrypt a secret and persist the ciphertext in localStorage under `name`. */
export async function setSecret(name: string, plaintext: string): Promise<void> {
  const key = await getDeviceKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder().encode(plaintext);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      enc as BufferSource
    )
  );
  const payload = JSON.stringify({ iv: toB64(iv), ct: toB64(ct) });
  localStorage.setItem(LS_PREFIX + name, payload);
}

/** Decrypt a secret in memory. Returns null if not set or undecryptable. */
export async function getSecret(name: string): Promise<string | null> {
  const raw = localStorage.getItem(LS_PREFIX + name);
  if (!raw) return null;
  try {
    const { iv, ct } = JSON.parse(raw) as { iv: string; ct: string };
    const key = await getDeviceKey();
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromB64(iv) as BufferSource },
      key,
      fromB64(ct) as BufferSource
    );
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}

export function hasSecret(name: string): boolean {
  if (typeof localStorage === "undefined") return false;
  return localStorage.getItem(LS_PREFIX + name) != null;
}

export function clearSecret(name: string): void {
  localStorage.removeItem(LS_PREFIX + name);
}

export function clearAllSecrets(): void {
  const toRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(LS_PREFIX)) toRemove.push(k);
  }
  toRemove.forEach((k) => localStorage.removeItem(k));
}
