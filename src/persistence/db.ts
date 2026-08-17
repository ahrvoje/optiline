/**
 * IndexedDB persistence (§20.4).
 *
 * Database `optiline` version 1 with the four object stores from the
 * shared contract. All keys are out-of-line and exactly as specified:
 *
 *   tracks         : track fingerprint            (imported compiled tracks)
 *   profiles       : profile UUID                 (certified saved profiles)
 *   runCheckpoints : track+settings fingerprint   (resumable chain snapshot)
 *   preferences    : string                       (UI and playback preferences)
 *
 * SAVE is one transaction over [profiles, tracks]: it writes the
 * profile and updates the imported-track metadata record (when the
 * track lives in the DB). A failed transaction aborts atomically and
 * leaves no partial profile.
 */
import {
  DB_NAME,
  DB_VERSION,
  STORE_CHECKPOINTS,
  STORE_PREFERENCES,
  STORE_PROFILES,
  STORE_TRACKS,
} from "@/model/contracts";
import type { CompiledTrackJson, SavedProfileJson } from "@/model/contracts";

export interface ImportedTrackRecord {
  fingerprint: string;
  asset: CompiledTrackJson;
  importedAt: string; // ISO-8601 UTC
  savedProfileCount: number;
}

export interface CheckpointRecord {
  checkpoint: ArrayBuffer;
  runVersion: number;
  savedAt: string; // ISO-8601 UTC
}

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_TRACKS)) db.createObjectStore(STORE_TRACKS);
      if (!db.objectStoreNames.contains(STORE_PROFILES)) db.createObjectStore(STORE_PROFILES);
      if (!db.objectStoreNames.contains(STORE_CHECKPOINTS)) {
        db.createObjectStore(STORE_CHECKPOINTS);
      }
      if (!db.objectStoreNames.contains(STORE_PREFERENCES)) {
        db.createObjectStore(STORE_PREFERENCES);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
  });
  return dbPromise;
}

function requestToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
  });
}

/* ---------------------------------- profiles ---------------------------------- */

export async function getAllProfiles(): Promise<SavedProfileJson[]> {
  const db = await openDb();
  const tx = db.transaction(STORE_PROFILES, "readonly");
  return requestToPromise(tx.objectStore(STORE_PROFILES).getAll() as IDBRequest<SavedProfileJson[]>);
}

export async function getProfilesForTrack(trackFingerprint: string): Promise<SavedProfileJson[]> {
  const all = await getAllProfiles();
  return all.filter((p) => p.trackFingerprint === trackFingerprint);
}

/**
 * The SAVE transaction (§20.4): writes the profile and updates track
 * metadata in one atomic transaction.
 */
export async function saveProfileTransaction(profile: SavedProfileJson): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([STORE_PROFILES, STORE_TRACKS], "readwrite");
  tx.objectStore(STORE_PROFILES).put(profile, profile.profileId);
  const trackStore = tx.objectStore(STORE_TRACKS);
  const getReq = trackStore.get(profile.trackFingerprint) as IDBRequest<
    ImportedTrackRecord | undefined
  >;
  getReq.onsuccess = () => {
    const record = getReq.result;
    if (record) {
      record.savedProfileCount += 1;
      trackStore.put(record, profile.trackFingerprint);
    }
    // Built-in tracks are static assets and carry no DB record; their
    // saved-profile count is derived from the profiles store.
  };
  await transactionDone(tx);
}

export async function deleteProfile(profileId: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_PROFILES, "readwrite");
  tx.objectStore(STORE_PROFILES).delete(profileId);
  await transactionDone(tx);
}

export async function renameProfile(profileId: string, name: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_PROFILES, "readwrite");
  const store = tx.objectStore(STORE_PROFILES);
  const req = store.get(profileId) as IDBRequest<SavedProfileJson | undefined>;
  req.onsuccess = () => {
    const record = req.result;
    if (record) {
      record.name = name;
      store.put(record, profileId);
    }
  };
  await transactionDone(tx);
}

export async function putProfile(profile: SavedProfileJson): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_PROFILES, "readwrite");
  tx.objectStore(STORE_PROFILES).put(profile, profile.profileId);
  await transactionDone(tx);
}

/* ----------------------------------- tracks ----------------------------------- */

export async function getAllImportedTracks(): Promise<ImportedTrackRecord[]> {
  const db = await openDb();
  const tx = db.transaction(STORE_TRACKS, "readonly");
  return requestToPromise(
    tx.objectStore(STORE_TRACKS).getAll() as IDBRequest<ImportedTrackRecord[]>,
  );
}

export async function putImportedTrack(record: ImportedTrackRecord): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_TRACKS, "readwrite");
  tx.objectStore(STORE_TRACKS).put(record, record.fingerprint);
  await transactionDone(tx);
}

/** Replace an unsaved custom-track revision whose fingerprint changed. */
export async function replaceImportedTrack(
  previousFingerprint: string,
  record: ImportedTrackRecord,
): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_TRACKS, "readwrite");
  const store = tx.objectStore(STORE_TRACKS);
  if (previousFingerprint !== record.fingerprint) store.delete(previousFingerprint);
  store.put(record, record.fingerprint);
  await transactionDone(tx);
}

/** Explicit custom-track deletion also removes profiles that reference it. */
export async function deleteImportedTrack(fingerprint: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([STORE_TRACKS, STORE_PROFILES], "readwrite");
  tx.objectStore(STORE_TRACKS).delete(fingerprint);
  const request = tx.objectStore(STORE_PROFILES).openCursor();
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    const profile = cursor.value as SavedProfileJson;
    if (profile.trackFingerprint === fingerprint) cursor.delete();
    cursor.continue();
  };
  await transactionDone(tx);
}

/* --------------------------------- checkpoints -------------------------------- */

/** Store key is the concatenated track+settings fingerprint (§20.4). */
export function checkpointKey(trackFingerprint: string, settingsFingerprint: string): string {
  return `${trackFingerprint}:${settingsFingerprint}`;
}

export async function getCheckpoint(key: string): Promise<CheckpointRecord | undefined> {
  const db = await openDb();
  const tx = db.transaction(STORE_CHECKPOINTS, "readonly");
  return requestToPromise(
    tx.objectStore(STORE_CHECKPOINTS).get(key) as IDBRequest<CheckpointRecord | undefined>,
  );
}

export async function putCheckpoint(key: string, record: CheckpointRecord): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_CHECKPOINTS, "readwrite");
  tx.objectStore(STORE_CHECKPOINTS).put(record, key);
  await transactionDone(tx);
}

export async function deleteCheckpoint(key: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_CHECKPOINTS, "readwrite");
  tx.objectStore(STORE_CHECKPOINTS).delete(key);
  await transactionDone(tx);
}

/* --------------------------------- preferences -------------------------------- */

export async function getPreference<T>(key: string): Promise<T | undefined> {
  const db = await openDb();
  const tx = db.transaction(STORE_PREFERENCES, "readonly");
  return requestToPromise(tx.objectStore(STORE_PREFERENCES).get(key) as IDBRequest<T | undefined>);
}

export async function setPreference<T>(key: string, value: T): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_PREFERENCES, "readwrite");
  tx.objectStore(STORE_PREFERENCES).put(value, key);
  await transactionDone(tx);
}
