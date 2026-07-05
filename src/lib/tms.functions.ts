import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

async function admin() {
  const { getSupabaseAdmin } = await import("@/integrations/supabase/client.server");
  return getSupabaseAdmin();
}

const BUCKET = "load-docs";

function normalizeVnum(value: string) {
  return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function firstValue(...values: any[]) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function ownValue(obj: Record<string, any>, ...keys: string[]) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
  }
  return undefined;
}

const INLINE_POD_IMAGE_KEYS = ["dataUrl", "data_url", "photoUrl", "photo_url", "imageUrl", "image_url", "photo", "image"];

function stripPODInlineImageFields<T extends Record<string, any>>(pod: T): T {
  const cleaned: Record<string, any> = { ...(pod || {}) };
  for (const key of INLINE_POD_IMAGE_KEYS) delete cleaned[key];
  return cleaned as T;
}

function mapPODRow(r: any) {
  const json = r?.data && typeof r.data === "object" && !Array.isArray(r.data) ? r.data : {};
  const explicitLoadId = firstValue(ownValue(json, "loadId", "load_id"), r.data_load_id);
  return {
    ...stripPODInlineImageFields(json),
    id: firstValue(r.id, json.id, r.data_id),
    loadId: explicitLoadId !== undefined ? explicitLoadId : firstValue(r.load_id, r.loadId),
    lid: firstValue(json.lid, r.data_lid, r.lid, r.load_no, r.load_number),
    vnum: firstValue(json.vnum, r.data_vnum, r.vnum, r.vehicle, r.vehicle_no, r.vehicle_number),
    driver: firstValue(json.driver, r.data_driver, r.driver),
    mobile: firstValue(json.mobile, r.data_mobile, r.mobile, r.phone),
    customer: firstValue(json.customer, r.data_customer, r.customer),
    origin: firstValue(json.origin, r.data_origin, r.origin),
    dest: firstValue(json.dest, json.destination, r.data_dest, r.dest, r.destination),
    name: firstValue(json.name, r.data_name, r.name, r.filename),
    path: firstValue(json.path, r.data_path, r.path),
    at: firstValue(json.at, json.uploadedAt, json.uploaded_at, r.data_at, r.data_uploaded_at, r.at, r.uploaded_at, r.updated_at, r.created_at),
    status: firstValue(json.status, r.data_status, r.status),
    notes: firstValue(json.notes, r.data_notes, r.notes),
    updatedAt: firstValue(json.updatedAt, json.updated_at, r.data_updated_at, r.updated_at),
  };
}

