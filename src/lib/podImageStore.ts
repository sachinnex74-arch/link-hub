// ──────────────────────────────────────────────────────────────────────────
// podImageStore — durable local storage for POD photos captured offline.
//
// localStorage cannot hold image blobs (they overflow quota; the app already
// strips dataUrls for this reason). This module keeps the actual photo bytes in
// IndexedDB until they are confirmed uploaded to cloud storage. An un-uploaded
// image is NEVER evicted — a POD photo is irreplaceable proof of delivery.
//
// Scope: storage only. The upload queue + ordering with the consignee mark live
// in supaSync (enqueuePodImage / flushPodImages). This file has no app logic.
// ──────────────────────────────────────────────────────────────────────────

const DB_NAME = "tms_pod_images";
const STORE = "pod_images";
const DB_VERSION = 1;

export type PodImageRecord = {
  podLocalId: string;       // stable local id (also the link key on the consignee op)
  loadId: string;
  ci: number;               // consignee index
  cid: string | null;       // stable consignee id (new loads) or null (old)
  blob: Blob;               // the actual photo bytes (stored full-size, no compression)
  name: string;
  type: string;
  size: number;
  capturedAt: string;       // ISO
  attempts: number;         // upload attempts so far
  lastError?: string;
};

// Feature-detect: callers fall back to today's fail-closed behavior if false.
export function isPodImageStoreAvailable(): boolean {
  try {
    return typeof indexedDB !== "undefined" && indexedDB !== null;
  } catch {
    return false;
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (e) {
      reject(e);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "podLocalId" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("indexedDB open failed"));
    req.onblocked = () => reject(new Error("indexedDB blocked"));
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const store = t.objectStore(STORE);
        let req: IDBRequest<T>;
        try {
          req = fn(store);
        } catch (e) {
          db.close();
          reject(e);
          return;
        }
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error("indexedDB request failed"));
        t.oncomplete = () => db.close();
        t.onabort = () => { db.close(); reject(t.error || new Error("indexedDB tx aborted")); };
      }),
  );
}

// Store a captured image. Overwrites by podLocalId (idempotent re-capture).
export async function putPodImage(rec: PodImageRecord): Promise<void> {
  await tx<IDBValidKey>("readwrite", (store) => store.put(rec));
}

export async function getPodImage(podLocalId: string): Promise<PodImageRecord | null> {
  try {
    const rec = await tx<PodImageRecord>("readonly", (store) => store.get(podLocalId));
    return rec || null;
  } catch {
    return null;
  }
}

// Delete a stored image — ONLY call after the upload is confirmed in cloud storage.
export async function deletePodImage(podLocalId: string): Promise<void> {
  await tx<undefined>("readwrite", (store) => store.delete(podLocalId) as IDBRequest<undefined>);
}

export async function listPodImageIds(): Promise<string[]> {
  try {
    const keys = await tx<IDBValidKey[]>("readonly", (store) => store.getAllKeys());
    return (keys || []).map((k) => String(k));
  } catch {
    return [];
  }
}

export async function countPodImages(): Promise<number> {
  try {
    return await tx<number>("readonly", (store) => store.count());
  } catch {
    return 0;
  }
}
