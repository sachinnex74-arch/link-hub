// Browser-side sync layer.
//
// ARCHITECTURE (simplified from previous version):
//   - localStorage is a READ CACHE only. It is never the source of truth.
//   - Every write goes to Supabase FIRST (await), then the confirmed server
//     row is applied to the local cache. No clock comparisons, no LWW logic.
//   - Supabase Realtime broadcasts every write to all other connected devices
//     instantly. The local cache on each device is updated directly from the
//     realtime payload — no merge, no conflict, server row wins.
//   - A 15 s fallback poll runs delta pulls to catch any missed realtime
//     events (sleep, network gap, tab background).
//   - On boot we do one full pull to populate the cache, then realtime +
//     delta polls keep it fresh.
//
// What was removed vs the old version:
//   - lwwUpsert clock comparison (was silently dropping writes)
//   - mergeList null-skip bug (was blocking vehicle un-assignments from propagating)
//   - deltaCursor complexity
//   - quarantine / quarantineWarned sets
//   - syncVehiclesDiff / syncLoadsDiff diff scanners
//   - localStorage-first write pattern

import { getSupabase, ensureSupabase, getMissingPublicConfig } from "@/integrations/supabase/client";
import { isHalted } from "@/lib/haltState";
import { getPodImage, deletePodImage } from "@/lib/podImageStore";
import {
  pullAll,
  pullDeliveredPage,
  pullDelta,
  pullSettingsFn,
  setSettingFn,
  deleteSettingFn,
  // upsertVehicleFn, deleteVehicleFn, upsertLoadFn, deleteLoadFn
  // — replaced by directUpsert/directDelete (browser client, single hop)
  setPinFn,
  addPODFn,
  updatePODFn,
  deletePODFn,
  addSOSFn,
  markDeliveredFn,
  attachPodToLoadFn,
  getUploadUrlFn,
  setAttachmentMetaFn,
  removeAttachmentFn,
  getSignedReadUrlFn,
  upsertGeofenceAlertFn,
  deleteGeofenceAlertFn,
  diagnoseRealtimeFn,
} from "@/lib/tms.functions";

// ---------- Storage keys ----------
const K = {
  vehicles: "lov_tms_vehicles",
  loads: "lov_tms_loads",
  deletedLoads: "lov_tms_deleted_loads",
  deletedVehicles: "lov_tms_deleted_vehicles",
  pendingWrites: "lov_tms_pending_writes",
  pendingConsigneeOps: "lov_tms_pending_consignee_ops",
  pendingPodImages: "lov_tms_pending_pod_images",
  pendingDelivers: "lov_tms_pending_delivers",
  pin: (vnum: string) => `lov_veh_pin_${normalizeVnum(vnum)}`,
  attach: (lid: string) => `lov_load_attach_${lid}`,
  pods: "lov_pod_records",
  sos: "lov_sos_records",
  geofenceAlerts: "tms.geofenceAlerts",
};