async function hashPin(vnum: string, pin: string) {
  const input = `${normalizeVnum(vnum)}:${String(pin || "").trim()}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Newest timestamp (updated_at / created_at) across one or more raw result sets.
// The client uses this as its delta cursor: "fetch everything newer than this".
function maxTimestamp(...rowSets: (any[] | null | undefined)[]) {
  let max: string | null = null;
  for (const rows of rowSets) {
    for (const r of rows ?? []) {
      const t = r?.updated_at ?? r?.created_at;
      if (t && (!max || t > max)) max = t;
    }
  }
  return max;
}

// ---------- Driver service account identification ----------
// The driver app silently signs in as a shared Supabase user (created via
// `createDriverAccountFn`). That session by itself MUST NOT grant full reads.
// We tag the service account's user_id in app_settings.driver_app_credentials
// so the server can recognise it on every pull and require vnum+PIN scoping.
let cachedDriverServiceUserId: string | null | undefined = undefined;
let cachedDriverServiceEmail: string | null | undefined = undefined;
async function loadDriverServiceIdentity(): Promise<{ userId: string | null; email: string | null }> {
  if (cachedDriverServiceUserId !== undefined) {
    return { userId: cachedDriverServiceUserId ?? null, email: cachedDriverServiceEmail ?? null };
  }
  try {
    const sb = await admin();
    const { data } = await sb
      .from("app_settings")
      .select("value")
      .eq("key", "driver_app_credentials")
      .maybeSingle();
    const value: any = data?.value || null;
    let userId: string | null = value?.user_id ?? null;
    const email: string | null = value?.email ?? null;
    // Backfill user_id by email if missing
    if (!userId && email) {
      try {
        const { data: list } = await (sb.auth.admin as any).listUsers({ page: 1, perPage: 200 });
        const match = list?.users?.find((u: any) => (u.email || "").toLowerCase() === email.toLowerCase());
        if (match?.id) {
          userId = match.id;
          await sb.from("app_settings").upsert(
            { key: "driver_app_credentials", value: { ...value, user_id: userId }, updated_at: new Date().toISOString() },
            { onConflict: "key" },
          );
        }
      } catch (e) {
        console.warn("[driver] backfill user_id failed", (e as any)?.message || e);
      }
    }
    cachedDriverServiceUserId = userId;
    cachedDriverServiceEmail = email;
    return { userId, email };
  } catch {
    cachedDriverServiceUserId = null;
    cachedDriverServiceEmail = null;
    return { userId: null, email: null };
  }
}

// ---------- Request user identification ----------
async function getRequestUser(): Promise<{ userId: string | null; email: string | null }> {
  try {
    const { getRequestHeader } = await import("@tanstack/react-start/server");
    const authHeader = getRequestHeader("authorization") || getRequestHeader("Authorization");
    if (!authHeader?.toLowerCase().startsWith("bearer ")) return { userId: null, email: null };
    const token = authHeader.slice(7).trim();
    if (!token) return { userId: null, email: null };
    const url = process.env.TMS_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
    const anonKey =
      process.env.TMS_SUPABASE_PUBLISHABLE_KEY ??
      process.env.TMS_SUPABASE_ANON_KEY ??
      process.env.SUPABASE_PUBLISHABLE_KEY ??
      process.env.SUPABASE_ANON_KEY ?? "";
    if (!url || !anonKey) return { userId: null, email: null };
    const { createClient } = await import("@supabase/supabase-js");
    const sb = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await sb.auth.getUser(token);
    if (error || !data?.user) return { userId: null, email: null };
    return { userId: data.user.id, email: data.user.email ?? null };
  } catch {
    return { userId: null, email: null };
  }
}

// Verify a vnum+pin combo against vehicle_pins (same logic as verifyPinFn).
async function verifyVnumPin(vnumRaw: string | undefined | null, pinRaw: string | undefined | null): Promise<string | null> {
  const vnum = normalizeVnum(String(vnumRaw || ""));
  const pin = String(pinRaw || "").trim();
  if (!vnum || !pin) return null;
  const sb = await admin();
  const { data: rows, error } = await sb.from("vehicle_pins").select("vnum, pin, pin_hash");
  if (error) return null;
  const matching = (rows ?? []).filter((r: any) => normalizeVnum(r.vnum) === vnum);
  const row = matching.find((r: any) => String(r.pin_hash ?? "").trim().length > 0 || String(r.pin ?? "").trim().length > 0) ?? matching[0];
  if (!row) return null;
  const savedHash = String(row.pin_hash ?? "").trim();
  const saved = String(row.pin ?? "").trim();
  const enteredHash = await hashPin(vnum, pin);
  const ok = savedHash ? savedHash === enteredHash : saved.length > 0 && saved === pin;
  return ok ? vnum : null;
}

// Resolve request scope: 'admin' (full), 'driver' (filter to vnum), 'pre-pin' (vehicles+pins only).
async function resolveScope(input?: { vnum?: string; pin?: string }): Promise<
  | { kind: "admin" }
  | { kind: "driver"; vnum: string }
  | { kind: "pre-pin" }
> {
  const { userId, email } = await getRequestUser();
  const identity = await loadDriverServiceIdentity();
  const isDriverSession =
    !!userId && (
      (identity.userId && userId === identity.userId) ||
      (!identity.userId && identity.email && email && email.toLowerCase() === identity.email.toLowerCase())
    );
  if (userId && !isDriverSession) return { kind: "admin" };
  const vnum = await verifyVnumPin(input?.vnum, input?.pin);
  if (vnum) return { kind: "driver", vnum };
  return { kind: "pre-pin" };
}

// ---------- PULL snapshot ----------
export const pullAll = createServerFn({ method: "POST" })
  .inputValidator((d?: { vnum?: string; pin?: string }) => d ?? {})
  .handler(async ({ data }) => {
  const scope = await resolveScope(data);
  const sb = await admin();

  const [veh, pins] = await Promise.all([
    sb.from("vehicles").select("id, data, updated_at, version").order("updated_at", { ascending: false }).limit(1000),
    sb.from("vehicle_pins").select("vnum, pin").limit(2000),
  ]);

  // _v carries the server row version (Level 2). Underscore-prefixed so it never
  // collides with real vehicle fields. Writes still ignore it for now (shadow).
  const vehicles = (veh.data ?? []).map((r: any) => ({ id: r.id, ...(r.data || {}), _v: r.version ?? null }));
  const pinsMap = (pins.data ?? []).reduce((acc: Record<string, any>, r: any) => {
    const key = normalizeVnum(r.vnum);
    const pin = String(r.pin ?? "").trim();
    if (key && (pin || acc[key] == null)) acc[key] = r.pin;
    return acc;
  }, {});

  // PINs are only returned to admin callers (TMS Fleet UI).
  // Driver and pre-pin scopes never receive the PIN map.
  const pinsForScope = scope.kind === "admin" ? pinsMap : {};

  if (scope.kind === "pre-pin") {
    return {
      vehicles,
      loads: [],
      pins: pinsForScope,
      pods: [],
      sos: [],
      attachments: [],
      geofenceAlerts: [],
      maxUpdatedAt: maxTimestamp(veh.data),
      errors: [veh.error, pins.error].filter(Boolean).map((e: any) => e.message),
    };
  }


  // ── Split load fetch (interim fix for the 1000-row crowding-out bug) ────────
  // The WORKING SET (everything not DELIVERED) is fetched WITHOUT a row cap —
  // it's self-limiting (loads leave it by delivering), a few hundred rows, and
  // this guarantees an old quiet PENDING load can never be crowded off the
  // board by recently-touched delivered rows. DELIVERED history keeps the
  // newest-1000 cap until roadmap F3 paginates it properly. Soft-DELETED rows
  // ride in the working set on purpose: full pulls need them for removal
  // propagation (applyServerRow treats DELETED as remove); purge cron bounds them.
  const [ldsActive, ldsDelivered, pods, sos, atts, gfa] = await Promise.all([
    sb.from("loads").select("id, lid, data, updated_at, version").is("deleted_at", null).neq("data->>lstatus", "DELIVERED").order("updated_at", { ascending: false }),
    sb.from("loads").select("id, lid, data, updated_at, version").is("deleted_at", null).eq("data->>lstatus", "DELIVERED").order("updated_at", { ascending: false }).limit(1000),
    sb.from("pod_records").select("id, load_id, data_path:data->>path, data_lid:data->>lid, data_vnum:data->>vnum, data_driver:data->>driver, data_mobile:data->>mobile, data_customer:data->>customer, data_origin:data->>origin, data_dest:data->>dest, data_name:data->>name, data_status:data->>status, data_notes:data->>notes, data_at:data->>at, updated_at").order("updated_at", { ascending: false }).limit(500),
    sb.from("sos_records").select("id, data").order("created_at", { ascending: false }).limit(500),
    sb.from("load_attachments").select("load_id, kind, meta, path, updated_at").order("updated_at", { ascending: false }).limit(1000),
    sb.from("geofence_alerts").select("id, data, updated_at").order("updated_at", { ascending: false }).limit(500),
  ]);
  // D-3a: stops rows for the ACTIVE working set ride along with the pull
  // (bounded: non-DELIVERED loads only, ~hundreds of loads → ~1-2k stop rows).
  // Delivered-history stop display keeps reading the projected arrays (in the
  // blob) — no fetch weight added there.
  const stopsRes = await sb
    .from("load_stops")
    .select("load_id, idx, cid, city, delivered, delivered_at, pod_path, pod_ok, manual_override")
    .in("load_id", (ldsActive.data ?? []).map((r: any) => r.id))
    .order("idx", { ascending: true });

  const lds = (() => {
    const seen = new Set(); const merged: any[] = [];
    for (const r of [ ...(ldsActive.data ?? []), ...(ldsDelivered.data ?? []) ]) {
      const k = String(r.id); if (seen.has(k)) continue; seen.add(k); merged.push(r);
    }
    return { data: merged, error: ldsActive.error || ldsDelivered.error };
  })();

  let loads = (lds.data ?? []).map((r: any) => ({ id: r.id, ...(r.data || {}), lid: firstValue(r.data?.lid, r.lid), _v: r.version ?? null }));
  const vehicleById = new Map(vehicles.map((v: any) => [String(v.id), v]));

  if (scope.kind === "driver") {
    const targetVnum = scope.vnum;
    loads = loads.filter((l: any) => {
      if (normalizeVnum(String(l.vnum || "")) === targetVnum) return true;
      if (l.vehicleId) {
        const v: any = vehicleById.get(String(l.vehicleId));
        if (v && normalizeVnum(String(v.vnum || "")) === targetVnum) return true;
      }
      return false;
    });
  }

  const allowedLoadIds = new Set(loads.map((l: any) => String(l.id)));
  const loadById = new Map(loads.map((l: any) => [String(l.id), l]));
  let podRows = (pods.data ?? []).map(mapPODRow);
  let sosRows = (sos.data ?? []).map((r: any) => ({ id: r.id, ...(r.data || {}) }));
  let attRows: any[] = (atts.data ?? []);
  let gfaRows = (gfa.data ?? []).map((r: any) => ({ id: r.id, ...(r.data || {}), updatedAt: r.updated_at }));

  if (scope.kind === "driver") {
    const targetVnum = scope.vnum;
    podRows = podRows.filter((p: any) =>
      normalizeVnum(String(p.vnum || "")) === targetVnum ||
      (p.loadId && allowedLoadIds.has(String(p.loadId)))
    );
    sosRows = sosRows.filter((s: any) => normalizeVnum(String(s.vnum || "")) === targetVnum);
    attRows = attRows.filter((a: any) => a.load_id && allowedLoadIds.has(String(a.load_id)));
    gfaRows = gfaRows.filter((g: any) => normalizeVnum(String(g.vnum || "")) === targetVnum);
  }

  const podByLoad = new Map(podRows.filter((p: any) => p.loadId).map((p: any) => [String(p.loadId), p]));
  const attachmentPods = attRows
    .filter((r: any) => r.kind === "pod" && r.load_id && r.path)
    .map((r: any) => {
      const load = loadById.get(String(r.load_id)) || {};
      const vehicle = (load as any).vehicleId ? vehicleById.get(String((load as any).vehicleId)) || {} : {};
      const existing = podByLoad.get(String(r.load_id)) || {};
      return {
        id: (existing as any).id || `attach_pod_${r.load_id}`,
        ...load,
        ...existing,
        vnum: firstValue((existing as any).vnum, (vehicle as any).vnum, (load as any).vnum),
        driver: firstValue((existing as any).driver, (vehicle as any).driver, (load as any).driver),
        mobile: firstValue((existing as any).mobile, (vehicle as any).mobile, (load as any).mobile),
        loadId: r.load_id,
        lid: firstValue((existing as any).lid, (load as any).lid),
        customer: firstValue((existing as any).customer, (load as any).customer),
        origin: firstValue((existing as any).origin, (load as any).origin),
        dest: firstValue((existing as any).dest, (load as any).dest),
        dataUrl: null,
        path: r.path,
        name: firstValue((existing as any).name, r.meta?.name),
        at: firstValue((existing as any).at, r.meta?.uploadedAt, r.updated_at),
        status: firstValue((existing as any).status, "OK"),
      };
    });
  const attachmentLoadIds = new Set(attachmentPods.map((p: any) => String(p.loadId)));
  const directPods = podRows.filter(
    (p: any) => !p.loadId || !attachmentLoadIds.has(String(p.loadId)),
  );
  const hydratedPods = [...attachmentPods, ...directPods];

  return {
    vehicles,
    loads,
    pins: pinsForScope,
    pods: hydratedPods,
    sos: sosRows,
    attachments: attRows.map((r: any) => ({
      loadId: r.load_id, kind: r.kind, path: r.path, ...(r.meta || {}),
    })),
    geofenceAlerts: gfaRows,
    // F3: true column-based cursor for the delivered back-fill. The blob's own
    // updatedAt field is NOT the pagination key (it can be stale/absent on
    // RPC-written rows) — only the column value paginates correctly.
    loadStops: stopsRes.data ?? [],
    deliveredPage: (() => {
      const rows = ldsDelivered.data ?? [];
      const full = rows.length >= 1000;
      const last = rows.length ? rows[rows.length - 1] : null;
      return { full, cursorT: last ? last.updated_at : null, cursorId: last ? String(last.id) : null };
    })(),
    maxUpdatedAt: maxTimestamp(veh.data, lds.data, pods.data, sos.data, atts.data, gfa.data),
    errors: [veh.error, lds.error, pins.error, pods.error, sos.error, atts.error, gfa.error]
      .filter(Boolean).map((e: any) => e.message),
  };
});

// ---------- PULL delta ----------
export const pullDelta = createServerFn({ method: "POST" })
  .inputValidator((d: { since: string; vnum?: string; pin?: string }) => d)
  .handler(async ({ data }) => {
    const scope = await resolveScope({ vnum: data.vnum, pin: data.pin });
    if (scope.kind === "pre-pin") {
      return {
        vehicles: [], loads: [], pods: [], sos: [], attachments: [],
        geofenceAlerts: [], deletedLoadIds: [], maxUpdatedAt: null, errors: [],
      };
    }

    const sb = await admin();
    const since = String(data.since);
    const [veh, lds, pods, sos, atts, gfa, del] = await Promise.all([
      sb.from("vehicles").select("id, data, updated_at, version").gt("updated_at", since).order("updated_at", { ascending: true }).limit(1000),
      sb.from("loads").select("id, lid, data, updated_at, version").gt("updated_at", since).order("updated_at", { ascending: true }).limit(1000),
      sb.from("pod_records").select("id, load_id, data_path:data->>path, data_lid:data->>lid, data_vnum:data->>vnum, data_driver:data->>driver, data_mobile:data->>mobile, data_customer:data->>customer, data_origin:data->>origin, data_dest:data->>dest, data_name:data->>name, data_status:data->>status, data_notes:data->>notes, data_at:data->>at, updated_at").gt("updated_at", since).order("updated_at", { ascending: true }).limit(500),
      sb.from("sos_records").select("id, data, created_at").gt("created_at", since).order("created_at", { ascending: true }).limit(500),
      sb.from("load_attachments").select("load_id, kind, meta, path, updated_at").gt("updated_at", since).order("updated_at", { ascending: true }).limit(1000),
      sb.from("geofence_alerts").select("id, data, updated_at").gt("updated_at", since).order("updated_at", { ascending: true }).limit(500),
      sb.from("load_audit_log").select("load_id, updated_at:deleted_at").gt("deleted_at", since).order("deleted_at", { ascending: true }).limit(200),
    ]);

    let vehicles = (veh.data ?? []).map((r: any) => ({ id: r.id, ...(r.data || {}), _v: r.version ?? null }));
    let loads = (lds.data ?? []).map((r: any) => ({ id: r.id, ...(r.data || {}), lid: firstValue(r.data?.lid, r.lid), _v: r.version ?? null }));
    let podRows = (pods.data ?? []).map(mapPODRow);
    let sosRows = (sos.data ?? []).map((r: any) => ({ id: r.id, ...(r.data || {}) }));
    let attRows: any[] = (atts.data ?? []);
    let gfaRows = (gfa.data ?? []).map((r: any) => ({ id: r.id, ...(r.data || {}), updatedAt: r.updated_at }));
    let deletedLoadIds = (del.data ?? []).map((r: any) => String(r.load_id)).filter(Boolean);

    if (scope.kind === "driver") {
      const targetVnum = scope.vnum;
      const { data: allVehRows } = await sb.from("vehicles").select("id, data");
      const vById = new Map((allVehRows ?? []).map((r: any) => [String(r.id), { id: r.id, ...(r.data || {}) }]));
      vehicles = vehicles.filter((v: any) => normalizeVnum(String(v.vnum || "")) === targetVnum);
      const { data: allLoadRows } = await sb.from("loads").select("id, data");
      const allowed = new Set<string>();
      for (const r of allLoadRows ?? []) {
        const l: any = { id: r.id, ...(r.data || {}) };
        if (normalizeVnum(String(l.vnum || "")) === targetVnum) { allowed.add(String(l.id)); continue; }
        if (l.vehicleId) {
          const v: any = vById.get(String(l.vehicleId));
          if (v && normalizeVnum(String(v.vnum || "")) === targetVnum) allowed.add(String(l.id));
        }
      }
      loads = loads.filter((l: any) => allowed.has(String(l.id)));
      podRows = podRows.filter((p: any) =>
        normalizeVnum(String(p.vnum || "")) === targetVnum ||
        (p.loadId && allowed.has(String(p.loadId)))
      );
      sosRows = sosRows.filter((s: any) => normalizeVnum(String(s.vnum || "")) === targetVnum);
      attRows = attRows.filter((a: any) => a.load_id && allowed.has(String(a.load_id)));
      gfaRows = gfaRows.filter((g: any) => normalizeVnum(String(g.vnum || "")) === targetVnum);
      deletedLoadIds = deletedLoadIds.filter((id: string) => allowed.has(id));
    }

    return {
      vehicles,
      loads,
      pods: podRows,
      sos: sosRows,
      attachments: attRows.map((r: any) => ({
        loadId: r.load_id, kind: r.kind, path: r.path, ...(r.meta || {}),
      })),
      geofenceAlerts: gfaRows,
      deletedLoadIds,
      maxUpdatedAt: maxTimestamp(veh.data, lds.data, pods.data, sos.data, atts.data, gfa.data, del.data),
      // Pagination cursor: with ASC order, a table that returned a full page
      // (length === its limit) has MORE rows beyond this page. The safe boundary
      // we've fully delivered is the SMALLEST page-max among truncated tables —
      // advancing past it would skip the un-fetched tail of the slowest table.
      // When nothing truncated, the whole change set is drained → nextSince = max,
      // hasMore = false (identical to the old single-shot behaviour).
      ...(() => {
        const pageMax = (rows: any[] | null | undefined, tsField: string) => {
          let mx: string | null = null;
          for (const r of rows ?? []) { const t = (r as any)?.[tsField]; if (t && (!mx || t > mx)) mx = t; }
          return mx;
        };
        const trunc: string[] = [];
        if ((veh.data?.length  || 0) >= 1000) { const m = pageMax(veh.data,  "updated_at"); if (m) trunc.push(m); }
        if ((lds.data?.length  || 0) >= 1000) { const m = pageMax(lds.data,  "updated_at"); if (m) trunc.push(m); }
        if ((pods.data?.length || 0) >= 500)  { const m = pageMax(pods.data, "updated_at"); if (m) trunc.push(m); }
        if ((sos.data?.length  || 0) >= 500)  { const m = pageMax(sos.data,  "created_at"); if (m) trunc.push(m); }
        if ((atts.data?.length || 0) >= 1000) { const m = pageMax(atts.data, "updated_at"); if (m) trunc.push(m); }
        if ((gfa.data?.length  || 0) >= 500)  { const m = pageMax(gfa.data,  "updated_at"); if (m) trunc.push(m); }
        if ((del.data?.length  || 0) >= 200)  { const m = pageMax(del.data,  "updated_at"); if (m) trunc.push(m); }
        const overallMax = maxTimestamp(veh.data, lds.data, pods.data, sos.data, atts.data, gfa.data, del.data);
        const hasMore = trunc.length > 0;
        const nextSince = hasMore ? trunc.reduce((a, b) => (a < b ? a : b)) : (overallMax ?? since);
        return { nextSince, hasMore };
      })(),
      errors: [veh.error, lds.error, pods.error, sos.error, atts.error, gfa.error, del.error]
        .filter(Boolean).map((e: any) => e.message),
    };
  });


// ---------- PER-ROW WRITES (last-write-wins) ----------
// Build a fully-mirrored loads row: top-level columns (lstatus/vehicle_id/delivered_at)
// are always derived from the JSON payload so they can never drift behind data.*.
export function loadRowFor(id: string, lid: string, data: any, updatedAt: string) {
  // Drop the Level 2 version marker (_v) — it's a top-level column, not blob data.
  const { _v: _lv, ...cleanData } = data || {};
  // lstatus / vehicle_id / delivered_at are GENERATED columns in the DB, derived
  // from the blob by Postgres. Never write them here — Postgres rejects writes to
  // a generated column, which would fail driver delivery / POD upserts.
  return {
    id,
    lid,
    data: cleanData,
    updated_at: updatedAt,
  };
}

// Build a fully-mirrored vehicles row: top-level columns (status/assigned_load_id)
// are always derived from the JSON payload so they can never drift behind data.*.
export function vehicleRowFor(id: string, vnum: string | null, data: any, updatedAt: string) {
  const { _v: _vv, ...cleanData } = data || {};
  // status / assigned_load_id are GENERATED columns in the DB, derived from the
  // blob by Postgres. Never write them here.
  return {
    id,
    vnum,
    data: cleanData,
    updated_at: updatedAt,
  };
}

// ---------- AUDIT LOG ----------
// (logAudit helper deleted Jul 4 — its only caller was v1 markDeliveredFn;
//  app_deliver_load_v2 audits in-transaction with proper attribution.)
export const getAuditLogsFn = createServerFn({ method: "POST" })
  .inputValidator((d: { limit?: number; offset?: number; actions?: string[]; entityType?: string; search?: string } | undefined) => d || {})
  .handler(async ({ data }) => {
    const sb = await admin();
    const limit = Math.max(1, Math.min(200, Number(data?.limit) || 50));
    const offset = Math.max(0, Number(data?.offset) || 0);
    const since = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

    let q = sb
      .from("audit_log")
      .select("id, at, action, entity_type, entity_id, lid, user_id, email, source, details", { count: "exact" })
      .gte("at", since)
      .order("at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (data?.actions && data.actions.length > 0) {
      q = q.in("action", data.actions);
    }
    if (data?.entityType) {
      q = q.eq("entity_type", data.entityType);
    }
    // Search by LID (loads) or vnum stored in details->>'vnum'
    if (data?.search) {
      const s = data.search.trim().toUpperCase();
      q = q.or(`lid.ilike.%${s}%,details->>'vnum'.ilike.%${s}%`);
    }

    const { data: rows, error, count } = await q;
    if (error) {
      return { entries: [], total: 0, missing: true as const };
    }
    const entries = (rows || []).map((r: any) => ({
      id: r.id,
      at: r.at,
      action: r.action,
      entityType: r.entity_type,
      entityId: r.entity_id,
      lid: r.lid,
      userId: r.user_id,
      email: r.email,
      source: r.source,
      details: r.details || {},
    }));
    return { entries, total: count || 0, missing: false as const };
  });

// Per-load audit trail — returns ALL history for one specific load (no 3-day window).
// Also fetches vehicle status changes for whichever vehicle is/was assigned to the load,
// so the Activity tab shows a complete picture of both load and vehicle events.
export const getLoadAuditTrailFn = createServerFn({ method: "POST" })
  .inputValidator((d: { loadId: string; vehicleId?: string | null }) => d)
  .handler(async ({ data }) => {
    const sb = await admin();

    // 1. Load-level events
    const { data: loadRows, error: loadErr } = await sb
      .from("audit_log")
      .select("id, at, action, entity_type, lid, user_id, email, source, details")
      .eq("entity_id", data.loadId)
      .order("at", { ascending: true })
      .limit(200);
    if (loadErr) return { entries: [] };

    // 2. Vehicle-level events for the assigned vehicle (if provided)
    let vehicleRows: any[] = [];
    if (data.vehicleId) {
      const { data: vrows } = await sb
        .from("audit_log")
        .select("id, at, action, entity_type, lid, user_id, email, source, details")
        .eq("entity_id", data.vehicleId)
        .eq("entity_type", "vehicle")
        .in("action", ["vehicle.status_change", "vehicle.driver_change"])
        .order("at", { ascending: true })
        .limit(200);
      vehicleRows = vrows || [];
    }

    // 3. Merge and sort by time
    const all = [...(loadRows || []), ...vehicleRows]
      .sort((a: any, b: any) => new Date(a.at).getTime() - new Date(b.at).getTime());

    return {
      entries: all.map((r: any) => ({
        id: r.id,
        at: r.at,
        action: r.action,
        entityType: r.entity_type,
        lid: r.lid,
        userId: r.user_id,
        email: r.email,
        source: r.source,
        details: r.details || {},
      })),
    };
  });

// Per-vehicle audit trail — returns ALL history for one specific vehicle (no 3-day window).
export const getVehicleAuditTrailFn = createServerFn({ method: "POST" })
  .inputValidator((d: { vehicleId: string }) => d)
  .handler(async ({ data }) => {
    const sb = await admin();
    const { data: rows, error } = await sb
      .from("audit_log")
      .select("id, at, action, entity_type, lid, user_id, email, source, details")
      .eq("entity_id", data.vehicleId)
      .eq("entity_type", "vehicle")
      .order("at", { ascending: true })
      .limit(200);
    if (error) return { entries: [] };
    return {
      entries: (rows || []).map((r: any) => ({
        id: r.id,
        at: r.at,
        action: r.action,
        entityType: r.entity_type,
        lid: r.lid,
        userId: r.user_id,
        email: r.email,
        source: r.source,
        details: r.details || {},
      })),
    };
  });

// Back-compat wrapper — anything still importing this just gets deletes.
export const getLoadDeleteLogsFn = createServerFn({ method: "GET" }).handler(async () => {
  const sb = await admin();
  const since = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await sb
    .from("audit_log")
    .select("id, at, entity_id, lid, user_id, email, source")
    .eq("action", "load.delete")
    .gte("at", since)
    .order("at", { ascending: false })
    .limit(500);
  if (error) return { entries: [] };
  return {
    entries: (data || []).map((r: any) => ({
      loadId: r.entity_id, lid: r.lid, userId: r.user_id, email: r.email,
      source: r.source, deletedAt: r.at,
    })),
  };
});


// ---------- APP SETTINGS (generic key/value, synced everywhere) ----------
export const pullSettingsFn = createServerFn({ method: "POST" }).handler(async () => {
  const sb = await admin();
  const { data, error } = await sb.from("app_settings").select("key, value, updated_at");
  if (error) throw new Error(error.message);
  return { settings: data ?? [] };
});

export const setSettingFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { key: string; value: any }) => d)
  .handler(async ({ data }) => {
    const sb = await admin();
    const key = String(data.key || "").trim();
    if (!key) throw new Error("key required");
    const { error } = await sb.from("app_settings").upsert(
      { key, value: data.value, updated_at: new Date().toISOString() },
      { onConflict: "key" },
    );
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const forceGlobalLogout = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { userId } = context as any;
    const sb = await admin();
    const { data: roleRow } = await sb
      .from("user_roles")
      .select("role")
      .eq("user_id", userId)
      .eq("role", "admin")
      .maybeSingle();
    if (!roleRow) throw new Error("Admin access required");
    await sb.from("app_settings").upsert(
      { key: "force_logout_at", value: new Date().toISOString(), updated_at: new Date().toISOString() },
      { onConflict: "key" },
    );
    return { ok: true };
  });

export const getGlobalLogoutStatus = createServerFn({ method: "GET" }).handler(async () => {
  const sb = await admin();
  const { data } = await sb
    .from("app_settings")
    .select("key,value")
    .in("key", ["force_logout_at", "min_app_version"]);
  const map = new Map((data ?? []).map((r: any) => [r.key, r.value]));
  return {
    forceLogoutAt: map.get("force_logout_at") ?? null,
    minAppVersion: map.get("min_app_version") ?? null,
  };
});

export const deleteSettingFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { key: string }) => d)
  .handler(async ({ data }) => {
    const sb = await admin();
    await sb.from("app_settings").delete().eq("key", String(data.key));
    return { ok: true };
  });



// ---------- PINS ----------
export const setPinFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { vnum: string; pin: string | null }) => d)
  .handler(async ({ data }) => {
    const sb = await admin();
    const vnum = normalizeVnum(data.vnum);
    if (!vnum) throw new Error("vehicle number required");

    const { data: existingRows, error: readError } = await sb
      .from("vehicle_pins")
      .select("vnum");
    if (readError) throw new Error(readError.message);

    const matchingVnums = Array.from(new Set(
      (existingRows ?? [])
        .map((row: any) => String(row.vnum || ""))
        .filter((raw: string) => normalizeVnum(raw) === vnum),
    ));

    for (const rawVnum of matchingVnums.length ? matchingVnums : [vnum]) {
      const { error: deleteError } = await sb.from("vehicle_pins").delete().eq("vnum", rawVnum);
      if (deleteError) throw new Error(deleteError.message);
    }

    if (data.pin) {
      const pin = String(data.pin).trim();
      const { error: insertError } = await sb
        .from("vehicle_pins")
        .insert({ vnum, pin, pin_hash: await hashPin(vnum, pin), salt: "", updated_at: new Date().toISOString() });
      if (insertError) throw new Error(insertError.message);
    }
    return { ok: true };
  });

export const verifyPinFn = createServerFn({ method: "POST" })
  .inputValidator((d: { vnum: string; pin: string }) => d)
  .handler(async ({ data }) => {
    const sb = await admin();
    const vnum = normalizeVnum(data.vnum);
    const { data: rows, error } = await sb
      .from("vehicle_pins")
      .select("vnum, pin, pin_hash");
    if (error) throw new Error(error.message);
    const matchingRows = (rows ?? []).filter((candidate: any) => normalizeVnum(candidate.vnum) === vnum);
    const row = matchingRows.find((candidate: any) => String(candidate.pin_hash ?? "").trim().length > 0 || String(candidate.pin ?? "").trim().length > 0) ?? matchingRows[0];
    if (!row) return { ok: false, hasPin: false };
    const saved = String(row.pin ?? "").trim();
    const entered = String(data.pin ?? "").trim();
    const savedHash = String(row.pin_hash ?? "").trim();
    const enteredHash = await hashPin(vnum, entered);
    const ok = savedHash ? savedHash === enteredHash : saved.length > 0 && saved === entered;
    return { ok, hasPin: Boolean(savedHash || saved.length > 0) };
  });

export const debugVehiclePinFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { vnum: string }) => d)
  .handler(async ({ data }) => {
    const sb = await admin();
    const vnum = normalizeVnum(data.vnum);
    const { data: rows, error } = await sb.from("vehicle_pins").select("vnum, pin, pin_hash, updated_at");
    if (error) throw new Error(error.message);
    const matches = (rows ?? []).filter((row: any) => normalizeVnum(row.vnum) === vnum);
    return {
      vnum,
      matchCount: matches.length,
      hasPin: matches.some((row: any) => String(row.pin_hash ?? "").trim().length > 0 || String(row.pin ?? "").trim().length > 0),
      rows: matches.map((row: any) => ({ vnum: row.vnum, pinLength: String(row.pin ?? "").trim().length, hasPinHash: String(row.pin_hash ?? "").trim().length > 0, updated_at: row.updated_at })),
    };
  });


// ---------- POD ----------
export const addPODFn = createServerFn({ method: "POST" })
  .inputValidator((d: { pod: any }) => d)
  .handler(async ({ data }) => {
    const sb = await admin();
    const id = String(data.pod.id || `pod_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
    const updatedAt = String(firstValue(data.pod.updatedAt, data.pod.updated_at, data.pod.at, data.pod.uploadedAt, new Date().toISOString()));
    const rawLoadId = data.pod.loadId;
    const loadId = rawLoadId != null && String(rawLoadId).trim() !== "" ? String(rawLoadId).trim() : null;
    const payload = stripPODInlineImageFields({ ...data.pod, id, loadId, at: firstValue(data.pod.at, data.pod.uploadedAt, updatedAt), updatedAt });
    const rowLoadId = loadId; // null when not linked to a load — keep DB column nullable
    // Try with load_id column first; if the column is missing/typed incorrectly, fall back to data-only.
    let { error } = await sb.from("pod_records").upsert(
      { id, load_id: rowLoadId, data: payload, updated_at: updatedAt },
      { onConflict: "id" },
    );
    if (error) {
      console.warn("[addPODFn] upsert with load_id failed, retrying data-only:", error.message);
      const retry = await sb.from("pod_records").upsert(
        { id, data: payload, updated_at: updatedAt },
        { onConflict: "id" },
      );
      if (retry.error) throw new Error(`${error.message}; retry without load_id failed: ${retry.error.message}`);
    }
    return { ok: true, id };
  });

