import { createServerFn } from "@tanstack/react-start";

// Hosted Pelias autocomplete via geocode.earth.
// Docs: https://geocode.earth/docs/forward/autocomplete/
//
// Concurrency strategy (unchanged from previous Photon impl):
//   1. per-isolate in-memory cache
//   2. in-flight de-dup
//   3. shared DB cache in public.place_search_cache
//   4. Pelias fetch with retry/backoff
//   5. fall back to stale DB row on failure

type PlaceResult = {
  suggestions: string[];
  results: Array<{ label: string; lat: number; lng: number }>;
  error?: string;
};

function labelFor(feat: any): string {
  const p = feat?.properties ?? {};
  const primary = p.name || p.locality || p.localadmin || p.county;
  const region = p.region;
  const country = p.country;
  return [primary, region, country].filter(Boolean).join(", ");
}

// ---- per-worker caches ----
const MEM_TTL_MS = 5 * 60 * 1000;
const NEG_TTL_MS = 30 * 1000;
const DB_TTL_MS = 30 * 60 * 1000;
const MEM_MAX = 200;
const mem = new Map<string, { at: number; data: PlaceResult }>();
const inflight = new Map<string, Promise<PlaceResult>>();

function memGet(key: string): { fresh: boolean; data: PlaceResult } | null {
  const hit = mem.get(key);
  if (!hit) return null;
  const ttl = hit.data.error ? NEG_TTL_MS : MEM_TTL_MS;
  return { fresh: Date.now() - hit.at < ttl, data: hit.data };
}

function memSet(key: string, data: PlaceResult) {
  if (mem.size >= MEM_MAX) {
    const firstKey = mem.keys().next().value;
    if (firstKey !== undefined) mem.delete(firstKey);
  }
  mem.set(key, { at: Date.now(), data });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function peliasOnce(q: string, apiKey: string, timeoutMs: number): Promise<
  | { ok: true; json: any }
  | { ok: false; status: number; retriable: boolean; retryAfterMs?: number }
> {
  const params = new URLSearchParams({
    api_key: apiKey,
    text: q,
    "boundary.country": "IND",
    layers: "locality,localadmin,county,region,neighbourhood",
    size: "12",
    lang: "en",
  });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`https://api.geocode.earth/v1/autocomplete?${params.toString()}`, {
      headers: { Accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const retriable = res.status === 429 || (res.status >= 500 && res.status <= 599);
      let retryAfterMs: number | undefined;
      const ra = res.headers.get("retry-after");
      if (ra) {
        const n = Number(ra);
        if (Number.isFinite(n)) retryAfterMs = Math.min(5000, Math.max(0, n * 1000));
      }
      let bodySnippet = "";
      try { bodySnippet = (await res.text()).slice(0, 200); } catch {}
      console.error(`[places] pelias non-2xx status=${res.status} retry-after=${ra ?? "-"} body=${bodySnippet}`);
      return { ok: false, status: res.status, retriable, retryAfterMs };
    }
    const json = await res.json();
    return { ok: true, json };
  } catch (e: any) {
    console.error(`[places] pelias fetch threw name=${e?.name} message=${e?.message}`);
    return { ok: false, status: 0, retriable: true };
  } finally {
    clearTimeout(timer);
  }
}


function parsePelias(json: any): PlaceResult {
  const feats: any[] = Array.isArray(json?.features) ? json.features : [];
  const suggestions: string[] = [];
  const results: Array<{ label: string; lat: number; lng: number }> = [];
  const seen = new Set<string>();
  for (const f of feats) {
    const p = f?.properties ?? {};
    if (p.country_a && p.country_a !== "IND") continue;
    const label = labelFor(f);
    if (!label) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const coords = f?.geometry?.coordinates;
    const lng = Array.isArray(coords) ? Number(coords[0]) : NaN;
    const lat = Array.isArray(coords) ? Number(coords[1]) : NaN;
    suggestions.push(label);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      results.push({ label, lat, lng });
    }
    if (suggestions.length >= 12) break;
  }
  return { suggestions, results };
}