function normalizeVnum(value: string) {
  return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// ---------- localStorage helpers ----------
function lsGet<T>(k: string, fb: T): T {
  try { const v = localStorage.getItem(k); return v == null ? fb : (JSON.parse(v) as T); } catch { return fb; }
}
function lsSet(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
function emit() {
  try { window.dispatchEvent(new Event("tms:sync")); } catch {}
}

// ---------- Own-write echo suppression ----------
// Records id→timestamp for rows this device just upserted so the delta poll
// doesn't re-apply our own echo back on top of a fresher local state.
const ownWrites = new Map<string, number>(); // key `${table}:${id}` → Date.now()
const warnedMissingLid = new Set<string>(); // dedupe missing-lid warnings

// ---------- Per-row write serialization ----------
// Prevents an older in-flight upsert from landing after a newer one (out-of-order
// cloud commits). Same-key writes chain; chain entry cleaned up after each settles.
const writeChains = new Map<string, Promise<void>>();

// ---------- Sync status ----------
let initialized = false;
let hydrated = false;
let initPromise: Promise<void> | null = null;
let fallbackPollTimer: ReturnType<typeof setInterval> | null = null;
let deltaCursor: string | null = null;

// ---------- Driver scope creds ----------
// Set by the driver app after a successful PIN verify. When non-null, forwarded
// to pullAll/pullDelta so the server filters reads to that vehicle.
let driverCreds: { vnum: string; pin: string } | null = null;
export function setDriverCreds(creds: { vnum: string; pin: string } | null) {
  driverCreds = creds;
}

type SyncTable = "vehicles" | "loads";
type PendingWrite = {
  op: "upsert" | "delete" | "engine";      // 'engine' = idempotent app_op replay (O2)
  table: SyncTable | "ops";                 // 'ops' for engine kind (dedupe key = op_id)
  id: string;
  payload?: any;                            // engine kind: { fn, args }
  extra?: Record<string, any>;
  qv?: number;                              // O5: queue schema version stamp
  queuedAt: string;
  attempts: number;
  lastError?: string;
};

type SyncStatus = {
  state: "starting" | "ready" | "saving" | "synced" | "error" | "offline";
  message: string;
  at: string | null;
};
let syncStatus: SyncStatus = { state: "starting", message: "Connecting to cloud", at: null };
const statusListeners = new Set<(status: SyncStatus) => void>();

function sanitizeCloudMessage(message: unknown) {
  const raw = String(message ?? "")
    .replace(/\\u003c/gi, "<")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
  if (/<!doctype html|<html|cf-error|error code\s*522|522:\s*connection timed out|connection timed out|cloudflare/i.test(raw)) {
    return "Cloud connection timed out. Your local change is kept and will retry.";
  }
  return raw.length > 240 ? `${raw.slice(0, 240)}…` : raw;
}

function formatError(error: unknown) {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : (() => {
    try { return JSON.stringify(error); } catch { return "Unknown cloud sync error"; }
  })();
  return sanitizeCloudMessage(raw);
}

let statusEventTimer: ReturnType<typeof setTimeout> | null = null;
function setSyncStatus(state: SyncStatus["state"], message: string) {
  const sanitized = sanitizeCloudMessage(message);
  if (syncStatus.state === state && syncStatus.message === sanitized) return;
  syncStatus = { state, message: sanitized, at: new Date().toISOString() };
  for (const listener of statusListeners) listener(syncStatus);
  if (statusEventTimer) return;
  statusEventTimer = setTimeout(() => {
    statusEventTimer = null;
    try { window.dispatchEvent(new CustomEvent("tms:sync-status", { detail: syncStatus })); } catch {}
  }, 200);
}

export function getSyncStatus() { return syncStatus; }
export function subscribeSyncStatus(listener: (status: SyncStatus) => void) {
  statusListeners.add(listener);
  listener(syncStatus);
  return () => statusListeners.delete(listener);
}
export function isSyncHydrated() { return hydrated; }

// ---------- Deleted load tracking ----------
function deletedLoadIds() {
  return new Set((lsGet<string[]>(K.deletedLoads, []) || []).map(String));
}
function rememberDeletedLoad(id: string) {
  if (!id) return;
  const ids = Array.from(new Set([id, ...(lsGet<string[]>(K.deletedLoads, []) || []).map(String)]));
  lsSet(K.deletedLoads, ids.slice(0, 500));
}
function forgetDeletedLoads(ids: Iterable<string>) {
  const incoming = new Set(Array.from(ids, String));
  if (!incoming.size) return;
  const kept = (lsGet<string[]>(K.deletedLoads, []) || []).filter((id) => !incoming.has(String(id)));
  lsSet(K.deletedLoads, kept);
}

// ---------- Deleted vehicle tracking (parity with loads) ----------
function deletedVehicleIds() {
  return new Set((lsGet<string[]>(K.deletedVehicles, []) || []).map(String));
}
function rememberDeletedVehicle(id: string) {
  if (!id) return;
  const ids = Array.from(new Set([id, ...(lsGet<string[]>(K.deletedVehicles, []) || []).map(String)]));
  lsSet(K.deletedVehicles, ids.slice(0, 200));
}

// ---------- Pending write queue ----------
// Keeps cross-device sync from becoming "local-only" when a cloud write fails.
// The UI may already be updated optimistically; this queue makes the cloud write
// durable and retries it after auth/network/realtime recovery.
function pendingWrites(): PendingWrite[] {
  return lsGet<PendingWrite[]>(K.pendingWrites, []) || [];
}
function savePendingWrites(writes: PendingWrite[]) {
  lsSet(K.pendingWrites, writes.slice(-500));
}
// ── O4: dead-letter store — exhausted queue items land HERE, visibly, instead
// of vanishing. One store for all queues. Inspect via listDeadLetter() in the
// console; clear via clearDeadLetter(). Capped at 200 newest.
// ── O5: QUEUE_SCHEMA_VERSION — every queued item is stamped `qv`. Items from a
// FUTURE schema (downgrade scenario) are dead-lettered rather than misparsed;
// legacy unstamped items are treated as v1.
const QUEUE_SCHEMA_VERSION = 1;
function deadLetters(): any[] { return lsGet<any[]>("lov_tms_dead_letter", []) || []; }
function saveDeadLetters(items: any[]) { lsSet("lov_tms_dead_letter", items.slice(-200)); }
function toDeadLetter(kind: string, item: any, why: string) {
  saveDeadLetters([...deadLetters(), { kind, item, why, at: new Date().toISOString() }]);
  try { console.warn(`[dead-letter] ${kind}: ${why}`, item); } catch {}
}
export function deadLetterCount(): number { return deadLetters().length; }
export function listDeadLetter(): any[] { return deadLetters(); }
export function clearDeadLetter() { saveDeadLetters([]); }

// ── D-3a: client-side stops store (rows are the truth; this is their feed) ──
// In-memory map loadId -> ordered stop rows, hydrated by pullAll and kept live
// by the load_stops realtime binding. NO UI reads it yet (D-3b migrates
// surfaces one by one) — exposing the accessor now makes those migrations
// mechanical. Not persisted: rebuilt on every hydrate (cheap, always fresh).
const stopsByLoad = new Map<string, any[]>();
// (F4 polish, final form) Client-side signal SENDING is retired: the announce
// now lives INSIDE app_delete_load (realtime.send on the private 'tms-signals'
// channel — 0018). The client only RECEIVES, via the dedicated private channel
// set up in initSync. Receive-only by policy: clients cannot spoof signals.
export function getLoadStops(loadId: string): any[] { return stopsByLoad.get(String(loadId)) || []; }
function setStopsFromRows(rows: any[]) {
  stopsByLoad.clear();
  for (const r of rows || []) {
    const k = String(r.load_id);
    if (!stopsByLoad.has(k)) stopsByLoad.set(k, []);
    stopsByLoad.get(k)!.push(r);
  }
  for (const arr of stopsByLoad.values()) arr.sort((a, b) => (a.idx ?? 0) - (b.idx ?? 0));
}
function applyStopsRealtime(evt: string, row: any) {
  if (!row?.load_id) return;
  const k = String(row.load_id);
  const arr = (stopsByLoad.get(k) || []).filter((s) => s.idx !== row.idx);
  if (evt !== "DELETE") arr.push(row);
  arr.sort((a, b) => (a.idx ?? 0) - (b.idx ?? 0));
  if (arr.length) stopsByLoad.set(k, arr); else stopsByLoad.delete(k);
  emit();
}

function enqueuePendingWrite(write: Omit<PendingWrite, "queuedAt" | "attempts">, error: unknown) {
  const id = String(write.id || "");
  if (!id) return;
  const existing = pendingWrites().filter((w) => !(w.table === write.table && w.id === id));
  const queued: PendingWrite = {
    ...write,
    id,
    qv: QUEUE_SCHEMA_VERSION,
    queuedAt: new Date().toISOString(),
    attempts: 0,
    lastError: formatError(error),
  } as PendingWrite;
  savePendingWrites([...existing, queued]);
  setSyncStatus("saving", `Cloud save queued. Retrying ${existing.length + 1} pending change${existing.length ? "s" : ""}.`);
}
function removePendingWrite(done: PendingWrite) {
  savePendingWrites(pendingWrites().filter((w) => !(w.table === done.table && w.id === done.id && w.op === done.op)));
}
async function flushPendingWrites() {
  const queued = pendingWrites();
  if (!queued.length) return;
  if (!(await hasAuthSession())) {
    setSyncStatus("offline", `${queued.length} cloud change${queued.length === 1 ? "" : "s"} waiting for sign-in`);
    return;
  }
  setSyncStatus("saving", `Retrying ${queued.length} pending cloud change${queued.length === 1 ? "" : "s"}`);
  for (const write of queued) {
    // O5: an item stamped by a NEWER app version than this one — don't guess at
    // its shape; park it visibly and move on.
    if ((write as any).qv != null && (write as any).qv > QUEUE_SCHEMA_VERSION) {
      removePendingWrite(write);
      toDeadLetter("pending_write", write, `queue schema v${(write as any).qv} > supported v${QUEUE_SCHEMA_VERSION}`);
      continue;
    }
    try {
      if (write.op === "engine") {
        // O2: replay an idempotent engine op through app_op. The ledger makes
        // this ALWAYS safe: if the original call actually committed before the
        // network died, the replay returns the stored result (replayed:true)
        // instead of re-applying. Any jsonb response — success, refusal, or
        // replay — means the op is settled; only transport errors keep retrying.
        const sb = await ensureSupabase();
        if (!sb) throw new Error("Supabase client not available");
        const { data, error } = await sb.rpc("app_op", {
          p_op_id: write.id, p_fn: write.payload?.fn, p_args: write.payload?.args || {},
        });
        if (error) throw new Error(error.message);
        const res: any = data || {};
        if (res.ok === false && res.reason === "op_in_flight") throw new Error("op_in_flight");
        console.info("[op replay]", write.payload?.fn, write.id, res.replayed ? "(replayed)" : "", res.ok === false ? `refused:${res.reason}` : "ok");
      } else if (write.op === "upsert") {
        await directUpsert(write.table, write.id, write.payload, write.extra);
      } else if (write.table === "loads") {
        const sb = await ensureSupabase();
        if (!sb) throw new Error("Supabase client not available");
        const { error } = await sb.rpc("app_delete_load", { p_id: write.id });
        if (error) throw new Error(error.message);
      } else {
        await directDelete(write.table, write.id);
      }
      removePendingWrite(write);
    } catch (e) {
      if ((write.attempts || 0) >= 10) {
        removePendingWrite(write);
        toDeadLetter("pending_write", write, `exhausted after 10 attempts: ${formatError(e)}`);
        setSyncStatus("error", `A pending cloud change was parked after too many retries (dead-letter: ${deadLetterCount()})`);
        return;
      }
      const next = pendingWrites().map((w) => (
        w.table === write.table && w.id === write.id && w.op === write.op
          ? { ...w, attempts: (w.attempts || 0) + 1, lastError: formatError(e) }
          : w
      ));
      savePendingWrites(next);
      setSyncStatus("error", `Pending cloud save failed: ${formatError(e)}`);
      return;
    }
  }
  setSyncStatus("synced", "Pending cloud changes saved");
}

// ---------- Consignee op queue (Phase 2e) ----------
// Durable replay for driver consignee/POD marks. When delivery.driverUseEngine is ON
// and markConsigneeRpc can't reach the server, the op is queued here and replayed
// through app_mark_consignee on reconnect — NEVER through app_write_load. The POD
// IMAGE is uploaded BEFORE the mark is ever attempted (driver.tsx throws otherwise),
// so any queued op already carries a valid uploaded podPath. This covers the transient
// "photo uploaded, mark RPC dropped" case; it does NOT by itself enable full dead-zone
// delivery (that needs durable image-upload queuing — out of scope for 2e).
type ConsigneeOp = {
  loadId: string;
  ci: number;
  source: "driver_pod";
  podPath: string | null;
  podOk: boolean | null;
  cid?: string | null;
  awaitingImage?: string | null;  // podLocalId this mark waits on; finalize only after image uploads
  queuedAt: string;
  attempts: number;
  lastError?: string;
};
function pendingConsigneeOps(): ConsigneeOp[] {
  return lsGet<ConsigneeOp[]>(K.pendingConsigneeOps, []) || [];
}
function savePendingConsigneeOps(ops: ConsigneeOp[]) {
  lsSet(K.pendingConsigneeOps, ops.slice(-500));
}
export function enqueueConsigneeOp(op: { loadId: string; ci: number; podPath?: string | null; podOk?: boolean | null; cid?: string | null; awaitingImage?: string | null }) {
  const loadId = String(op.loadId || "");
  if (!loadId || op.ci == null) return;
  // dedup: collapse any existing op for the same (loadId, ci) to the newest.
  const existing = pendingConsigneeOps().filter((o) => !(o.loadId === loadId && o.ci === op.ci));
  const queued: ConsigneeOp = {
    loadId, ci: op.ci, source: "driver_pod",
    podPath: op.podPath ?? null, podOk: op.podOk ?? null, cid: op.cid ?? null,
    awaitingImage: op.awaitingImage ?? null,
    queuedAt: new Date().toISOString(), attempts: 0,
  };
  savePendingConsigneeOps([...existing, queued]);
  setSyncStatus("saving", `Delivery update queued. Retrying ${existing.length + 1} pending mark${existing.length ? "s" : ""}.`);
}
function removeConsigneeOp(done: ConsigneeOp) {
  savePendingConsigneeOps(pendingConsigneeOps().filter((o) => !(o.loadId === done.loadId && o.ci === done.ci)));
}
// FIFO replay through the canonical consignee RPC. Idempotent (app_mark_consignee is
// POD-record-authoritative), so duplicate/out-of-order replays converge.
async function flushConsigneeOps() {
  const queued = pendingConsigneeOps();
  if (!queued.length) return;
  if (!(await hasAuthSession())) return; // wait for sign-in; loads queue surfaces the status banner
  for (const op of queued) {
    // Ordering gate: an op tagged awaitingImage must NOT finalize until its POD image has
    // uploaded (flushPodImages clears awaitingImage + sets podPath). Skip it for now; the
    // image flush will clear the gate, and the next consignee flush will finalize it.
    if (op.awaitingImage) continue;
    try {
      const r = await markConsigneeRpc(op.loadId, op.ci, "driver_pod", op.podPath, true, op.podOk, (op as any).cid ?? null);
      if (r && r.ok) { removeConsigneeOp(op); }
      else { throw new Error((r && (r as any).reason) || "rpc_refused"); }
    } catch (e) {
      if ((op.attempts || 0) >= 10) {
        removeConsigneeOp(op);
        toDeadLetter("consignee_op", op, "exhausted after 10 attempts");
        setSyncStatus("error", `A pending delivery mark was parked after too many retries (dead-letter: ${deadLetterCount()})`);
        return;
      }
      const next = pendingConsigneeOps().map((o) =>
        (o.loadId === op.loadId && o.ci === op.ci)
          ? { ...o, attempts: (o.attempts || 0) + 1, lastError: formatError(e) }
          : o
      );
      savePendingConsigneeOps(next);
      return; // stop on first failure; whole queue retries on the next trigger
    }
  }
}

// ---------- POD image stripping ----------
const INLINE_POD_IMAGE_KEYS = ["dataUrl", "data_url", "photoUrl", "photo_url", "imageUrl", "image_url", "photo", "image"];
function stripInlinePODImageFields(row: any) {
  const cleaned: any = { ...(row || {}) };
  for (const key of INLINE_POD_IMAGE_KEYS) delete cleaned[key];
  return cleaned;
}

// ---------- offline single-load delivery queue (durable; replays markDeliveredFn) ----------
// Single/main-POD loads finalize via markDeliveredFn (fire-and-forget, no built-in replay). To
// make a single-load delivery survive a dead zone, we queue it here and replay on reconnect.
// When linked to an offline POD photo it is GATED (awaitingImage) so the load never reaches the
// server as DELIVERED before its photo is in storage — same guarantee as the consignee path.
type DeliverOp = {
  loadId: string;
  finalizeConsignees?: boolean;
  awaitingImage?: string | null;
  queuedAt: string;
  attempts: number;
  lastError?: string;
};
function pendingDelivers(): DeliverOp[] {
  return lsGet<DeliverOp[]>(K.pendingDelivers, []) || [];
}
function savePendingDelivers(ops: DeliverOp[]) {
  lsSet(K.pendingDelivers, ops.slice(-500));
}
export function enqueueDeliverOp(op: { loadId: string; finalizeConsignees?: boolean; awaitingImage?: string | null }) {
  const loadId = String(op.loadId || "");
  if (!loadId) return;
  const existing = pendingDelivers().filter((o) => o.loadId !== loadId);
  savePendingDelivers([...existing, {
    loadId, finalizeConsignees: op.finalizeConsignees,
    awaitingImage: op.awaitingImage ?? null,
    queuedAt: new Date().toISOString(), attempts: 0,
  }]);
  setSyncStatus("saving", `Delivery queued (${existing.length + 1} pending).`);
}
function removeDeliverOp(loadId: string) {
  savePendingDelivers(pendingDelivers().filter((o) => o.loadId !== loadId));
}
async function flushDelivers() {
  const queued = pendingDelivers();
  if (!queued.length) return;
  if (!(await hasAuthSession())) return;
  for (const op of queued) {
    if (op.awaitingImage) continue; // gated: wait until the linked POD image has uploaded
    try {
      const r = await markDeliveredFn({ data: { loadId: op.loadId, finalizeConsignees: op.finalizeConsignees } });
      if (r && (r as any).ok !== false) { removeDeliverOp(op.loadId); }
      else { throw new Error("deliver_refused"); }
    } catch (e) {
      const next = pendingDelivers().map((o) =>
        o.loadId === op.loadId ? { ...o, attempts: (o.attempts || 0) + 1, lastError: formatError(e) } : o
      );
      savePendingDelivers(next);
      return; // stop on first failure; retries on next trigger
    }
  }
}

// ---------- offline POD image queue (durable; blob lives in IndexedDB) ----------
// Metadata-only queue (the blob itself is in podImageStore/IndexedDB, keyed by podLocalId).
// On flush: read blob → upload to storage → write the POD record with the real path →
// clear the linked consignee op's awaitingImage gate + stamp its podPath → delete the local
// blob. Only then can flushConsigneeOps finalize the delivery mark. An un-uploaded image is
// NEVER dropped (irreplaceable proof); failures retry indefinitely and surface to the driver.
type PodImageOp = {
  podLocalId: string;
  loadId: string;
  ci: number | null;       // consignee index, or null for a single/main POD
  kind: string;            // storage kind: "pod" (main) or "pod_cN" (consignee)
  cid: string | null;
  consigneeCity: string | null;
  podMeta: any;            // the addPOD payload minus the image (written on successful upload)
  attempts: number;
  lastError?: string;
};
function pendingPodImages(): PodImageOp[] {
  return lsGet<PodImageOp[]>(K.pendingPodImages, []) || [];
}
function savePendingPodImages(ops: PodImageOp[]) {
  lsSet(K.pendingPodImages, ops.slice(-500));
}
export function pendingPodImageCount(): number {
  return pendingPodImages().length;
}
export function enqueuePodImageOp(op: PodImageOp) {
  if (!op?.podLocalId) return;
  const existing = pendingPodImages().filter((o) => o.podLocalId !== op.podLocalId);
  savePendingPodImages([...existing, { ...op, attempts: 0 }]);
  setSyncStatus("saving", `POD photo queued (${existing.length + 1} pending upload).`);
}
function removePodImageOp(podLocalId: string) {
  savePendingPodImages(pendingPodImages().filter((o) => o.podLocalId !== podLocalId));
}

// Upload a single Blob to load-docs storage, returning its path (mirrors uploadAttachment
// but for an in-memory blob rather than a File input).
async function uploadPodBlob(loadId: string, kind: string, blob: Blob, filename: string, type: string): Promise<string> {
  const { uploadUrl, token, path } = await getUploadUrlFn({ data: { loadId, kind, filename } });
  const sb = getSupabase();
  if (sb) {
    const { error } = await sb.storage.from("load-docs").uploadToSignedUrl(path, token, blob, {
      contentType: type || "application/octet-stream", upsert: true,
    });
    if (error) throw error;
  } else {
    const res = await fetch(uploadUrl, { method: "PUT", body: blob, headers: { "Content-Type": type || "application/octet-stream" } });
    if (!res.ok) throw new Error(`Storage upload failed (${res.status})`);
  }
  await setAttachmentMetaFn({ data: { loadId, kind, path, name: filename, size: blob.size, type: type || "application/octet-stream" } });
  return path;
}

// public trigger for an immediate image-upload attempt (e.g. right after capture when online).
export function flushPodImagesNow() { flushPodImages().catch(() => {}); }

async function flushPodImages() {
  const queued = pendingPodImages();
  if (!queued.length) return;
  if (!(await hasAuthSession())) return;
  for (const op of queued) {
    try {
      const rec = await getPodImage(op.podLocalId);
      if (!rec || !rec.blob) {
        // blob missing (evicted/never stored) — cannot recover an image; drop the queue entry
        // but leave the consignee op gated so it never finalizes as delivered-with-POD on a
        // phantom path. Surface loudly.
        removePodImageOp(op.podLocalId);
        toDeadLetter("pod_image_lost", { ...op, podMeta: undefined }, "local image blob missing before upload — re-capture needed");
        setSyncStatus("error", `POD photo lost before upload for ${op.consigneeCity || "a stop"} — please re-capture.`);
        continue;
      }
      const kind = op.kind || (op.ci != null ? `pod_c${op.ci}` : "pod");
      const path = await uploadPodBlob(op.loadId, kind, rec.blob, rec.name || `${op.podLocalId}.jpg`, rec.type || "image/jpeg");
      // write the POD record now that the image is really in storage
      try { pushPOD({ ...op.podMeta, path }); } catch (e) { console.warn("[supaSync] pushPOD after image upload failed", e); }
      // clear the linked finalization op's gate + stamp the real path so it can finalize.
      // The image may be linked to a consignee mark OR a single-load delivery — clear both queues.
      const nextC = pendingConsigneeOps().map((o) =>
        (o.awaitingImage === op.podLocalId) ? { ...o, awaitingImage: null, podPath: path } : o
      );
      savePendingConsigneeOps(nextC);
      const nextD = pendingDelivers().map((o) =>
        (o.awaitingImage === op.podLocalId) ? { ...o, awaitingImage: null } : o
      );
      savePendingDelivers(nextD);
      // image is safely uploaded → now safe to delete the local blob
      try { await deletePodImage(op.podLocalId); } catch {}
      removePodImageOp(op.podLocalId);
    } catch (e) {
      const next = pendingPodImages().map((o) =>
        o.podLocalId === op.podLocalId ? { ...o, attempts: (o.attempts || 0) + 1, lastError: formatError(e) } : o
      );
      savePendingPodImages(next);
      setSyncStatus("error", `POD photo upload pending (${formatError(e)}) — will retry.`);
      return; // stop on first failure; retries on next trigger
    }
  }
  // images landed → finalize any consignee marks / single-load deliveries whose gate just cleared
  flushConsigneeOps().catch(() => {});
  flushDelivers().catch(() => {});
}



// ---------- consigneeDeliveries: server is authoritative ----------
// The server (app_mark_consignee) merge-preserves every stop's fields and is the single
// source of truth. The former client-side mergeConsigneeDeliveries() was retired in Phase 2f
// after the concurrency test confirmed no fields are lost; applyServerRow takes serverRow's
// consigneeDeliveries directly via the {...serverRow} spread.


// ---------- Apply a single server row into the local cache ----------
// Called both from realtime events and from confirmed write responses.
// Server row always wins — no clock check, no skip.
// emitChange=false suppresses the tms:sync dispatch (used by optimistic upsert
// paths to avoid re-entering refreshFromStorage mid-action).
function applyServerRow(storageKey: string, serverRow: any, emitChange = true) {
  if (!serverRow?.id) return;
  const id = String(serverRow.id);

  // Soft-delete: a load that arrives marked DELETED (via delta or realtime
  // UPDATE) is a REMOVAL, not an upsert. Drop it from the local cache and
  // remember the tombstone so a late event for the same id can't resurrect it.
  // The server enforces this authoritatively (app_write_load reason='deleted');
  // this keeps the UI in step the instant the deletion syncs.
  if (storageKey === K.loads && serverRow?.lstatus === "DELETED") {
    const cur = lsGet<any[]>(storageKey, []);
    const after = cur.filter((r) => String(r?.id) !== id);
    if (after.length !== cur.length) lsSet(storageKey, after);
    rememberDeletedLoad(id);
    if (emitChange) emit();
    return;
  }

  // Level 2: record the server's authoritative version for this row, so the next
  // guarded write can pass the correct base_version. Underscore field _v.
  if (serverRow._v != null) {
    if (storageKey === K.loads) noteBaseVersion("loads", id, serverRow._v);
    else if (storageKey === K.vehicles) noteBaseVersion("vehicles", id, serverRow._v);
  }
  const list = lsGet<any[]>(storageKey, []);
  const idx = list.findIndex((r) => String(r?.id) === id);

  let nextRow: any;
  if (idx === -1) {
    if (storageKey === K.vehicles && deletedVehicleIds().has(id)) return;
    if (storageKey === K.loads && deletedLoadIds().has(id)) return;
    nextRow = serverRow;
  } else {
    const existing = list[idx];

    // F4 slice 1 — VERSION-GATED ADOPTION: realtime and delta events can arrive
    // out of order (two writes in quick succession, two transports racing). When
    // both rows carry a server version, never let an OLDER version overwrite a
    // newer one in the cache. Equal versions re-apply harmlessly (idempotent
    // echo). Rows without versions (legacy/no-_v paths) behave exactly as today.
    const inV = Number((serverRow as any)?._v);
    const curV = Number((existing as any)?._v);
    if (Number.isFinite(inV) && Number.isFinite(curV) && inV < curV) {
      return; // stale event — the cache already holds a newer server state
    }

    // Never let a server row un-deliver a load that is already DELIVERED locally.
    // This guards against realtime UPDATE events (from crons or other clients)
    // arriving after the local deliver write but before the DB has caught up.
    if (
      storageKey === K.loads &&
      (existing?.lstatus === "DELIVERED" || existing?.deliveredAt) &&
      serverRow?.lstatus !== "DELIVERED" &&
      !serverRow?.deliveredAt
    ) return;

    nextRow = { ...existing, ...serverRow };
    // 2f (retired): server is authoritative for consigneeDeliveries — the {...serverRow}
    // spread above already carries it. The client-side merge was proven unnecessary by the
    // concurrency test (server preserves both writers' fields) and has been removed.

    // DELIVERED loads always have vehicleId cleared
    if (nextRow.lstatus === "DELIVERED") {
      nextRow.vehicleId = null;
      nextRow.deliveredAt = nextRow.deliveredAt || existing?.deliveredAt || new Date().toISOString();
    }
  }

  const next = idx === -1
    ? [nextRow, ...list]
    : list.map((r, i) => (i === idx ? nextRow : r));
  lsSet(storageKey, next);
  if (emitChange) emit();
}

// ---------- Apply a realtime payload (INSERT/UPDATE/DELETE) ----------
function applyRealtimeEvent(
  storageKey: string,
  event: "INSERT" | "UPDATE" | "DELETE",
  newRow: any,
  oldRow: any,
) {
  if (event === "DELETE") {
    const id = String(oldRow?.id ?? oldRow?.data?.id ?? newRow?.id ?? "");
    if (!id) return;
    const list = lsGet<any[]>(storageKey, []);
    lsSet(storageKey, list.filter((r) => String(r?.id) !== id));
    // Remember the deletion so a late INSERT/UPDATE event for the same id
    // (from another device or replay) doesn't resurrect the row locally.
    if (storageKey === K.loads) rememberDeletedLoad(id);
    if (storageKey === K.vehicles) rememberDeletedVehicle(id);
    emit();
    return;
  }
  // INSERT or UPDATE — newRow is the full server row { id, data, updated_at }
  if (!newRow?.id) return;
  const _lidFromRow = (newRow.data && newRow.data.lid) ?? newRow.lid;
  const normalized = stripInlinePODImageFields({
    id: newRow.id,
    ...(newRow.data || {}),
    // Restore lid from the top-level column when the blob lost it (cron/driver
    // writes strip it). Only set when present so vehicle rows stay untouched.
    ...(_lidFromRow ? { lid: _lidFromRow } : {}),
    loadId: Object.prototype.hasOwnProperty.call(newRow.data || {}, "loadId")
      ? newRow.data.loadId
      : newRow.load_id,
    updatedAt: newRow.updated_at,
    at: (newRow.data || {}).at || (newRow.data || {}).uploadedAt || newRow.updated_at,
    // Level 2: carry the server row version so the cache always knows the base
    // version for each record. Writes ignore it for now (shadow); enforcement comes later.
    _v: newRow.version ?? null,
  });
  applyServerRow(storageKey, normalized);
}

// ---------- Full hydrate from cloud ----------
async function hydrateFromCloud(initial: boolean) {
  try {
    const snap = await pullAll(driverCreds ? { data: driverCreds } : undefined);
    // Only forget tombstones for ids the cloud has CONFIRMED gone — i.e. ids
    // that are NOT present in the snapshot. If the cloud snapshot still
    // returns a load we just deleted (because the delete RPC hasn't fully
    // propagated yet), keep the tombstone so we don't resurrect it.
    const snapLoadIds = new Set(
      (snap.loads || []).map((l: any) => String(l?.id)).filter(Boolean)
    );
    const tombstonedSet = new Set(
      Array.from(deletedLoadIds()).filter((id) => snapLoadIds.has(String(id))).map(String)
    );
    const confirmedGone = Array.from(deletedLoadIds()).filter((id) => !snapLoadIds.has(String(id)));
    if (confirmedGone.length) forgetDeletedLoads(confirmedGone);

    // Write cloud data straight to cache — server is authoritative, except:
    // 1. ids we have a live tombstone for (still pending cloud confirmation).
    // 2. loads already marked DELIVERED locally but not yet in this snapshot
    //    (hydrate race: deliver write in-flight when snapshot was fetched).
    const localLoads = lsGet<any[]>(K.loads, []);
    const localDeliveredIds = new Set(
      localLoads
        .filter((l: any) => l?.lstatus === "DELIVERED" || l?.deliveredAt)
        .map((l: any) => String(l?.id))
    );
    lsSet(K.vehicles, snap.vehicles || []);
    lsSet(K.loads, (snap.loads || []).filter((l: any) => {
      if (tombstonedSet.has(String(l?.id))) return false;
      // If this load is delivered locally but the snapshot doesn't show it as
      // delivered yet, drop it from the hydrate — the in-flight write will
      // propagate via realtime and applyServerRow instead.
      if (localDeliveredIds.has(String(l?.id)) && l?.lstatus !== "DELIVERED" && !l?.deliveredAt) return false;
      return true;
    }));
    // Level 2: seed base versions from the snapshot so the first guarded write
    // after a hydrate carries the correct base_version.
    for (const v of (snap.vehicles || [])) noteBaseVersion("vehicles", String(v?.id), v?._v);
    for (const l of (snap.loads || []))    noteBaseVersion("loads", String(l?.id), l?._v);
    lsSet(K.pods, snap.pods || []);
    lsSet(K.sos, snap.sos || []);
    lsSet(K.geofenceAlerts, (snap as any).geofenceAlerts || []);

    for (const [vnum, pin] of Object.entries(snap.pins || {})) {
      lsSet(K.pin(vnum), pin);
    }
    const byLoad: Record<string, Record<string, any>> = {};
    for (const a of snap.attachments || []) {
      byLoad[a.loadId] = byLoad[a.loadId] || {};
      byLoad[a.loadId][a.kind] = {
        name: a.name, size: a.size, type: a.type,
        uploadedAt: a.uploadedAt, path: a.path,
      };
    }
    for (const [lid, kinds] of Object.entries(byLoad)) {
      lsSet(K.attach(lid), kinds);
    }

    if (snap.errors?.length) {
      console.warn("[supaSync] pull errors:", snap.errors);
      if (initial) setSyncStatus("error", `Cloud pull error: ${snap.errors.join("; ")}`);
    } else if (initial) {
      setSyncStatus("ready", "Cloud connected");
    } else {
      setSyncStatus("synced", "Cloud refresh complete");
    }
    if ((snap as any).maxUpdatedAt) deltaCursor = (snap as any).maxUpdatedAt;
    // D-3a: stop rows for the active working set
    try {
      setStopsFromRows((snap as any).loadStops || []);
      console.log("[D3] stops store hydrated:", stopsByLoad.size, "loads");
    } catch {}
    emit();
    // F3: if the delivered fetch came back FULL (=1000 rows), older delivered
    // history exists beyond the snapshot. Back-fill it in the background so the
    // Delivered page's 90-day window is complete even on a fresh cache /
    // wholesale hydrate. Fire-and-forget; never blocks the hydrate.
    try {
      const dp: any = (snap as any).deliveredPage || null;
      if (dp?.full && dp?.cursorT && !driverCreds) {
        console.log("[F3] delivered page full — starting back-fill from", dp.cursorT);
        hydrateDeliveredHistory(dp.cursorT, dp.cursorId || "").catch(() => {});
      }
    } catch {}
    return true;
  } catch (e) {
    console.warn("[supaSync] hydrate failed", e);
    if (initial) setSyncStatus("error", `Cloud hydrate failed: ${formatError(e)}`);
    return false;
  }
}

// ── F3: delivered-history back-fill ──────────────────────────────────────────
// Pages older DELIVERED rows (keyset, 500/page) into the local cache until the
// Delivered page's 90-day window is covered, history is exhausted, or the
// safety cap (6 pages / 3000 rows) hits. MERGES into K.loads (never replaces);
// existing ids win (they're newer). Single-flight guarded.
let deliveredHydrateRunning = false;
async function hydrateDeliveredHistory(beforeUpdatedAt: string, beforeId: string) {
  if (deliveredHydrateRunning) return;
  deliveredHydrateRunning = true;
  try {
    const cutoff = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString();
    let cursorT: string | null = beforeUpdatedAt;
    let cursorId: string | null = beforeId;
    for (let page = 0; page < 6 && cursorT; page++) {
      const res: any = await pullDeliveredPage({ data: { beforeUpdatedAt: cursorT, beforeId: cursorId || undefined, limit: 500 } });
      const rows: any[] = res?.loads || [];
      if (!rows.length) break;
      const cache = lsGet<any[]>(K.loads, []) || [];
      const have = new Set(cache.map((l: any) => String(l?.id)));
      const tomb = deletedLoadIds();
      const fresh = rows.filter((l: any) => !have.has(String(l?.id)) && !tomb.has(String(l?.id)));
      if (fresh.length) {
        lsSet(K.loads, [...cache, ...fresh]);
        for (const l of fresh) noteBaseVersion("loads", String(l?.id), l?._v);
        emit();
      }
      console.log(`[F3] delivered back-fill page ${page + 1}: +${fresh.length} rows`);
      // Stop when we've covered the 90-day window (oldest row in this page is
      // older than the cutoff by deliveredAt) or history is exhausted.
      const oldestDeliveredAt = rows.reduce((m: string | null, l: any) => {
        const t = l?.deliveredAt || null; return t && (!m || t < m) ? t : m;
      }, null);
      if (!res?.hasMore) break;
      if (oldestDeliveredAt && oldestDeliveredAt < cutoff) break;
      cursorT = res?.nextBeforeUpdatedAt || null;
      cursorId = res?.nextBeforeId || null;
    }
  } catch (e) {
    console.warn("[supaSync] delivered back-fill failed (will retry on next hydrate)", e);
  } finally {
    deliveredHydrateRunning = false;
  }
}

// ---------- Delta pull (only rows changed since cursor) ----------
async function deltaFromCloud(): Promise<boolean> {
  if (!deltaCursor) return hydrateFromCloud(false);

  // Apply ONE page of delta results into the local cache. Returns true if it
  // changed anything (rows or deletions).
  const applyPage = (d: any): boolean => {
    if (d?.errors?.length) console.warn("[supaSync] delta errors:", d.errors);
    const changed =
      (d.vehicles?.length || 0) + (d.loads?.length || 0) + (d.pods?.length || 0) +
      (d.sos?.length || 0) + (d.attachments?.length || 0) + (d.geofenceAlerts?.length || 0);
    let touched = false;
    if (changed) {
      const now = Date.now();
      for (const [k, t] of ownWrites) if (now - t > 30_000) ownWrites.delete(k);
      for (const v of d.vehicles || []) {
        if (ownWrites.has(`vehicles:${v.id}`) && now - ownWrites.get(`vehicles:${v.id}`)! < 10_000) continue;
        applyServerRow(K.vehicles, v);
      }
      for (const l of d.loads || []) {
        // Deletion outranks echo suppression: a row another device DELETED must
        // never be skipped just because WE wrote it recently (create-on-A,
        // delete-on-B within 10s left A blind for the suppression window).
        if (l?.lstatus !== "DELETED"
            && ownWrites.has(`loads:${l.id}`) && now - ownWrites.get(`loads:${l.id}`)! < 10_000) continue;
        applyServerRow(K.loads, l);
      }
      for (const p of d.pods || []) applyServerRow(K.pods, p);
      for (const s of d.sos || []) applyServerRow(K.sos, s);
      for (const g of d.geofenceAlerts || []) applyServerRow(K.geofenceAlerts, g);

      const byLoad: Record<string, Record<string, any>> = {};
      for (const a of d.attachments || []) {
        byLoad[a.loadId] = byLoad[a.loadId] || {};
        byLoad[a.loadId][a.kind] = {
          name: a.name, size: a.size, type: a.type, uploadedAt: a.uploadedAt, path: a.path,
        };
      }
      for (const [lid, kinds] of Object.entries(byLoad)) {
        const prev = lsGet<Record<string, any>>(K.attach(lid), {});
        lsSet(K.attach(lid), { ...prev, ...kinds });
      }
      touched = true;
    }
    const deletedIds: string[] = d.deletedLoadIds || [];
    if (deletedIds.length) {
      const list = lsGet<any[]>(K.loads, []);
      const delSet = new Set(deletedIds.map(String));
      lsSet(K.loads, list.filter((l) => !delSet.has(String(l?.id))));
      for (const id of deletedIds) rememberDeletedLoad(id);
      touched = true;
    }
    return touched;
  };

  try {
    // 5s lookback applied ONLY to the first request of the cycle (boundary-tie
    // safety). Inside the pagination loop we advance to the exact nextSince so
    // we don't re-fetch the same page forever.
    const cursorMs = Date.parse(deltaCursor);
    let since = isNaN(cursorMs) ? deltaCursor : new Date(cursorMs - 5000).toISOString();
    let anyChange = false;

    // Page until the server reports it's drained (hasMore=false). At normal
    // scale the first page is never full, so this runs exactly once. The cap
    // bounds a pathological backlog so a client can never spin forever.
    for (let page = 0; page < 50; page++) {
      const d: any = await pullDelta({ data: { since, ...(driverCreds || {}) } });
      if (applyPage(d)) anyChange = true;

      const next = d?.nextSince ?? d?.maxUpdatedAt;
      if (next && (!deltaCursor || next > deltaCursor)) deltaCursor = next;

      if (!d?.hasMore) break;          // fully drained
      if (!next) break;                // defensive: no cursor to advance → stop
      since = next;                    // continue from the exact boundary (no 5s subtraction mid-loop)
    }

    if (anyChange) { emit(); setSyncStatus("synced", "Cloud synced"); }
    return true;
  } catch (e) {
    console.warn("[supaSync] delta failed", e);
    return false;
  }
}

let lastRefreshAt = 0;
let refreshInFlight: Promise<boolean> | null = null;
export async function refreshFromCloud(minIntervalMs = 2000): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  const now = Date.now();
  if (now - lastRefreshAt < minIntervalMs) return false;
  lastRefreshAt = now;
  refreshInFlight = hydrateFromCloud(false).finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

// ---------- initSync ----------
export async function initSync() {
  if (typeof window === "undefined") return;
  if (initPromise) return initPromise;
  initialized = true;

  initPromise = (async () => {
    await hydrateFromCloud(true);
    hydrated = true;
    emit();

    // Warn if realtime SQL hasn't been applied
    diagnoseRealtimeFn().then((d: any) => {
      if (!d || d.unknown) return;
      if (d.ok) return;
      const broken = (d.results || []).filter((r: any) => !r.inPublication || !r.replicaFull).map((r: any) => r.table);
      if (broken.length) {
        setSyncStatus(
          "error",
          `Realtime not configured for: ${broken.join(", ")}. Run sql/sync-all.sql in Supabase to enable cross-user sync.`,
        );
      }
    }).catch(() => {});

    const sb = await ensureSupabase();
    if (!sb) {
      const missing = getMissingPublicConfig();
      setSyncStatus(
        "offline",
        missing.length
          ? `Cloud realtime disabled: missing ${missing.join(", ")}`
          : "Cloud realtime disabled: missing public config",
      );
      return;
    }

    const activeChannels: any[] = [];
    let subscribedCount = 0;
    let totalChannels = 0;
    let removingChannels = false;
    let requestResubscribe: (() => void) | null = null;

    let everSubscribed = false;
    const onChannelStatus = (status: string) => {
      if (status === "SUBSCRIBED") {
        subscribedCount += 1;
        if (subscribedCount >= totalChannels) setSyncStatus("synced", "Cloud realtime connected");
        // F4 polish: a REJOIN after any drop means events may have been missed
        // while down — sweep the gap with ONE immediate delta. First-ever
        // subscribe is covered by the initial hydrate; only rejoins trigger.
        if (everSubscribed) deltaFromCloud().catch(() => {});
        everSubscribed = true;
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        if (status === "CLOSED" && removingChannels) return;
        setSyncStatus("error", `Realtime ${status.toLowerCase()} — reconnecting`);
        requestResubscribe?.();
      }
    };

    const subscribeAll = () => {
      subscribedCount = 0;
      totalChannels = 1;
      const ch = sb.channel("tms-all");

      // vehicles, loads, pods, sos, geofence_alerts — server row applied directly
      const bind = (table: string, key: string) =>
        ch.on("postgres_changes", { event: "*", schema: "public", table }, (payload: any) => {
          applyRealtimeEvent(key, payload.eventType, payload.new, payload.old);
        });
      bind("vehicles",        K.vehicles);
      bind("loads",           K.loads);
      bind("pod_records",     K.pods);
      bind("sos_records",     K.sos);
      bind("geofence_alerts", K.geofenceAlerts);

      // D-3a: live stop rows (feeds the stops store; no UI reads yet)
      ch.on("postgres_changes", { event: "*", schema: "public", table: "load_stops" }, (payload: any) => {
        try { applyStopsRealtime(payload?.eventType || payload?.type || "", payload?.new || payload?.old || {}); } catch {}
      });

      // vehicle_pins: key/value shape, not a list row
      ch.on("postgres_changes", { event: "*", schema: "public", table: "vehicle_pins" }, (payload: any) => {
        const row = payload.new ?? payload.old;
        const vnum = normalizeVnum(row?.vnum || "");
        if (!vnum) return;
        const key = K.pin(vnum);
        if (payload.eventType === "DELETE") {
          try { localStorage.removeItem(key); } catch {}
        } else {
          lsSet(key, payload.new?.pin);
        }
        emit();
      });

      // load_attachments
      ch.on("postgres_changes", { event: "*", schema: "public", table: "load_attachments" }, (payload: any) => {
        const row = payload.new ?? payload.old;
        const loadId = row?.load_id;
        const kind = row?.kind;
        if (!loadId || !kind) return;
        const key = K.attach(loadId);
        const prev = lsGet<Record<string, any>>(key, {});
        if (payload.eventType === "DELETE") {
          if (prev && prev[kind]) {
            const { [kind]: _, ...rest } = prev;
            lsSet(key, rest);
            emit();
          }
          return;
        }
        const meta = row?.meta || {};
        lsSet(key, {
          ...prev,
          [kind]: {
            name: meta.name, size: meta.size, type: meta.type,
            uploadedAt: meta.uploadedAt || row.updated_at,
            path: row.path,
          },
        });
        emit();
      });

      // app_settings
      ch.on("postgres_changes", { event: "*", schema: "public", table: "app_settings" }, (payload: any) => {
        const ev = payload.eventType as "INSERT" | "UPDATE" | "DELETE";
        const key = (payload.new?.key ?? payload.old?.key) as string | undefined;
        if (!key) return;
        if (ev === "DELETE") {
          settingsCache.delete(key);
        } else {
          settingsCache.set(key, payload.new?.value);
        }
        for (const cb of settingsListeners.get(key) || []) cb(payload.new?.value);
      });

      ch.subscribe(onChannelStatus);
      activeChannels.push(ch);
    };

    const unsubscribeAll = async () => {
      const chs = activeChannels.splice(0);
      removingChannels = true;
      try {
        await Promise.all(chs.map((ch) => sb.removeChannel(ch).catch(() => {})));
      } finally {
        removingChannels = false;
      }
    };

    let resyncTimer: any = null;
    const resubscribe = (skipPull = false) => {
      if (resyncTimer) return;
      resyncTimer = setTimeout(async () => {
        resyncTimer = null;
        await unsubscribeAll();
        subscribeAll();
        if (!skipPull) hydrateFromCloud(false).catch(() => {});
      }, 250);
    };
    requestResubscribe = resubscribe;

    // Set JWT before subscribing
    let lastAccessToken: string | null = null;
    try {
      const { data: sessionData } = await sb.auth.getSession();
      const token = sessionData?.session?.access_token ?? null;
      lastAccessToken = token;
      sb.realtime.setAuth(token as any);
    } catch {}

    subscribeAll();

    // ── F4 polish (final form): the PRIVATE signals channel ──────────────────
    // 'tms-signals' carries database-originated announcements (0018:
    // app_delete_load announces its own deletes via realtime.send — which
    // delivers to PRIVATE channels only, by design). Deliberately OUTSIDE
    // activeChannels/health: a latency optimization — if it fails, CDC + the
    // 10s heartbeat still carry truth, and its failure must never mark the
    // main transport unhealthy or trigger resubscribe loops.
    let signalsCh: any = null;
    let signalsRetry: any = null;
    const setupSignalsChannel = () => {
      try { if (signalsCh) { sb.removeChannel(signalsCh).catch(() => {}); signalsCh = null; } } catch {}
      const c = sb.channel("tms-signals", { config: { private: true } } as any);
      c.on("broadcast", { event: "tms-signal" }, (msg: any) => {
        try {
          const p = msg?.payload || {};
          console.log("[signal] received", p.kind, p.id || "");
          if (p.kind === "load_deleted" && p.id) {
            applyServerRow(K.loads, { id: String(p.id), lstatus: "DELETED" });
          }
        } catch {}
      });
      c.subscribe((status: string) => {
        if (status === "SUBSCRIBED") {
          console.log("[signal] private channel joined");
          if (signalsRetry) { clearTimeout(signalsRetry); signalsRetry = null; }
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          if (!signalsRetry) signalsRetry = setTimeout(() => { signalsRetry = null; setupSignalsChannel(); }, 15_000);
        }
      });
      signalsCh = c;
    };
    setupSignalsChannel();

    // ── F4 slices 2+3: leader-tab polling + realtime-primary cadence ──────────
    // LEADER TAB: one tab per browser holds a localStorage lease (12s TTL,
    // renewed each tick). Only the leader polls; followers ride their own
    // realtime sockets + the storage bridge below, and poll ONLY if their own
    // realtime is unhealthy. Hidden tabs skip ticks, so a hidden leader's lease
    // expires and a visible tab takes over automatically.
    // REALTIME-PRIMARY: when the realtime channel is healthy, polling demotes
    // to a safety net (delta ~30s, full refresh ~10min). Channel unhealthy →
    // legacy cadence (delta 5s, refresh 2min) until it recovers.
    // Kill-switches: either flag false → today's exact behavior.
    const LEADER_POLLING = true;
    const REALTIME_PRIMARY = true;
    const tabId = (crypto as any)?.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
    const claimLeadership = (): boolean => {
      if (!LEADER_POLLING) return true;
      try {
        const now = Date.now();
        const cur = lsGet<any>("lov_tms_leader", null);
        if (!cur || !cur.at || now - Number(cur.at) > 12_000 || cur.id === tabId) {
          lsSet("lov_tms_leader", { id: tabId, at: now });
          return true;
        }
        return false;
      } catch { return true; } // storage broken → act as leader (safe default)
    };
    const realtimeHealthy = (): boolean => {
      try {
        return activeChannels.length > 0
          && activeChannels.every((ch: any) => ch.state === "joined")
          && sb.realtime.connectionState?.() !== "closed";
      } catch { return false; }
    };
    // Storage bridge: when ANOTHER tab (the leader) writes our data keys, adopt
    // instantly by re-emitting the same-tab sync event the UI already listens to.
    try {
      window.addEventListener("storage", (ev: StorageEvent) => {
        if (!ev?.key) return;
        if (ev.key === K.loads || ev.key === K.vehicles || ev.key === K.pods
            || ev.key === K.sos || ev.key === K.geofenceAlerts) emit();
      });
    } catch {}

    if (!fallbackPollTimer) {
      let pollTick = 0;
      fallbackPollTimer = setInterval(() => {
        if (typeof navigator !== "undefined" && navigator.onLine === false) return;
        if (typeof document !== "undefined" && document.hidden) return; // hidden tabs catch up on focus
        // Queue flushes run on EVERY tab — each tab must land its own writes.
        flushPendingWrites().catch(() => {});
        flushPodImages().catch(() => {});
        flushConsigneeOps().catch(() => {});
        flushDelivers().catch(() => {});
        pollTick += 1;
        const leader = claimLeadership();
        const healthy = REALTIME_PRIMARY ? realtimeHealthy() : false;
        if (!leader) {
          // Follower: realtime + storage bridge carry the data. Poll only if
          // THIS tab's realtime is down (can't count on the leader's writes
          // reaching us without a healthy bridge — cheap self-defense).
          if (!healthy) deltaFromCloud().catch(() => {});
          return;
        }
        if (healthy) {
          if (pollTick % 120 === 0) refreshFromCloud(10_000).catch(() => {}); // full refresh ~10min
          else if (pollTick % 2 === 0) deltaFromCloud().catch(() => {});      // safety delta ~10s (F4 polish)
        } else {
          if (pollTick % 24 === 0) refreshFromCloud(10_000).catch(() => {}); // legacy: refresh ~2min
          else deltaFromCloud().catch(() => {});                              // legacy: delta ~5s
        }
      }, 5_000);
    }

    // Keep JWT in sync with auth state
    let lastUserId: string | null = null;
    try {
      const { data: u0 } = await sb.auth.getUser();
      lastUserId = u0?.user?.id ?? null;
    } catch {}

    // Heartbeat: resubscribe when the socket has died silently (no CHANNEL_ERROR/CLOSED fired).
    // subscribedCount never decrements after a silent drop, so we check real channel state.
    // Guards: skip when signed out, offline, or a join/connect is already in progress.
    setInterval(() => {
      if (!lastUserId) return;
      if (typeof navigator !== "undefined" && navigator.onLine === false) return;
      if (typeof document !== "undefined" && document.hidden) return;
      const dead =
        !activeChannels.length ||
        activeChannels.some((ch) => ch.state === "closed" || ch.state === "errored" || ch.state === "leaving") ||
        sb.realtime.connectionState?.() === "closed";
      if (dead) resubscribe();
    }, 30_000);

    sb.auth.onAuthStateChange((event, session) => {
      if (event === "TOKEN_REFRESHED" || event === "USER_UPDATED" || event === "SIGNED_IN") {
        const nextToken = session?.access_token ?? null;
        try { sb.realtime.setAuth(nextToken as any); } catch {}
        const newUserId = session?.user?.id ?? null;
        if (newUserId !== lastUserId || nextToken !== lastAccessToken) {
          const userChanged = newUserId !== lastUserId;
          lastUserId = newUserId;
          lastAccessToken = nextToken;
          if (event === "SIGNED_IN" && userChanged) {
            try {
              localStorage.removeItem(K.vehicles);
              localStorage.removeItem(K.loads);
              localStorage.removeItem(K.deletedLoads);
              localStorage.removeItem(K.pods);
              localStorage.removeItem(K.sos);
              localStorage.removeItem(K.geofenceAlerts);
              for (let i = localStorage.length - 1; i >= 0; i--) {
                const key = localStorage.key(i);
                if (!key) continue;
                if (key.startsWith("lov_load_attach_") || key.startsWith("lov_veh_pin_")) {
                  localStorage.removeItem(key);
                }
              }
            } catch {}
            hydrated = false;
            emit();
            hydrateFromCloud(true).then(() => { hydrated = true; emit(); }).catch(() => {});
            resubscribe(true);
          } else {
            resubscribe();
          }
        }
      } else if (event === "SIGNED_OUT") {
        try { sb.realtime.setAuth(null as any); } catch {}
        lastUserId = null;
        lastAccessToken = null;
        if (resyncTimer) { clearTimeout(resyncTimer); resyncTimer = null; }
        void unsubscribeAll();
      }
    });

    // Recover after sleep / network loss.
    // visibilitychange / focus fire on every browser-tab or window switch.
    // deltaFromCloud already runs on a ~5s poll loop, so we only trigger an
    // extra fetch if >= 30s have passed since the last one.
    // "online" always fires immediately — genuine reconnect, always sync.
    let lastVisibilityDelta = 0;
    const VISIBILITY_THROTTLE_MS = 30_000;
    if (typeof window !== "undefined") {
      window.addEventListener("online", () => { flushPendingWrites().catch(() => {}); flushPodImages().catch(() => {}); flushConsigneeOps().catch(() => {}); flushDelivers().catch(() => {}); deltaFromCloud().catch(() => {}); resubscribe(); });
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden) {
          flushPendingWrites().catch(() => {});
          flushPodImages().catch(() => {});
          flushConsigneeOps().catch(() => {});
          flushDelivers().catch(() => {});
          resubscribe();
          const now = Date.now();
          if (now - lastVisibilityDelta > VISIBILITY_THROTTLE_MS) {
            lastVisibilityDelta = now;
            deltaFromCloud().catch(() => {});
          }
        }
      });
      window.addEventListener("focus", () => {
        const now = Date.now();
        if (now - lastVisibilityDelta > VISIBILITY_THROTTLE_MS) {
          lastVisibilityDelta = now;
          deltaFromCloud().catch(() => {});
        }
      });
    }
  })();

  return initPromise;
}