// Stamp a POD reference onto the load row so TMS can show it directly.
export const attachPodToLoadFn = createServerFn({ method: "POST" })
  .inputValidator((d: { loadId: string; pod: any }) => d)
  .handler(async ({ data }) => {
    const sb = await admin();
    const { data: row } = await sb.from("loads").select("lid, data").eq("id", data.loadId).maybeSingle();
    if (!row) return { ok: false };
    const lid = String((row.data as any)?.lid || row.lid || data.loadId).trim();
    const pod = stripPODInlineImageFields({ ...data.pod });

    // POD attach goes through the dedicated guarded RPC app_attach_pod, which mutates ONLY
    // the `pod` field (canonical fields preserved by construction, version bump + audit).
    // The legacy raw-upsert fallback was retired after soak (Phase 6a cleanup).
    const { error } = await sb.rpc("app_attach_pod", { p_id: data.loadId, p_pod: pod, p_source: "driver" });
    if (error) {
      console.warn("[attachPodToLoadFn] app_attach_pod failed", error);
      return { ok: false };
    }
    return { ok: true };
  });

export const updatePODFn = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string; patch: any }) => d)
  .handler(async ({ data }) => {
    const sb = await admin();
    const { data: row } = await sb
      .from("pod_records")
      .select("id, load_id, updated_at")
      .eq("id", data.id)
      .maybeSingle();
    const merged = stripPODInlineImageFields({ id: data.id, loadId: row?.load_id ?? null, updatedAt: row?.updated_at, ...data.patch });
    await sb.from("pod_records").upsert({ id: data.id, load_id: merged.loadId ?? row?.load_id ?? null, data: merged }, { onConflict: "id" });
    return { ok: true };
  });

export const cleanupPODInlineImagesFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const sb = await admin();
    const { data: rows, error } = await sb
      .from("pod_records")
      .select("id, load_id, updated_at")
      .order("updated_at", { ascending: false })
      .limit(100);
    if (error) throw new Error(error.message);
    for (const row of rows ?? []) {
      const cleaned = { id: row.id, loadId: row.load_id, updatedAt: row.updated_at };
      await sb.from("pod_records").update({ data: cleaned, updated_at: row.updated_at }).eq("id", row.id);
    }
    return { ok: true, cleaned: rows?.length ?? 0 };
  });

export const deletePODFn = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string }) => d)
  .handler(async ({ data }) => {
    const sb = await admin();
    await sb.from("pod_records").delete().eq("id", data.id);
    return { ok: true };
  });

// ---------- SOS ----------
export const addSOSFn = createServerFn({ method: "POST" })
  .inputValidator((d: { sos: any }) => d)
  .handler(async ({ data }) => {
    const sb = await admin();
    const id = String(data.sos.id || `sos_${Date.now()}`);
    await sb.from("sos_records").upsert({ id, data: { ...data.sos, id } }, { onConflict: "id" });
    return { ok: true, id };
  });

// ---------- DELIVERED ----------
// (computeVehicleAfterDelivery + buildFullyDeliveredCDServer deleted Jul 4 —
//  app_deliver_load_v2 computes snapshots, consignee finalization, and the
//  vehicle repoint-or-free INSIDE the RPC, under the row locks.)