async function peliasWithRetry(q: string): Promise<PlaceResult> {
  const apiKey = process.env.GEOCODE_EARTH_API_KEY;
  const keyLen = apiKey ? apiKey.length : 0;
  const keyPrefix = apiKey ? apiKey.slice(0, 3) : "";
  console.log(`[places] pelias start q="${q}" keyPresent=${!!apiKey} keyLen=${keyLen} keyPrefix=${keyPrefix}`);
  if (!apiKey) {
    return { suggestions: [], results: [], error: "GEOCODE_EARTH_API_KEY not configured" };
  }

  const delays = [200, 500, 1100];
  let lastStatus = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await peliasOnce(q, apiKey, 3500);
    if (r.ok) {
      const parsed = parsePelias(r.json);
      console.log(`[places] pelias ok q="${q}" suggestions=${parsed.suggestions.length}`);
      return parsed;
    }
    lastStatus = r.status;
    if (!r.retriable || attempt === 2) break;
    const base = r.retryAfterMs ?? delays[attempt] ?? 1100;
    const jitter = Math.floor(Math.random() * 150);
    await sleep(base + jitter);
  }
  console.error(`[places] pelias gave up q="${q}" lastStatus=${lastStatus}`);
  return { suggestions: [], results: [], error: `pelias unavailable${lastStatus ? ` (${lastStatus})` : ""}` };
}



type DbRow = { payload: PlaceResult; updated_at: string } | null;

async function dbGet(key: string): Promise<DbRow> {
  try {
    const { getSupabaseAdmin } = await import("@/integrations/supabase/client.server");
    const supabaseAdmin = getSupabaseAdmin();
    const { data, error } = await supabaseAdmin
      .from("place_search_cache" as any)
      .select("payload, updated_at")
      .eq("query", key)
      .maybeSingle();
    if (error || !data) return null;
    return data as any;
  } catch {
    return null;
  }
}

async function dbSet(key: string, payload: PlaceResult): Promise<void> {
  try {
    const { getSupabaseAdmin } = await import("@/integrations/supabase/client.server");
    const supabaseAdmin = getSupabaseAdmin();
    await supabaseAdmin
      .from("place_search_cache" as any)
      .upsert({ query: key, payload, updated_at: new Date().toISOString() } as any, {
        onConflict: "query",
      });
  } catch {
    // ignore — caching is best-effort
  }
}

async function searchCached(query: string): Promise<PlaceResult> {
  const key = query.toLowerCase();

  // 1. in-memory
  const memHit = memGet(key);
  if (memHit && memHit.fresh) return memHit.data;

  // 2. in-flight de-dup
  const existing = inflight.get(key);
  if (existing) return existing;

  const p = (async () => {
    try {
      // 3. DB cache
      const row = await dbGet(key);
      if (row) {
        const age = Date.now() - new Date(row.updated_at).getTime();
        if (age < DB_TTL_MS) {
          memSet(key, row.payload);
          return row.payload;
        }
      }

      // 4. Photon
      const fresh = await peliasWithRetry(query);
      if (!fresh.error && fresh.suggestions.length > 0) {
        memSet(key, fresh);
        // fire-and-forget DB write
        void dbSet(key, fresh);
        return fresh;
      }

      // 5. fall back to stale DB row if any
      if (row) {
        memSet(key, row.payload);
        return row.payload;
      }

      // empty success — cache briefly to avoid hammering
      if (!fresh.error) {
        memSet(key, fresh);
        void dbSet(key, fresh);
      } else {
        // negative cache in memory only
        memSet(key, fresh);
      }
      return fresh;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, p);
  return p;
}

export const searchIndianPlaces = createServerFn({ method: "POST" })
  .inputValidator((data: { query: string }) => {
    const q = String(data?.query ?? "").slice(0, 200);
    return { query: q };
  })
  .handler(async ({ data }): Promise<PlaceResult> => {
    const query = data.query.trim();
    if (query.length < 3) return { suggestions: [], results: [] };
    try {
      const out = await searchCached(query);
      console.log(`[places] handler q="${query}" suggestions=${out.suggestions.length} error=${out.error ?? "-"}`);
      return out;
    } catch (e: any) {
      console.error(`[places] handler threw q="${query}" message=${e?.message}`);
      return { suggestions: [], results: [], error: e?.message ?? "Request failed" };
    }
  });