// ---------- App settings ----------
const settingsCache = new Map<string, any>();
const settingsListeners = new Map<string, Set<(value: any) => void>>();
let settingsHydrated = false;
let settingsHydratePromise: Promise<void> | null = null;

async function hydrateSettings() {
  if (settingsHydrated) return;
  if (settingsHydratePromise) return settingsHydratePromise;
  settingsHydratePromise = (async () => {
    try {
      const { settings } = await pullSettingsFn();
      for (const row of settings || []) settingsCache.set(row.key, row.value);
      settingsHydrated = true;
      for (const [key, set] of settingsListeners.entries()) {
        const v = settingsCache.get(key);
        for (const cb of set) cb(v);
      }
    } catch (e) {
      console.warn("[supaSync] settings hydrate failed", e);
    }
  })();
  return settingsHydratePromise;
}

export function getCachedSetting<T>(key: string): T | undefined {
  return settingsCache.get(key) as T | undefined;
}

// Non-React/on-demand settings read (hydrate-once-then-cached). Used by driverStore,
// which has no React hook. Safe + cheap: hydrateSettings memoizes after first fetch.
export async function getSettingHydrated<T>(key: string, fallback: T): Promise<T> {
  try {
    await hydrateSettings();
    const v = getCachedSetting<T>(key);
    return v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

export function subscribeSetting<T>(key: string, cb: (value: T | undefined) => void) {
  let set = settingsListeners.get(key);
  if (!set) { set = new Set(); settingsListeners.set(key, set); }
  set.add(cb as (value: any) => void);
  hydrateSettings().then(() => {
    if (settingsCache.has(key)) cb(settingsCache.get(key));
  });
  return () => {
    set!.delete(cb as (value: any) => void);
    if (set!.size === 0) settingsListeners.delete(key);
  };
}

async function hasAuthSession(): Promise<boolean> {
  try {
    const sb = await ensureSupabase();
    const { data } = (await sb?.auth.getSession()) ?? { data: { session: null } };
    return Boolean(data?.session?.access_token);
  } catch {
    return false;
  }
}

export function pushSetting(key: string, value: any) {
  settingsCache.set(key, value);
  setSyncStatus("saving", `Saving setting ${key}`);
  const save = async () => {
    if (!(await hasAuthSession())) throw new Error("not-signed-in");
    return setSettingFn({ data: { key, value } });
  };
  const retryDelays = [0, 1200, 4000, 10000, 25000];
  const attempt = (index: number) => {
    const run = () => save()
      .then(() => setSyncStatus("synced", `Setting saved (${key})`))
      .catch((e) => {
        if (e?.message === "not-signed-in") { setSyncStatus("ready", ""); return; }
        console.warn("[supaSync] setting push failed", e);
        if (index < retryDelays.length - 1) {
          setSyncStatus("saving", `Cloud timeout. Retrying setting ${key}`);
          attempt(index + 1);
        } else {
          setSyncStatus("error", `Setting save failed: ${formatError(e)}`);
        }
      });
    retryDelays[index] ? setTimeout(run, retryDelays[index]) : run();
  };
  attempt(0);
}

export function deleteSetting(key: string) {
  settingsCache.delete(key);
  (async () => {
    if (!(await hasAuthSession())) return;
    return deleteSettingFn({ data: { key } });
  })().catch((e) => console.warn("[supaSync] setting delete failed", e));
}


// ---------- Direct browser writes (bypasses server functions entirely) ----------
// Writing via the browser Supabase client instead of a server function means:
//   browser → Supabase (1 hop) → Realtime to all devices
// vs the old path:
//   browser → Vercel server fn → Supabase (2 hops, ~300-800ms extra lag)
//
// RLS on the tables allows authenticated writes, so this is safe.
// The service-role server fn is still used for pullAll/pullDelta (reads)
// and for POD/SOS/delivery (driver path, no session).

// ---------- Level 2 versioned-write controls ----------
// Master kill-switch. If anything misbehaves in production, set this to false
// (or wire it to a remote flag) and writes instantly revert to the plain direct
// upsert path — no redeploy of logic needed.
const USE_VERSIONED_WRITES = true;
// Per-table enforcement. shadow=true → RPC applies every write, only reports
// would-rejects (no behaviour change). shadow=false → ENFORCE: stale/illegal
// writes are refused by the server, dropped by the client, server truth adopted.
// Step 4 enforces loads; vehicles stays shadow until Step 5 proves loads safe.
const VERSIONED_SHADOW: Record<"loads" | "vehicles", boolean> = {
  loads: false,    // ENFORCED (Step 4)
  vehicles: false, // ENFORCED (Step 5)
};

// Fail-closed writes (Phase 5 raw-fallback removal). When ON for a table, an RPC
// transport/signature error no longer falls back to a raw upsert — instead the
// write throws, the caller enqueues it, and it retries through the guarded RPC.
// A write is NEVER raw-applied. Default OFF = prior raw-fallback behaviour
// (byte-identical), so deploy is a no-op until a table is flipped on.
const FAIL_CLOSED_WRITES: Record<"loads" | "vehicles", boolean> = {
  // PHASE 0 (single-lane completion): loads flipped ON. With the canonical-blind
  // wall active (writeLoad.canonicalBlind=true), the raw-upsert fallback was the
  // LAST remaining path that could write lstatus/canonical fields outside the
  // engine (fingerprinted as the LD-5852 12:10 breach — one transient RPC error,
  // one verbatim blob landed, wall bypassed). Now an RPC error queues + retries
  // through the guarded RPC, same as vehicles since Phase 5. Never raw-applied.
  loads: true,
  vehicles: true,
};

// Guarded vehicle delete (Phase 6): route vehicle-row deletes through the
// app_delete_vehicle RPC (attributed) instead of a raw from("vehicles").delete().
const GUARDED_VEHICLE_DELETE = true;

// Tracks the last server version we saw per record, so we can pass base_version
// to the guarded RPC. Populated from _v on reads (see applyServerRow/hydrate).
const baseVersions = new Map<string, number>();
export function noteBaseVersion(table: "vehicles" | "loads", id: string, v: any) {
  if (v == null) return;
  const n = Number(v);
  // F4 slice 1: never let an out-of-order event LOWER the known version — a
  // regressed base_version would make the next honest write look stale.
  if (Number.isFinite(n)) {
    const cur = baseVersions.get(`${table}:${id}`);
    if (cur == null || n >= cur) baseVersions.set(`${table}:${id}`, n);
  }
}

// ── F2: field-patch writes ───────────────────────────────────────────────────
// When ON, object-lane updates send ONLY the changed keys (p_patch) + deleted
// keys (p_removed); the server merges onto CURRENT data under the row lock.
// Two dispatchers editing different fields of one row both land. Creations and
// rows without a known previous state still send the full blob. Kill-switch:
// flip to false → byte-identical full-blob behavior (server supports both).
const FIELD_PATCH_WRITES = true;
function diffKeys(prev: any, next: any): { patch: Record<string, any>; removed: string[] } {
  const patch: Record<string, any> = {};
  const removed: string[] = [];
  const P = prev || {}, N = next || {};
  for (const k of Object.keys(N)) {
    if (k === "_v") continue;
    const a = P[k], b = N[k];
    if (a === b) continue;
    let eq = false;
    try { eq = JSON.stringify(a) === JSON.stringify(b); } catch {}
    if (!eq) patch[k] = b;
  }
  for (const k of Object.keys(P)) {
    if (k === "_v") continue;
    if (!(k in N)) removed.push(k);
  }
  return { patch, removed };
}

async function directUpsert(
  table: "vehicles" | "loads",
  id: string,
  payload: any,
  extra?: Record<string, any>,
  opts?: { patch?: Record<string, any> | null; removed?: string[] | null },
): Promise<void> {
  // HALT GUARD: an ejected/stale tab must never write. Without this, a tab that
  // lost its session but kept running (old code, background timers) could push
  // stale state and resurrect delivered/deleted loads. Bail silently.
  if (isHalted()) return;
  const sb = await ensureSupabase();
  if (!sb) throw new Error("Supabase client not available");
  const updatedAt = new Date().toISOString();
  // Strip the Level 2 version marker (_v) from the data blob — it's a top-level
  // column concern, not part of the record's data. Leaving it in would pollute
  // the blob and get re-read as a phantom field.
  const { _v: _ignoredVersion, ...cleanPayload } = payload || {};
  const dataBlob = { ...cleanPayload, updatedAt };

  if (USE_VERSIONED_WRITES) {
    const enforce = !VERSIONED_SHADOW[table];
    const baseV = baseVersions.get(`${table}:${id}`) ?? null;
    const rpc = table === "loads" ? "app_write_load" : "app_write_vehicle";
    const args: any = table === "loads"
      ? { p_id: id, p_lid: String((extra as any)?.lid ?? cleanPayload?.lid ?? id), p_data: dataBlob, p_base_version: baseV }
      : { p_id: id, p_vnum: ((extra as any)?.vnum ?? cleanPayload?.vnum ?? null), p_data: dataBlob, p_base_version: baseV };
    // Both loads and vehicles RPCs now accept p_enforce (Steps 4 & 5).
    args.p_enforce = enforce;
    // F2: PATCH MODE — when the caller computed a field diff, send ONLY the
    // changed keys (+ the fresh updatedAt stamp) and the removed keys. The
    // server merges under the row lock; untouched fields are server truth.
    // Full blob still rides along in `payload` for the offline queue fallback.
    const usePatch = FIELD_PATCH_WRITES && !!opts && !!opts.patch;
    if (usePatch) {
      args.p_data = null;
      args.p_patch = { ...(opts!.patch || {}), updatedAt };
      args.p_removed = (opts!.removed && opts!.removed.length) ? opts!.removed : null;
    }
    let { data, error } = await sb.rpc(rpc, args);
    // no_row_for_patch: the row doesn't exist server-side (e.g. created offline
    // elsewhere / purged). Retry ONCE as a full-blob write (the insert path).
    if (!error && usePatch && (data as any)?.reason === "no_row_for_patch") {
      const retryArgs = { ...args, p_data: dataBlob, p_patch: null, p_removed: null };
      ({ data, error } = await sb.rpc(rpc, retryArgs));
    }
    if (error) {
      // RPC transport/signature error (NOT a would_reject — that's handled below).
      // FAIL-CLOSED (flag-gated): instead of silently raw-upserting (which bypasses
      // all canonical/version guards and was the vehicle-drift vector), surface the
      // error so the caller enqueues to the outbox and retries through the RPC.
      // A write is NEVER raw-applied. Flag OFF = prior behaviour (raw fallback).
      if (FAIL_CLOSED_WRITES[table]) {
        try { console.warn(`[L2 fail-closed] ${table} ${id} rpc_error=${error.message} — not raw-applied, will retry via RPC`); } catch {}
        throw new Error(`rpc_write_failed:${error.message}`);
      }
      // Flag OFF → legacy raw fallback (verbatim prior behaviour).
      await sb.from(table).upsert({ id, ...(extra || {}), data: dataBlob }, { onConflict: "id" }).select("updated_at");
    } else {
      const res: any = data || {};
      if (res.version != null) baseVersions.set(`${table}:${id}`, Number(res.version));
      if (res.ok === false && res.would_reject) {
        // ENFORCED REJECT: server refused this write (stale/illegal) and did NOT
        // apply it. Adopt server truth into local cache and silently drop our
        // stale write — no dispatcher prompt (by design).
        try { console.warn(`[L2 reject] ${table} ${id} reason=${res.reason} — adopted server truth, dropped write`); } catch {}
        if (res.current) {
          const truth = { id, ...(res.current || {}), _v: res.version ?? null };
          applyServerRow(table === "loads" ? K.loads : K.vehicles, truth);
        }
        ownWrites.set(`${table}:${id}`, Date.now());
        return;
      }
      if (res.would_reject) {
        // Shadow table: applied anyway, just report.
        try { console.warn(`[L2 shadow] ${table} ${id} would_reject=${res.reason} (applied anyway)`); } catch {}
      }
    }
    ownWrites.set(`${table}:${id}`, Date.now());
    return;
  }

  // Legacy path (kill-switch off): plain direct upsert, exactly as before.
  const { data, error } = await sb
    .from(table)
    .upsert(
      { id, ...(extra || {}), data: dataBlob },
      { onConflict: "id" },
    )
    .select("updated_at");
  if (error) throw new Error(error.message);
  // Mark this row as an own write so the delta poll skips our echo for ~10s.
  ownWrites.set(`${table}:${id}`, Date.now());
}

async function directDelete(table: "vehicles" | "loads", id: string): Promise<void> {
  if (isHalted()) return;
  const sb = await ensureSupabase();
  if (!sb) throw new Error("Supabase client not available");
  // Vehicles: route through the guarded app_delete_vehicle RPC (attributed delete)
  // when enabled, instead of a raw row delete. Flag OFF = prior raw behaviour.
  if (table === "vehicles" && GUARDED_VEHICLE_DELETE) {
    const { error } = await sb.rpc("app_delete_vehicle", { p_id: id });
    if (error) throw new Error(error.message);
    return;
  }
  // SANCTIONED-RAW-WRITE: delete fallback — bypassed for vehicles when
  // GUARDED_VEHICLE_DELETE is on; loads delete via app_delete_load, not here.
  const { error } = await sb.from(table).delete().eq("id", id);
  if (error) throw new Error(error.message);
}

// ---------- LD number allocation (collision-proof, server-issued) ----------
// Returns `count` freshly-allocated LD numbers from the DB sequence, or null if
// the server is unreachable so the caller can fall back to client generation.
// The RPC returns a Postgres text[]; depending on the client it can arrive as a
// real JS array, a JSON string, or a Postgres array literal ("{LD-1,LD-2}").
// Parse all three so a successfully-issued number is never silently discarded.
export async function nextLids(count = 1): Promise<string[] | null> {
  try {
    const sb = await ensureSupabase();
    if (!sb) return null;
    const want = Math.max(1, count | 0);
    const { data, error } = await sb.rpc("app_next_lids", { p_count: want });
    if (error) return null;
    let arr: any = data;
    if (typeof arr === "string") {
      const t = arr.trim();
      if (t.startsWith("[")) {
        try { arr = JSON.parse(t); } catch { arr = null; }
      } else if (t.startsWith("{") && t.endsWith("}")) {
        const inner = t.slice(1, -1).trim();
        arr = inner ? inner.split(",").map((x) => x.trim().replace(/^"(.*)"$/, "$1")) : [];
      } else {
        arr = t ? [t] : null;
      }
    }
    if (!Array.isArray(arr) || arr.length === 0) {
      try { console.warn("[supaSync] app_next_lids unexpected shape:", JSON.stringify(data)); } catch {}
      return null;
    }
    return arr.map((x: any) => String(x));
  } catch {
    return null;
  }
}

// ---------- Vehicle writes ----------
export async function upsertVehicleRemote(vehicle: any, opts?: { patch?: Record<string, any> | null; removed?: string[] | null }) {
  if (!vehicle?.id) return;
  if (deletedVehicleIds().has(String(vehicle.id))) return;
  const vnum = String(vehicle?.vnum || "").trim();
  if (!vnum) { console.warn("[supaSync] upsertVehicle skipped: missing vnum", vehicle.id); return; }
  setSyncStatus("saving", "Saving vehicle to cloud");
  try {
    applyServerRow(K.vehicles, vehicle, false); // no emit — caller already updated React state
    const wkey = `vehicles:${String(vehicle.id)}`;
    const prev = writeChains.get(wkey) ?? Promise.resolve();
    const chain = prev.catch(() => {}).then(() => directUpsert("vehicles", String(vehicle.id), vehicle, { vnum }, opts));
    writeChains.set(wkey, chain);
    try {
      await chain;
    } finally {
      if (writeChains.get(wkey) === chain) writeChains.delete(wkey);
    }
    removePendingWrite({ op: "upsert", table: "vehicles", id: String(vehicle.id), queuedAt: "", attempts: 0 });
    setSyncStatus("synced", `Vehicle saved (${vehicle.id})`);
  } catch (e) {
    console.warn("[supaSync] upsertVehicle failed", e);
    enqueuePendingWrite({ op: "upsert", table: "vehicles", id: String(vehicle.id), payload: vehicle, extra: { vnum } }, e);
    setSyncStatus("error", `Vehicle cloud save failed: ${formatError(e)}`);
    throw e;
  }
}

export async function deleteVehicleRemote(id: string) {
  if (!id) return;
  rememberDeletedVehicle(String(id));
  setSyncStatus("saving", "Deleting vehicle in cloud");
  try {
    const wkey = `vehicles:${String(id)}`;
    const prev = writeChains.get(wkey) ?? Promise.resolve();
    const chain = prev.catch(() => {}).then(() => directDelete("vehicles", String(id)));
    writeChains.set(wkey, chain);
    try {
      await chain;
    } finally {
      if (writeChains.get(wkey) === chain) writeChains.delete(wkey);
    }
    removePendingWrite({ op: "delete", table: "vehicles", id: String(id), queuedAt: "", attempts: 0 });
    setSyncStatus("synced", `Vehicle deleted (${id})`);
    const list = lsGet<any[]>(K.vehicles, []);
    lsSet(K.vehicles, list.filter((r) => String(r?.id) !== String(id)));
    emit();
  } catch (e) {
    console.warn("[supaSync] deleteVehicle failed", e);
    enqueuePendingWrite({ op: "delete", table: "vehicles", id: String(id) }, e);
    setSyncStatus("error", `Vehicle delete failed: ${formatError(e)}`);
    throw e;
  }
}

// ---------- Load writes ----------
export async function upsertLoadRemote(load: any, opts?: { patch?: Record<string, any> | null; removed?: string[] | null }) {
  if (!load?.id) return;
  const id = String(load.id);
  if (deletedLoadIds().has(id)) return;
  let lid = String(load?.lid || "").trim();
  if (!lid) {
    // Blob lost its lid (server write stripped it); recover from the cached row,
    // whose lid the read path now restores from the DB column. Never drops data.
    const cached = lsGet<any[]>(K.loads, []).find((r) => String(r?.id) === id);
    const cachedLid = String(cached?.lid || "").trim();
    if (cachedLid) { lid = cachedLid; load = { ...load, lid }; }
  }
  if (!lid) {
    // Still no lid (local-only row never persisted). Don't loop forever: warn
    // once and drop from the retry queue. The row stays in local state so the
    // user can give it a lid manually — nothing is deleted.
    if (!warnedMissingLid.has(id)) { console.warn("[supaSync] upsertLoad: no lid in blob or cache", id); warnedMissingLid.add(id); }
    removePendingWrite({ op: "upsert", table: "loads", id, queuedAt: "", attempts: 0 });
    return;
  }
  setSyncStatus("saving", "Saving load to cloud");
  try {
    applyServerRow(K.loads, load, false); // no emit — caller already updated React state
    const wkey = `loads:${id}`;
    const prev = writeChains.get(wkey) ?? Promise.resolve();
    const chain = prev.catch(() => {}).then(() => directUpsert("loads", id, load, { lid }, opts));
    writeChains.set(wkey, chain);
    try {
      await chain;
    } finally {
      if (writeChains.get(wkey) === chain) writeChains.delete(wkey);
    }
    removePendingWrite({ op: "upsert", table: "loads", id, queuedAt: "", attempts: 0 });
    setSyncStatus("synced", `Load saved (${id})`);
  } catch (e) {
    console.warn("[supaSync] upsertLoad failed", e);
    enqueuePendingWrite({ op: "upsert", table: "loads", id, payload: load, extra: { lid } }, e);
    setSyncStatus("error", `Load cloud save failed: ${formatError(e)}`);
    throw e;
  }
}

export async function deleteLoadRemote(id: string) {
  if (!id) return;
  rememberDeletedLoad(String(id));
  setSyncStatus("saving", "Deleting load in cloud");
  try {
    const wkey = `loads:${String(id)}`;
    const prev = writeChains.get(wkey) ?? Promise.resolve();
    const chain = prev.catch(() => {}).then(async () => {
      const sb = await ensureSupabase();
      if (!sb) throw new Error("Supabase client not available");
      // RPC sets per-tx app.* settings and cascades the delete; the trigger
      // writes ONE audit_log row with source='app' attributed to the caller.
      const { error } = await sb.rpc("app_delete_load", { p_id: String(id) });
      if (error) throw new Error(error.message);
    });
    writeChains.set(wkey, chain);
    try {
      await chain;
    } finally {
      if (writeChains.get(wkey) === chain) writeChains.delete(wkey);
    }
    removePendingWrite({ op: "delete", table: "loads", id: String(id), queuedAt: "", attempts: 0 });
    setSyncStatus("synced", `Load deleted (${id})`);
    const list = lsGet<any[]>(K.loads, []);
    lsSet(K.loads, list.filter((r) => String(r?.id) !== String(id)));
    emit();
  } catch (e) {
    console.warn("[supaSync] deleteLoad failed", e);
    enqueuePendingWrite({ op: "delete", table: "loads", id: String(id) }, e);
    setSyncStatus("error", `Load delete failed: ${formatError(e)}`);
    throw e;
  }
}

// ---------- Transition state machine (server-side engine) ----------
// Routes a vehicle status change through app_vehicle_transition, which computes
// the vehicle AND its load next-state from one authoritative rule set and writes
// both ATOMICALLY (one transaction, version-bumped). Replaces the client doing
// two separate writes. The server is the authority; the caller has already done
// an optimistic local update for instant UI.
// ── O1/O2: idempotent engine-op caller ───────────────────────────────────────
// Every engine action goes through app_op with a client-generated op_id.
// Server keeps a ledger: the same op_id NEVER applies twice — retries and
// offline replays return the stored result. On TRANSPORT failure (network,
// server unreachable, or a concurrent in-flight claim) the op is queued into
// pendingWrites (kind 'engine') and replayed by the flush loop — closing the
// "engine actions fail offline" gap. Logical refusals ({ok:false, reason})
// are returned to the caller unchanged, exactly as before.
async function callOp(fn: string, args: Record<string, any>): Promise<any> {
  // Stale-replay protection: stamp the load's version AS KNOWN AT INTENT TIME.
  // If the load changes while this op waits offline (someone else assigned/
  // queued/unassigned it), the engine's staleness check refuses the replay
  // (stale_load) instead of clobbering the newer decision. Terminal states are
  // already guarded independently; this closes the intent-vs-intent race.
  // NOTE: set_stops is deliberately NOT version-stamped — the edit-save fires
  // it alongside the object-lane patch for the same load, so a stamp races the
  // patch's version bump (guaranteed intermittent stale_load). It doesn't need
  // the stamp: the RPC locks the row and preserves delivery state from the
  // server's CURRENT data (cid-matched) — stale-safe by construction, the same
  // merge-under-lock property as F2 patch mode.
  if (["assign", "queue", "promote", "unassign"].includes(fn)
      && args.p_load_id && args.p_load_base_version === undefined) {
    const v = baseVersions.get(`loads:${args.p_load_id}`);
    if (v != null) args = { ...args, p_load_base_version: v };
  }
  const opId = (crypto as any)?.randomUUID ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}-4000-8000-${Math.random().toString(36).slice(2, 14)}`;
  try {
    const sb = await ensureSupabase();
    if (!sb) throw new Error("no_client");
    const { data, error } = await sb.rpc("app_op", { p_op_id: opId, p_fn: fn, p_args: args });
    if (error) throw new Error(error.message);
    const res: any = data || { ok: true };
    if (res.ok === false && res.reason === "op_in_flight") throw new Error("op_in_flight");
    if (res.ok === false) console.warn(`[supaSync] ${fn} refused`, res.reason, res.blocking_lid || "");
    return res;
  } catch (e: any) {
    // Transport-class failure → queue for idempotent replay, keep local optimism.
    enqueuePendingWrite({ op: "engine", table: "ops", id: opId, payload: { fn, args } } as any, e);
    console.warn(`[supaSync] ${fn} queued for replay (op ${opId}):`, e?.message || e);
    return { ok: false, reason: "queued_offline", queued: true, op_id: opId };
  }
}


export async function transitionVehicle(
  vehicleId: string,
  action: string,
  opts: { eta?: string | null; loadId?: string | null; lrDate?: string | null } = {},
): Promise<{ ok: boolean; reason?: string; blocking_lid?: string; applied?: boolean }> {
  if (!vehicleId || !action) return { ok: false, reason: "bad_args" };
  return callOp("transition", {
    p_vehicle_id: vehicleId,
    p_action: action,
    p_eta: opts.eta ?? null,
    p_explicit_load_id: opts.loadId ?? null,
    p_lr_date: opts.lrDate ?? null,
    p_dry_run: false,
  });
}


// ── Phase 1b assignment-lane RPCs (sanctioned canonical-lane ops) ────────────
// Thin wrappers around the dedicated DB assignment RPCs. Same return shape as
// transitionVehicle: { ok, reason?, ... }. The client repoint that calls these
// is gated behind the `assign.useEngine` flag (default off), so these are inert
// until that flag is flipped and a caller invokes them.
export async function assignLoadRpc(
  loadId: string,
  vehicleId: string,
  extra: Record<string, any> = {},
): Promise<{ ok: boolean; reason?: string; blocking_lid?: string }> {
  if (!loadId || !vehicleId) return { ok: false, reason: "bad_args" };
  return callOp("assign", { p_load_id: loadId, p_vehicle_id: vehicleId, p_extra: extra, p_source: "manual", p_dry_run: false });
}

export async function queueLoadRpc(
  loadId: string,
  vehicleId: string,
  behindLoadId: string | null,
): Promise<{ ok: boolean; reason?: string }> {
  if (!loadId || !vehicleId) return { ok: false, reason: "bad_args" };
  return callOp("queue", { p_load_id: loadId, p_vehicle_id: vehicleId, p_behind_load_id: behindLoadId ?? null, p_source: "manual", p_dry_run: false });
}

export async function promoteQueuedLoadRpc(
  loadId: string,
  extra: Record<string, any> = {},
): Promise<{ ok: boolean; reason?: string; blocking_lid?: string }> {
  if (!loadId) return { ok: false, reason: "bad_args" };
  return callOp("promote", { p_load_id: loadId, p_extra: extra, p_source: "manual", p_dry_run: false });
}

export async function unassignLoadRpc(
  loadId: string,
): Promise<{ ok: boolean; reason?: string; promoted_load?: string | null }> {
  if (!loadId) return { ok: false, reason: "bad_args" };
  return callOp("unassign", { p_load_id: loadId, p_source: "manual", p_dry_run: false });
}

// Phase-4 prep — sanctioned load/queue unlink for the vehicle-delete path.
// Resets the active + queued loads of a vehicle to PENDING via app_unassign_for_vehicle_delete
// (no promote). Caller deletes the vehicle itself AFTER this returns ok.
// D-2c: stop-set editing through the guarded lane (rows + projection, one tx).
// Routed through callOp: idempotent, offline-durable like every engine action.
export const STOPS_EDITOR_RPC = true; // kill-switch: false → editor uses the legacy array write only
export async function setLoadStopsRpc(loadId: string, stops: Array<{ city: string; cid?: string | null }>): Promise<any> {
  if (!loadId || !Array.isArray(stops)) return { ok: false, reason: "bad_args" };
  return callOp("set_stops", { p_load_id: loadId, p_stops: stops, p_source: "manual" });
}

// O2 note: deliberately NOT routed through callOp/queue — this op is the
// precursor to a vehicle DELETE. A queued replay firing later (after the
// abandoned delete) would reset the truck's loads to PENDING unsupervised.
// Precursor ops fail plainly offline; the dispatcher retries the whole delete.
export async function unassignForVehicleDeleteRpc(
  vehicleId: string,
): Promise<{ ok: boolean; reason?: string; affected_load_ids?: string[]; active_load_reset?: number; queued_loads_reset?: number }> {
  if (!vehicleId) return { ok: false, reason: "bad_args" };
  try {
    const sb = await ensureSupabase();
    if (!sb) return { ok: false, reason: "no_client" };
    const { data, error } = await sb.rpc("app_unassign_for_vehicle_delete", {
      p_vehicle_id: vehicleId, p_reason: "vehicle_delete", p_dry_run: false,
    });
    if (error) return { ok: false, reason: error.message };
    const res = (data as any) || { ok: false, reason: "no_result" };
    if (res.ok === false) console.warn("[supaSync] vehicle-delete unlink refused", res.reason);
    return res;
  } catch (e: any) { return { ok: false, reason: e?.message || "exception" }; }
}
// Source-aware: 'driver_pod' | 'dispatcher_manual' | 'dispatcher_pod_ok'.
// NOT wired to any caller yet (gwConsignee re-points here; call sites wired in 2c).
export async function markConsigneeRpc(
  loadId: string,
  ci: number,
  source: "driver_pod" | "dispatcher_manual" | "dispatcher_pod_ok",
  podPath: string | null = null,
  delivered: boolean = true,
  podOk: boolean | null = null,
  cid: string | null = null,
  deliveredAt: string | null = null,
): Promise<{ ok: boolean; reason?: string; all_done?: boolean; done_count?: number; total?: number; lstatus?: string }> {
  if (!loadId || ci == null) return { ok: false, reason: "bad_args" };
  try {
    const sb = await ensureSupabase();
    if (!sb) return { ok: false, reason: "no_client" };
    const { data, error } = await sb.rpc("app_mark_consignee", {
      p_load_id: loadId, p_ci: ci, p_source: source,
      p_pod_path: podPath, p_delivered: delivered, p_pod_ok: podOk, p_dry_run: false,
      p_cid: cid, p_delivered_at: deliveredAt,
    });
    if (error) return { ok: false, reason: error.message };
    const res = (data as any) || { ok: false, reason: "no_result" };
    if (res.ok === false) console.warn("[supaSync] mark_consignee refused", res.reason);
    return res;
  } catch (e: any) { return { ok: false, reason: e?.message || "exception" }; }
}


// These preserve the same external API that driverStore.js calls.
// They now simply call the per-row remote functions directly.
function rowsEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
}

// Fire-and-forget audit logger for deliberate vehicle edits.
// Never blocks or throws — auditing must not break sync.
async function emitVehicleAudit(
  action: string,
  entityId: string,
  vnum: string | null,
  details: any,
) {
  try {
    const sb = await ensureSupabase();
    if (!sb) return;
    await sb.rpc("app_log_vehicle_audit", {
      p_action: action,
      p_entity_id: entityId,
      p_vnum: vnum,
      p_source: "app",
      p_details: details || {},
    });
  } catch {
    /* swallow */
  }
}

// Detect deliberate vehicle changes and emit audit events.
// Only logs manual human changes — GPS/cron auto-promotes are excluded
// by passing skipAudit:true from those code paths.
function auditVehicleDiff(prev: any, next: any) {
  if (!next?.id) return;
  const id   = String(next.id);
  const vnum = next.vnum || prev?.vnum || null;

  // New vehicle created
  if (!prev) {
    emitVehicleAudit("vehicle.create", id, vnum, { vnum, vtype: next.vtype || null });
    return;
  }

  const prevStatus = prev?.vstatus ?? null;
  const newStatus  = next?.vstatus ?? null;

  // PHASE 4 (audit dedup): vehicle.status_change is NO LONGER emitted from the
  // client. The DB AFTER-UPDATE trigger logs every vstatus change in-transaction
  // regardless of calling path (engine, RPC, manual) — the client emitting too
  // produced the duplicate 'app'+'auto' pairs. Client keeps emitting only what
  // triggers can't see: create / driver / mobile changes below.

  // Driver changed
  if ((prev?.driver || null) !== (next?.driver || null)) {
    emitVehicleAudit("vehicle.driver_change", id, vnum, { from: prev?.driver || null, to: next?.driver || null });
  }

  // Mobile changed
  if ((prev?.mobile || null) !== (next?.mobile || null)) {
    emitVehicleAudit("vehicle.mobile_change", id, vnum, { from: prev?.mobile || null, to: next?.mobile || null });
  }
}

export function syncVehiclesDiff(prev: any[], next: any[], opts?: { skipAudit?: boolean }) {
  const prevMap = new Map<string, any>((prev || []).map((v) => [String(v?.id), v]));
  const nextMap = new Map<string, any>((next || []).map((v) => [String(v?.id), v]));
  const skipAudit = !!opts?.skipAudit;
  for (const [id, v] of nextMap) {
    const old = prevMap.get(id);
    if (!rowsEqual(old, v)) {
      if (!skipAudit) auditVehicleDiff(old, v);
      // F2: when we know the previous state, send only the changed fields.
      const d = old ? diffKeys(old, v) : null;
      const opts = d && (Object.keys(d.patch).length || d.removed.length)
        ? { patch: d.patch, removed: d.removed } : undefined;
      upsertVehicleRemote(v, opts).catch(() => {});
    }
  }
  for (const id of prevMap.keys()) if (!nextMap.has(id)) deleteVehicleRemote(id).catch(() => {});
}

// Fire-and-forget audit logger for deliberate load edits.
// Never blocks or throws — auditing must not break sync.
async function emitLoadAudit(
  action: string,
  entityId: string,
  lid: string | null,
  details: any,
) {
  try {
    const sb = await ensureSupabase();
    if (!sb) return;
    await sb.rpc("app_log_audit", {
      p_action: action,
      p_entity_id: entityId,
      p_lid: lid,
      p_source: "app",
      p_details: details || {},
    });
  } catch {
    /* swallow */
  }
}

function emptyStrLocal(v: any) {
  return v == null || String(v).trim() === "";
}

// Detect at most ONE deliberate change between prev and next, and emit an
// audit event for it. Called BEFORE upsertLoadRemote so we have both rows.
function auditLoadDiff(prev: any, next: any) {
  if (!next?.id) return;
  const id = String(next.id);
  const lid = next.lid || prev?.lid || null;
  if (!prev) {
    emitLoadAudit("load.create", id, lid, {
      customer: next.customer || null,
      origin: next.origin || null,
      dest: next.dest || null,
      lstatus: next.lstatus || null,
    });
    return;
  }
  const prevVehicle = prev?.vehicleId ?? null;
  const newVehicle = next?.vehicleId ?? null;
  const prevStatus = prev?.lstatus ?? null;
  const newStatus = next?.lstatus ?? null;
  const vnum = next?.vnum || prev?.vnum || null;

  if (emptyStrLocal(prevVehicle) && !emptyStrLocal(newVehicle)) {
    emitLoadAudit("load.assign", id, lid, { vehicleId: newVehicle, vnum });
  } else if (!emptyStrLocal(prevVehicle) && emptyStrLocal(newVehicle)) {
    emitLoadAudit("load.unassign", id, lid, { vehicleId: prevVehicle, vnum: prev?.vnum || null });
  }
  // PHASE 4 (audit dedup): load.status_change / load.delivered are NO LONGER
  // emitted from the client — the DB AFTER-UPDATE trigger logs every lstatus
  // change in-transaction on every path (engine, RPCs, raw), and the engine/
  // consignee RPCs additionally write their own rich DELIVER/CONSIGNEE rows.
  // Client emitting too produced the duplicate pairs. assign/unassign/create
  // above stay client-emitted (triggers don't classify those).
}

export function syncLoadsDiff(prev: any[], next: any[], opts?: { skipAudit?: boolean }) {
  const prevMap = new Map<string, any>((prev || []).map((l) => [String(l?.id), l]));
  const nextMap = new Map<string, any>((next || []).map((l) => [String(l?.id), l]));
  const skipAudit = !!opts?.skipAudit;
  for (const [id, l] of nextMap) {
    const old = prevMap.get(id);
    if (!rowsEqual(old, l)) {
      if (!skipAudit) auditLoadDiff(old, l);
      // F2: when we know the previous state, send only the changed fields.
      const d = old ? diffKeys(old, l) : null;
      const opts = d && (Object.keys(d.patch).length || d.removed.length)
        ? { patch: d.patch, removed: d.removed } : undefined;
      upsertLoadRemote(l, opts).catch(() => {});
    }
  }
  for (const id of prevMap.keys()) if (!nextMap.has(id)) deleteLoadRemote(id).catch(() => {});
}

// ---------- Other writes ----------
export async function pushPin(vnum: string, pin: string | null) {
  try {
    await setPinFn({ data: { vnum, pin } });
  } catch (e) {
    console.warn("[supaSync] pin push failed", e);
    throw e;
  }
}

export function pushPOD(pod: any) {
  addPODFn({ data: { pod: stripInlinePODImageFields(pod) } }).catch((e) => {
    console.warn("[supaSync] pod push failed", e);
    setSyncStatus("error", `POD cloud save failed: ${formatError(e)}`);
  });
}
export function pushPODUpdate(id: string, patch: any) {
  updatePODFn({ data: { id, patch: stripInlinePODImageFields(patch) } }).catch((e) => console.warn("[supaSync] pod update failed", e));
}
export function pushPODDelete(id: string) {
  deletePODFn({ data: { id } }).catch((e) => console.warn("[supaSync] pod delete failed", e));
}
export function pushSOS(sos: any) {
  addSOSFn({ data: { sos } }).catch((e) => console.warn("[supaSync] sos push failed", e));
}
export function pushDelivered(loadId: string, opts?: { finalizeConsignees?: boolean }) {
  markDeliveredFn({ data: { loadId, finalizeConsignees: opts?.finalizeConsignees } }).catch((e) => console.warn("[supaSync] delivered failed", e));
}
// pushConsigneeDelivered + markConsigneeDeliveredFn (old consignee path) retired in Phase 3.
// Driver consignee marks now go through markConsigneeRpc → app_mark_consignee unconditionally,
// with pendingConsigneeOps for offline replay.
export function pushPodOnLoad(loadId: string, pod: any) {
  attachPodToLoadFn({ data: { loadId, pod: stripInlinePODImageFields(pod) } }).catch((e) => console.warn("[supaSync] pod-on-load failed", e));
}

// ---------- Attachments ----------
export async function uploadAttachment(loadId: string, kind: string, file: File) {
  try {
    const { uploadUrl, token, path } = await getUploadUrlFn({
      data: { loadId, kind, filename: file.name },
    });
    const sb = getSupabase();
    if (sb) {
      const { error } = await sb.storage.from("load-docs").uploadToSignedUrl(path, token, file, {
        contentType: file.type || "application/octet-stream",
        upsert: true,
      });
      if (error) throw error;
    } else {
      const res = await fetch(uploadUrl, { method: "PUT", body: file, headers: { "Content-Type": file.type } });
      if (!res.ok) throw new Error(`Storage upload failed (${res.status})`);
    }
    await setAttachmentMetaFn({
      data: {
        loadId, kind, path,
        name: file.name, size: file.size, type: file.type || "application/octet-stream",
      },
    });
    return { path };
  } catch (e) {
    console.warn("[supaSync] upload attachment failed", e);
    throw e;
  }
}

export function removeAttachmentRemote(loadId: string, kind: string) {
  removeAttachmentFn({ data: { loadId, kind } }).catch((e) =>
    console.warn("[supaSync] remove attachment failed", e),
  );
}

export async function resolveSignedUrl(path: string, width?: number): Promise<string | null> {
  try {
    const { url } = await getSignedReadUrlFn({ data: width ? { path, width } : { path } });
    return url;
  } catch (e) { console.warn("[supaSync] signed url failed", e); return null; }
}

// ---------- Geofence alerts ----------
export async function upsertGeofenceAlertRemote(alert: any) {
  if (!alert?.id) return;
  const updatedAt = new Date().toISOString();
  setSyncStatus("saving", "Saving geofence alert");
  try {
    await upsertGeofenceAlertFn({ data: { alert: { ...alert, updatedAt }, updatedAt } });
    setSyncStatus("synced", `Alert saved (${alert.id})`);
    applyServerRow(K.geofenceAlerts, { ...alert, updatedAt });
  } catch (e) {
    console.warn("[supaSync] upsertGeofenceAlert failed", e);
    setSyncStatus("error", `Alert save failed: ${formatError(e)}`);
  }
}

export async function deleteGeofenceAlertRemote(id: string) {
  if (!id) return;
  try {
    await deleteGeofenceAlertFn({ data: { id: String(id) } });
    const list = lsGet<any[]>(K.geofenceAlerts, []);
    lsSet(K.geofenceAlerts, list.filter((r) => String(r?.id) !== String(id)));
    emit();
  } catch (e) {
    console.warn("[supaSync] deleteGeofenceAlert failed", e);
  }
}