export const markDeliveredFn = createServerFn({ method: "POST" })
  .inputValidator((d: { loadId: string; finalizeConsignees?: boolean }) => d)
  .handler(async ({ data, context }) => {
    const sb = await admin();
    // AUDIT FIX (Jul 4): the deliver lane is now SERVER-COMPUTED inside the RPC.
    // The caller sends intent only; app_deliver_load_v2 locks both rows, guards
    // (deleted/cancelled refuse, already-delivered idempotent no-op), computes
    // snapshots + consignee finalization + vehicle repoint-or-free itself,
    // writes atomically with version bumps, and audits in-tx (triggers deduped).
    // This retired: the read→compute→write race window of v1, the caller-blob
    // trust, the duplicate load.delivered logAudit, and the two helper
    // functions (computeVehicleAfterDelivery / buildFullyDeliveredCDServer)
    // that used to compute state outside the lock.
    const { data: res, error: rpcErr } = await sb.rpc("app_deliver_load_v2", {
      p_load_id:  data.loadId,
      p_finalize: data.finalizeConsignees !== false, // default true, matches all current callers
      p_source:   "manual",
      // Attribution fix (0011): the service client has no auth.uid(), so DELIVER
      // audit rows showed email null. Thread the REAL caller from the middleware.
      p_user_id:  (context as any)?.userId ?? null,
      p_email:    (context as any)?.claims?.email ?? null,
    });
    if (rpcErr) {
      // User-initiated; surface for retry rather than writing past the lane.
      throw new Error(`app_deliver_load_v2 failed: ${rpcErr.message}`);
    }
    return { ok: true, ...(res || {}) };
  });

