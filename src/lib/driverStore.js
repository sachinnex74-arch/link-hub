// localStorage-backed sync layer between TMS and Drivers app.
// Now also dual-writes to Supabase via src/lib/supaSync.ts (fire-and-forget).

import {
  pushPin,
  pushPOD,
  pushPODUpdate,
  pushPODDelete,
  pushSOS,
  pushDelivered,
  markConsigneeRpc,
  enqueueConsigneeOp,
  enqueuePodImageOp,
  enqueueDeliverOp,
  getSettingHydrated,
  pushPodOnLoad,
  uploadAttachment as supaUploadAttachment,
  removeAttachmentRemote,
} from "./supaSync";
import { isPodImageStoreAvailable, putPodImage } from "@/lib/podImageStore";

const K = {
  vehicles: "lov_tms_vehicles",
  loads: "lov_tms_loads",
  pin: (vnum) => `lov_veh_pin_${normalizeVnum(vnum)}`,
  attach: (lid) => `lov_load_attach_${lid}`,
  pods: "lov_pod_records",
  sos: "lov_sos_records",
};

export function normalizeVnum(value) {
  return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

const safe = {
  get(k, fb = null) {
    try { if (typeof localStorage === "undefined") return fb;
      const v = localStorage.getItem(k); return v == null ? fb : JSON.parse(v); }
    catch { return fb; }
  },
  set(k, v) { try { if (typeof localStorage !== "undefined") localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { if (typeof localStorage !== "undefined") localStorage.removeItem(k); } catch {} },
};

export function syncVehicles(vehicles) {
  safe.set(K.vehicles, vehicles || []);
}
export function syncLoads(loads) {
  safe.set(K.loads, loads || []);
}


// Driver-side: mark a load delivered (updates the synced loads array so TMS picks it up)
export function markLoadDelivered(loadId, opts) {
  if (!loadId) return;
  const list = safe.get(K.loads, []) || [];
  const updated = list.map(l => l.id === loadId
    ? { ...l, lstatus: "DELIVERED", vehicleId: null, deliveredAt: l.deliveredAt || new Date().toISOString() }
    : l);
  safe.set(K.loads, updated);
  // Offline POD image mode: defer the server delivery into a durable queue, gated on the photo
  // upload so the load never reaches the server as DELIVERED before its POD image is in storage.
  if (opts && opts.awaitingImage) {
    enqueueDeliverOp({ loadId, awaitingImage: opts.awaitingImage });
    return;
  }
  pushDelivered(loadId);
}

// Driver-side: mark ONE consignee (by index) of a multi-consignee load delivered.
// Optimistic local update for instant UI; authoritative write goes through the
// open server fn (driver has no Supabase session, so the locked load-upsert path
// can't be used). The load only flips to DELIVERED / frees the vehicle once every
// consignee is done. Returns { allDone, doneCount, total }.
export async function markConsigneeDelivered(loadId, ci, podPath, opts) {
  if (!loadId) return { allDone: false, doneCount: 0, total: 0 };
  const list = safe.get(K.loads, []) || [];
  // Source of truth = the POD records that actually exist for this load. A stop
  // counts as delivered only when its own POD has been uploaded, so finishing the
  // consignees never trips "all done" before the to-city POD is in.
  const pods = getPODs() || [];
  const covered = new Set();
  for (const p of pods) {
    if (String(p?.loadId) === String(loadId) && p?.consigneeIndex != null) covered.add(Number(p.consigneeIndex));
  }
  if (ci != null) covered.add(Number(ci)); // include the just-uploaded one
  let res = { allDone: false, doneCount: 0, total: 0 };
  const updated = list.map(l => {
    if (l.id !== loadId) return l;
    const existing = Array.isArray(l.consigneeDeliveries) ? l.consigneeDeliveries : [];
    const cities = [...(l.consignees || []), l.dest].filter(Boolean);
    const base = cities.map((c, idx) => {
      const ex = existing[idx] || {};
      const delivered = covered.has(idx) || !!ex.delivered;
      return {
        city: c,
        delivered,
        podPath: (idx === ci ? podPath : null) || ex.podPath || null,
        deliveredAt: ex.deliveredAt || (delivered ? new Date().toISOString() : null),
      };
    });
    const total = base.length;
    const doneCount = base.filter(x => x.delivered).length;
    const allDone = total > 0 && doneCount >= total;
    res = { allDone, doneCount, total };
    return allDone
      ? { ...l, consigneeDeliveries: base, lstatus: "DELIVERED", vehicleId: null, deliveredAt: l.deliveredAt || new Date().toISOString() }
      : { ...l, consigneeDeliveries: base };
  });
  safe.set(K.loads, updated);
  // Canonical lane (Phase 2c-4/2e, made unconditional in Phase 3): every driver consignee
  // mark goes through app_mark_consignee. The old pushConsigneeDelivered/markConsigneeDeliveredFn
  // path was retired in Phase 3 after proving it dormant. NOTE: this removes the driver-lane
  // flag-off rollback — delivery.driverUseEngine is no longer consulted here.
  // Resolve the stable consignee id for new (cid-based) loads; old loads have no
  // consigneeCids → cid null → server uses the index path (unchanged). The dest stop
  // (index === consignees length) maps to the reserved '__dest__' sentinel.
  const _lForCid = (list || []).find(x => x.id === loadId) || null;
  const _cids = _lForCid && Array.isArray(_lForCid.consigneeCids) ? _lForCid.consigneeCids : null;
  const cid = !_cids ? null : (ci < _cids.length ? _cids[ci] : "__dest__");
  // Offline POD image mode: the photo is being stored locally and uploaded later. We must NOT
  // call the RPC now (server requires a real podPath for driver_pod). Enqueue a GATED consignee
  // op that finalizes only after the image uploads (flushPodImages clears awaitingImage + sets
  // podPath). The optimistic local update above already shows the stop as delivered-pending.
  if (opts && opts.awaitingImage) {
    enqueueConsigneeOp({ loadId, ci, podPath: null, cid, awaitingImage: opts.awaitingImage });
    return res;
  }
  const r = await markConsigneeRpc(loadId, ci, "driver_pod", podPath || null, true, null, cid);
  // normalize RPC (snake_case) → the {allDone,doneCount,total} shape the driver UI expects.
  if (r && r.ok) return { ok: true, allDone: !!r.all_done, doneCount: r.done_count ?? res.doneCount, total: r.total ?? res.total };
  // offline/failed → durably queue for replay through app_mark_consignee (NOT app_write_load).
  // The POD image already uploaded before this point, so podPath is a valid storage ref.
  enqueueConsigneeOp({ loadId, ci, podPath: podPath || null, cid });
  return res;
}

export function getVehicles() { return safe.get(K.vehicles, []); }
export function getLoads() { return safe.get(K.loads, []); }

export function getPin(vnum) { return safe.get(K.pin(vnum), null); }
export async function setPin(vnum, pin) {
  const key = K.pin(vnum);
  const previous = safe.get(key, null);
  if (!pin) safe.del(key);
  else safe.set(key, String(pin));
  try {
    await pushPin(vnum, pin ? String(pin) : null);
  } catch (e) {
    if (previous == null) safe.del(key);
    else safe.set(key, previous);
    throw e;
  }
}

export function getAttachments(lid) { return safe.get(K.attach(lid), {}) || {}; }
export function setAttachment(lid, kind, file, rawFile) {
  const cur = getAttachments(lid);
  // Store only a lightweight reference — metadata + the Storage `path` — never
  // the base64 image bytes. Keeping dataUrls in localStorage overflows the
  // ~5MB quota; the image is fetched on demand via a signed URL from `path`.
  const { dataUrl, data_url, ...meta } = file || {};
  cur[kind] = meta;
  safe.set(K.attach(lid), cur);
  // If a real File was passed, also upload to Storage (background).
  if (rawFile instanceof File) {
    supaUploadAttachment(lid, kind, rawFile);
  }
}
export function removeAttachment(lid, kind) {
  const cur = getAttachments(lid);
  delete cur[kind];
  safe.set(K.attach(lid), cur);
  removeAttachmentRemote(lid, kind);
}

export function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve({ name: file.name, dataUrl: r.result, uploadedAt: new Date().toISOString(), size: file.size, type: file.type });
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

// ---- POD records (a separate searchable log) ----
export function getPODs() { return safe.get(K.pods, []) || []; }
export function addPOD(rec) {
  const list = getPODs();
  const id = rec.id || `pod_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
  // Keep only the Storage `path` reference locally — never the base64 image
  // bytes (they overflow localStorage). The photo is fetched on demand via a
  // signed URL. The cloud copy is already image-stripped on push.
  const { dataUrl, data_url, ...lean } = rec || {};
  const full = { id, status: "OK", ...lean };
  list.unshift(full);
  safe.set(K.pods, list);
  pushPOD(full);
  if (full.loadId) {
    pushPodOnLoad(full.loadId, {
      id: full.id,
      name: full.name,
      at: full.at,
      status: full.status,
      lid: full.lid,
      path: full.path || null,
    });
  }

}

export function updatePOD(id, patch) {
  const list = getPODs().map(p => p.id === id ? { ...p, ...patch } : p);
  safe.set(K.pods, list);
  pushPODUpdate(id, patch);
}

// Offline POD capture (flag pod.offlineQueue): store the photo blob in IndexedDB and queue it
// for deferred upload. The POD *record* is written later, when the image actually lands in
// storage (flushPodImages → pushPOD with the real path). Returns the generated podLocalId, or
// null if local image storage is unavailable (caller falls back to the inline upload path).
export async function addOfflinePOD(file, meta) {
  try {
    if (!isPodImageStoreAvailable()) return null;
    const isMain = meta.ci == null;                       // single/main POD vs per-consignee
    const kind = isMain ? "pod" : `pod_c${meta.ci}`;
    const podLocalId = `pol_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,8)}`;
    await putPodImage({
      podLocalId,
      loadId: String(meta.loadId),
      ci: isMain ? null : meta.ci,
      cid: meta.cid ?? null,
      blob: file,                       // full-size, no compression
      name: file.name || `${podLocalId}.jpg`,
      type: file.type || "image/jpeg",
      size: file.size || 0,
      capturedAt: new Date().toISOString(),
      attempts: 0,
    });
    // POD record payload to write on successful upload (image fields stripped; path added later).
    // Main POD → no consigneeIndex (LoadDetailsDialog reads it as the load's main POD).
    const podMeta = {
      vnum: meta.vnum, driver: meta.driver, mobile: meta.mobile,
      customer: meta.customer || "\u2014",
      loadId: String(meta.loadId), lid: meta.lid || null,
      origin: meta.origin || null, dest: meta.consigneeCity || meta.dest || null,
      name: file.name || `${podLocalId}.jpg`,
      at: new Date().toISOString(), status: "OK",
      ...(isMain
        ? {}
        : { consigneeCity: meta.consigneeCity || null, consigneeIndex: meta.ci, consigneeCid: meta.cid ?? null }),
    };
    enqueuePodImageOp({
      podLocalId, loadId: String(meta.loadId), ci: isMain ? null : meta.ci, kind,
      cid: meta.cid ?? null, consigneeCity: meta.consigneeCity || null, podMeta, attempts: 0,
    });
    return podLocalId;
  } catch (e) {
    console.warn("[driverStore] addOfflinePOD failed", e);
    return null;
  }
}

export function deletePOD(id) {
  safe.set(K.pods, getPODs().filter(p => p.id !== id));
  pushPODDelete(id);
}

// One-time reclaim: strip base64 image bytes left in localStorage by older
// builds (POD records + per-load attachment blobs). Safe to run on every boot —
// it only rewrites entries that still carry inline image data, freeing quota.
export function pruneLocalImages() {
  try {
    if (typeof localStorage === "undefined") return;
    // POD records
    const pods = getPODs();
    let podsChanged = false;
    const leanPods = pods.map(p => {
      if (p && (p.dataUrl || p.data_url)) {
        podsChanged = true;
        const { dataUrl, data_url, ...rest } = p;
        return rest;
      }
      return p;
    });
    if (podsChanged) safe.set(K.pods, leanPods);
    // Per-load attachment blobs (collect keys first; we only rewrite in place)
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("lov_load_attach_")) keys.push(k);
    }
    for (const key of keys) {
      const obj = safe.get(key, null);
      if (!obj || typeof obj !== "object") continue;
      let changed = false;
      const lean = {};
      for (const [kind, file] of Object.entries(obj)) {
        if (file && typeof file === "object" && (file.dataUrl || file.data_url)) {
          const { dataUrl, data_url, ...rest } = file;
          lean[kind] = rest;
          changed = true;
        } else {
          lean[kind] = file;
        }
      }
      if (changed) safe.set(key, lean);
    }
  } catch {}
}

// ---- SOS records ----
export function getSOS() { return safe.get(K.sos, []) || []; }
export function addSOS(rec) {
  const list = getSOS();
  const id = rec.id || `sos_${Date.now()}`;
  const full = { id, at: new Date().toISOString(), ...rec };
  list.unshift(full);
  safe.set(K.sos, list);
  pushSOS(full);
}