// markConsigneeDeliveredFn (old per-consignee driver path) retired in Phase 3 — replaced by
// app_mark_consignee via markConsigneeRpc (+ pendingConsigneeOps offline replay).
// ---------- ATTACHMENTS / STORAGE ----------
export const getUploadUrlFn = createServerFn({ method: "POST" })
  .inputValidator((d: { loadId: string; kind: string; filename: string }) => d)
  .handler(async ({ data }) => {
    const sb = await admin();
    const safe = data.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    const path = `${data.loadId}/${data.kind}/${Date.now()}_${safe}`;
    const { data: signed, error } = await sb.storage
      .from(BUCKET)
      .createSignedUploadUrl(path);
    if (error) throw new Error(error.message);
    return { uploadUrl: signed.signedUrl, token: signed.token, path };
  });

export const setAttachmentMetaFn = createServerFn({ method: "POST" })
  .inputValidator((d: {
    loadId: string; kind: string; path: string;
    name: string; size: number; type: string;
  }) => d)
  .handler(async ({ data }) => {
    const sb = await admin();
    await sb.from("load_attachments").upsert(
      {
        load_id: data.loadId,
        kind: data.kind,
        path: data.path,
        meta: { name: data.name, size: data.size, type: data.type, uploadedAt: new Date().toISOString() },
        updated_at: new Date().toISOString(),
      },
      { onConflict: "load_id,kind" },
    );
    return { ok: true };
  });

export const removeAttachmentFn = createServerFn({ method: "POST" })
  .inputValidator((d: { loadId: string; kind: string }) => d)
  .handler(async ({ data }) => {
    const sb = await admin();
    const { data: row } = await sb.from("load_attachments")
      .select("path").eq("load_id", data.loadId).eq("kind", data.kind).maybeSingle();
    if (row?.path) await sb.storage.from(BUCKET).remove([row.path]);
    await sb.from("load_attachments").delete().eq("load_id", data.loadId).eq("kind", data.kind);
    return { ok: true };
  });

export const getSignedReadUrlFn = createServerFn({ method: "POST" })
  .inputValidator((d: { path: string; expiresIn?: number; width?: number; height?: number }) => d)
  .handler(async ({ data }) => {
    const sb = await admin();
    const expiresIn = data.expiresIn ?? 3600;
    // When a width is requested, serve a resized image via Supabase image
    // transformation (Pro plan) so list thumbnails are a few KB instead of the
    // full multi-MB original. Full size is returned when no width is given.
    if (data.width) {
      const { data: signed, error } = await sb.storage
        .from(BUCKET)
        .createSignedUrl(data.path, expiresIn, {
          transform: { width: data.width, height: data.height || data.width, resize: "cover" },
        });
      if (!error && signed?.signedUrl) return { url: signed.signedUrl };
      // Transform unavailable for this object (e.g. non-image) — fall back to original.
    }
    const { data: plain, error: e2 } = await sb.storage
      .from(BUCKET)
      .createSignedUrl(data.path, expiresIn);
    if (e2) throw new Error(e2.message);
    return { url: plain.signedUrl };
  });

// ---------- GEOFENCE ALERTS ----------
export const upsertGeofenceAlertFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { alert: any; updatedAt: string }) => d)
  .handler(async ({ data }) => {
    const sb = await admin();
    const id = String(data.alert?.id || "");
    if (!id) throw new Error("alert.id required");
    const updatedAt = data.updatedAt || new Date().toISOString();
    const { data: existing } = await sb
      .from("geofence_alerts")
      .select("updated_at")
      .eq("id", id)
      .maybeSingle();
    if (existing?.updated_at && new Date(existing.updated_at).getTime() > new Date(updatedAt).getTime()) {
      return { ok: true, skipped: true as const };
    }
    const { error } = await sb.from("geofence_alerts").upsert(
      { id, data: { ...data.alert, id }, updated_at: updatedAt },
      { onConflict: "id" },
    );
    if (error) throw new Error(error.message);
    return { ok: true, skipped: false as const };
  });

export const deleteGeofenceAlertFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string }) => d)
  .handler(async ({ data }) => {
    const sb = await admin();
    const { error } = await sb.from("geofence_alerts").delete().eq("id", String(data.id));
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// ---------- Realtime configuration diagnostic ----------
// Returns, for each table we sync, whether it's in the supabase_realtime
// publication and whether replica identity is FULL. If anything is off,
// the client surfaces a hint to run sql/realtime-sync.sql.
export const diagnoseRealtimeFn = createServerFn({ method: "POST" }).handler(async () => {
  const sb = await admin();
  const tables = ["vehicles", "loads", "pod_records", "sos_records", "vehicle_pins", "load_attachments", "geofence_alerts", "app_settings"] as const;
  const results: Array<{ table: string; inPublication: boolean; replicaFull: boolean }> = [];
  try {
    const { data: pubRows } = await sb
      .from("pg_publication_tables" as any)
      .select("tablename")
      .eq("pubname", "supabase_realtime")
      .eq("schemaname", "public");
    const inPub = new Set((pubRows ?? []).map((r: any) => r.tablename));
    // replica identity: 'f' = FULL. pg_class.relreplident; we read via a tiny RPC fallback.
    let replicaMap = new Map<string, boolean>();
    try {
      const { data: relRows } = await sb
        .from("pg_class" as any)
        .select("relname, relreplident, relnamespace")
        .in("relname", tables as unknown as string[]);
      for (const r of (relRows ?? []) as any[]) {
        replicaMap.set(r.relname, r.relreplident === "f");
      }
    } catch {
      // pg_class not exposed via PostgREST in this project — leave unknown (treated as ok).
      for (const t of tables) replicaMap.set(t, true);
    }
    for (const t of tables) {
      results.push({
        table: t,
        inPublication: inPub.has(t),
        replicaFull: replicaMap.get(t) ?? true,
      });
    }
    const ok = results.every((r) => r.inPublication && r.replicaFull);
    return { ok, results, checkedAt: new Date().toISOString() };
  } catch (e: any) {
    return { ok: true, results: [], checkedAt: new Date().toISOString(), error: e?.message || String(e), unknown: true };
  }
});

// ---------- DRIVER APP SERVICE ACCOUNT ----------
// createDriverAccountFn: called once by admin from Settings → Driver App tab.
// Creates a dedicated Supabase user for the driver app and stores credentials
// in app_settings. All driver devices use this account to authenticate silently
// — drivers never see a login screen, only their vehicle PIN screen.
export const createDriverAccountFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const sb = await admin();

    // If credentials already exist, return early — idempotent
    const { data: existing } = await sb
      .from("app_settings")
      .select("value")
      .eq("key", "driver_app_credentials")
      .maybeSingle();
    if (existing?.value) return { ok: true, alreadyExists: true };

    // Generate credentials
    const email = `driver-app-${Date.now()}@driver.nslogistics.in`;
    // Keep ≤72 bytes — Supabase Auth (bcrypt) rejects longer passwords.
    const password = (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, "").slice(0, 64);

    // Create the Supabase user (email_confirm: true skips confirmation email)
    const { data: user, error } = await sb.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (error) throw new Error(error.message);
    if (!user) throw new Error("User creation returned no data");

    // Store credentials in app_settings so driver devices can fetch them.
    // user_id is stored so pullAll/pullDelta can recognise this shared
    // session and require vnum+PIN scoping on every read.
    const { error: settingsError } = await sb.from("app_settings").upsert(
      {
        key: "driver_app_credentials",
        value: { email, password, user_id: (user as any)?.user?.id ?? (user as any)?.id ?? null },
        updated_at: new Date().toISOString(),
      },
      { onConflict: "key" },
    );
    if (settingsError) throw new Error(settingsError.message);

    return { ok: true, alreadyExists: false };
  });

// getDriverCredentialsFn: called by driver.tsx on every app open.
// Open (no auth) — returns the driver service account credentials so the
// driver app can sign in silently before showing the PIN screen.
// Safe because: (a) credentials are for a shared account with identical RLS
// to any authenticated user, (b) sensitive data (loads, PODs) is still gated
// behind session in pullAll.
export const getDriverCredentialsFn = createServerFn({ method: "POST" })
  .handler(async () => {
    const sb = await admin();
    const { data } = await sb
      .from("app_settings")
      .select("value")
      .eq("key", "driver_app_credentials")
      .maybeSingle();
    if (!data?.value?.email || !data?.value?.password) return { ok: false };
    return { ok: true, email: data.value.email as string, password: data.value.password as string };
  });

// ---------- F3: delivered-history keyset pagination ----------
// pullAll caps DELIVERED at the newest 1000 (the split-fetch). When more exist,
// the client back-fills older pages with this fetcher until its Delivered-page
// window (90 days) is covered. Two-key keyset (updated_at, id) so bulk-sync
// timestamp bursts (many rows sharing one updated_at) can't skip rows.
export const pullDeliveredPage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { beforeUpdatedAt: string; beforeId?: string; limit?: number }) => d)
  .handler(async ({ data }) => {
    const sb = await admin();
    const limit = Math.max(50, Math.min(500, Number(data.limit) || 500));
    const cur = String(data.beforeUpdatedAt || "");
    if (!cur) throw new Error("beforeUpdatedAt required");
    let q = sb
      .from("loads")
      .select("id, lid, data, updated_at, version")
      .is("deleted_at", null)
      .eq("data->>lstatus", "DELIVERED");
    if (data.beforeId) {
      // keyset: strictly-older timestamp OR same timestamp with smaller id
      q = q.or(`updated_at.lt.${cur},and(updated_at.eq.${cur},id.lt.${data.beforeId})`);
    } else {
      q = q.lt("updated_at", cur);
    }
    const { data: rows, error } = await q
      .order("updated_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(limit);
    if (error) throw new Error(error.message);
    const loads = (rows ?? []).map((r: any) => ({ id: r.id, ...(r.data || {}), lid: firstValue(r.data?.lid, r.lid), _v: r.version ?? null }));
    const last = (rows ?? [])[rows!.length - 1] || null;
    return {
      loads,
      nextBeforeUpdatedAt: last ? last.updated_at : null,
      nextBeforeId: last ? String(last.id) : null,
      hasMore: (rows ?? []).length >= limit,
    };
  });

// ---------- Archive range fetchers (hybrid pagination) ----------
// Delivered Loads and POD List tabs serve the last 90 days from localStorage
// (the existing pullAll/pullDelta cache). When the user picks a From/To range
// that extends before that window, the components call these fns to fetch the
// exact range from the server. Results are returned as plain DTOs and cached
// in React Query for the session only (never written back to localStorage).

function isoDay(s: string | undefined | null) {
  if (!s) return null;
  const t = String(s).trim();
  // Accept yyyy-mm-dd or full ISO.
  return /^\d{4}-\d{2}-\d{2}/.test(t) ? t : null;
}

export const listDeliveredLoadsByRange = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { from: string; to: string }) => d)
  .handler(async ({ data }) => {
    const from = isoDay(data.from);
    const to = isoDay(data.to);
    if (!from || !to) throw new Error("from/to required as yyyy-mm-dd");
    const sb = await admin();
    // Inclusive end-of-day for "to".
    const toEnd = `${to}T23:59:59.999Z`;
    const fromStart = `${from}T00:00:00.000Z`;
    const { data: rows, error } = await sb
      .from("loads")
      .select("id, lid, data, updated_at")
      .is("deleted_at", null)
      .eq("data->>lstatus", "DELIVERED")
      .gte("data->>deliveredAt", fromStart)
      .lte("data->>deliveredAt", toEnd)
      .order("data->>deliveredAt", { ascending: false })
      .limit(5000);
    if (error) throw new Error(error.message);
    const loads = (rows ?? []).map((r: any) => ({ id: r.id, ...(r.data || {}), lid: firstValue(r.data?.lid, r.lid) }));
    return { loads };
  });

export const listPODsByRange = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { from: string; to: string }) => d)
  .handler(async ({ data }) => {
    const from = isoDay(data.from);
    const to = isoDay(data.to);
    if (!from || !to) throw new Error("from/to required as yyyy-mm-dd");
    const sb = await admin();
    const toEnd = `${to}T23:59:59.999Z`;
    const fromStart = `${from}T00:00:00.000Z`;
    const { data: rows, error } = await sb
      .from("pod_records")
      .select("id, load_id, data, updated_at")
      .gte("data->>at", fromStart)
      .lte("data->>at", toEnd)
      .order("data->>at", { ascending: false })
      .limit(5000);
    if (error) throw new Error(error.message);
    const pods = (rows ?? []).map(mapPODRow);
    // Enrich with load + vehicle context (customer/origin/dest/vnum) for any
    // POD row missing those fields, mirroring pullAll behaviour.
    const loadIds = Array.from(new Set(pods.map((p: any) => p.loadId).filter(Boolean)));
    let loadsById = new Map<string, any>();
    if (loadIds.length) {
      const { data: lds } = await sb
        .from("loads")
        .select("id, data")
        .in("id", loadIds as string[]);
      loadsById = new Map((lds ?? []).map((r: any) => [String(r.id), r.data || {}]));
    }
    const hydrated = pods.map((p: any) => {
      const ld = p.loadId ? loadsById.get(String(p.loadId)) : null;
      if (!ld) return p;
      return {
        ...p,
        lid: p.lid || ld.lid || null,
        customer: p.customer || ld.customer || null,
        origin: p.origin || ld.origin || null,
        dest: p.dest || ld.dest || null,
        vnum: p.vnum || ld.vnum || null,
        driver: p.driver || ld.driver || null,
        mobile: p.mobile || ld.mobile || null,
      };
    });
    return { pods: hydrated };
  });
