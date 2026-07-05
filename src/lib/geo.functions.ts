import { createServerFn } from "@tanstack/react-start";

const GEOCODE_TIMEOUT_MS = 10_000;
const UA = "LovableTMS/1.0 (https://lovable.dev)";

// State aliases so e.g. "delhi" matches "national capital territory of delhi"
const STATE_ALIASES: Record<string, string[]> = {
  delhi: ["national capital territory of delhi", "nct of delhi", "new delhi"],
  pondicherry: ["puducherry"],
  orissa: ["odisha"],
  uttaranchal: ["uttarakhand"],
  "andaman and nicobar": ["andaman and nicobar islands"],
};
function normState(s: string | null | undefined): string {
  return String(s || "").trim().toLowerCase();
}
function statesMatch(requested: string, actual: string): boolean {
  const a = normState(requested);
  const b = normState(actual);
  if (!a || !b) return true; // nothing to validate against → accept
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  for (const [canonical, aliases] of Object.entries(STATE_ALIASES)) {
    const group = [canonical, ...aliases];
    if (group.includes(a) && group.includes(b)) return true;
  }
  return false;
}

// "Mumbai, Maharashtra, India" → { city, state, country }
function splitAddress(input: string) {
  const parts = input.split(",").map(p => p.trim()).filter(Boolean);
  let country = "";
  let state = "";
  let city = "";
  if (parts.length >= 3) {
    country = parts[parts.length - 1];
    state = parts[parts.length - 2];
    city = parts.slice(0, -2).join(", ");
  } else if (parts.length === 2) {
    // could be "City, State" or "City, Country"
    const last = parts[1];
    if (/^india$/i.test(last)) {
      country = last;
      city = parts[0];
    } else {
      state = last;
      city = parts[0];
    }
  } else {
    city = parts[0] || "";
  }
  return { city, state, country };
}

async function fetchJson(url: string): Promise<any | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GEOCODE_TIMEOUT_MS);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": UA, Accept: "application/json" },
    }).finally(() => clearTimeout(timer));
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export const reverseGeocodeState = createServerFn({ method: "POST" })
  .inputValidator((data: { lat: number; lng: number }) => ({
    lat: Number(data?.lat),
    lng: Number(data?.lng),
  }))
  .handler(async ({ data }) => {
    const empty = { state: null as string | null, address: null as string | null };
    if (!isFinite(data.lat) || !isFinite(data.lng)) return empty;
    // GEO-CACHE (shared, cross-user): coordinates rounded to 3 decimals (~1.1 km
    // cells) key a DB cache. Any address resolved ONCE — by any tab, any user,
    // ever — is served from the table thereafter. Nominatim is hit only on a
    // cold miss for a road cell the fleet has never reported from before.
    const cell = `${data.lat.toFixed(3)},${data.lng.toFixed(3)}`;
    let sb: any = null;
    try {
      const { getSupabaseAdmin } = await import("@/integrations/supabase/client.server");
      sb = getSupabaseAdmin();
      const { data: hit } = await sb.from("geo_cache").select("state, address").eq("cell", cell).maybeSingle();
      if (hit) return { state: hit.state ?? null, address: hit.address ?? null };
    } catch { /* cache unavailable → fall through to live lookup */ }
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&addressdetails=1&accept-language=en&lat=${data.lat}&lon=${data.lng}`;
    const json = await fetchJson(url);
    if (!json) return empty;
    const state: string | null =
      json?.address?.state ?? json?.address?.region ?? null;
    const address: string | null = json?.display_name ?? null;
    // write-through (best effort; a failed cache write never fails the lookup)
    try {
      if (sb && (state || address)) {
        await sb.from("geo_cache").upsert(
          { cell, state, address, updated_at: new Date().toISOString() },
          { onConflict: "cell" },
        );
      }
    } catch {}
    return { state, address };
  });

export const forwardGeocodeCity = createServerFn({ method: "POST" })
  .inputValidator((data: { city: string }) => ({ city: String(data?.city || "").slice(0, 200) }))
  .handler(async ({ data }) => {
    const empty = { lat: null as number | null, lng: null as number | null };
    const raw = data.city.trim();
    if (!raw) return empty;

    const { city, state, country } = splitAddress(raw);
    const expectedState = state; // may be ""

    // ---- 1) Nominatim structured query (strict, India-only) ----
    try {
      const params = new URLSearchParams({
        format: "json",
        limit: "1",
        countrycodes: "in",
        addressdetails: "1",
        "accept-language": "en",
      });
      if (city) params.set("city", city);
      if (state) params.set("state", state);
      params.set("country", country || "India");
      const url = `https://nominatim.openstreetmap.org/search?${params.toString()}`;
      const json = await fetchJson(url);
      const first = Array.isArray(json) ? json[0] : null;
      if (first) {
        const lat = Number(first.lat);
        const lng = Number(first.lon);
        const gotState =
          first?.address?.state ?? first?.address?.region ?? "";
        if (
          Number.isFinite(lat) &&
          Number.isFinite(lng) &&
          statesMatch(expectedState, gotState)
        ) {
          return { lat, lng };
        }
      }
    } catch {
      // continue
    }

    // ---- 2) Nominatim free-text fallback (India bbox) ----
    try {
      const params = new URLSearchParams({
        format: "json",
        limit: "1",
        countrycodes: "in",
        addressdetails: "1",
        "accept-language": "en",
        q: raw,
      });
      const url = `https://nominatim.openstreetmap.org/search?${params.toString()}`;
      const json = await fetchJson(url);
      const first = Array.isArray(json) ? json[0] : null;
      if (first) {
        const lat = Number(first.lat);
        const lng = Number(first.lon);
        const gotState =
          first?.address?.state ?? first?.address?.region ?? "";
        if (
          Number.isFinite(lat) &&
          Number.isFinite(lng) &&
          statesMatch(expectedState, gotState)
        ) {
          return { lat, lng };
        }
      }
    } catch {
      // continue
    }

    // ---- 3) Photon fallback (India bbox, NO proximity bias) ----
    try {
      const params = new URLSearchParams({
        q: raw,
        limit: "1",
        lang: "en",
        bbox: "68.0,6.0,98.0,37.5",
      });
      const url = `https://photon.komoot.io/api/?${params.toString()}`;
      const json = await fetchJson(url);
      const feat = json?.features?.[0];
      const coords = feat?.geometry?.coordinates;
      if (Array.isArray(coords)) {
        const lng = Number(coords[0]);
        const lat = Number(coords[1]);
        const gotState =
          feat?.properties?.state ?? feat?.properties?.region ?? "";
        if (
          Number.isFinite(lat) &&
          Number.isFinite(lng) &&
          statesMatch(expectedState, gotState)
        ) {
          return { lat, lng };
        }
      }
    } catch {
      // fall through
    }

    // ---- 4) Google Maps Geocoding API via connector gateway (final fallback) ----
    const lovableKey = process.env.LOVABLE_API_KEY;
    const gmapsKey = process.env.GOOGLE_MAPS_API_KEY;
    if (lovableKey && gmapsKey) {
      try {
        const addr = [city, state, country || "India"].filter(Boolean).join(", ");
        const url =
          `https://connector-gateway.lovable.dev/google_maps/maps/api/geocode/json` +
          `?address=${encodeURIComponent(addr)}&components=country:IN`;
        const res = await fetch(url, {
          headers: {
            Authorization: `Bearer ${lovableKey}`,
            "X-Connection-Api-Key": gmapsKey,
          },
        });
        if (res.ok) {
          const json: any = await res.json();
          const first = Array.isArray(json?.results) ? json.results[0] : null;
          const loc = first?.geometry?.location;
          const lat = Number(loc?.lat);
          const lng = Number(loc?.lng);
          if (Number.isFinite(lat) && Number.isFinite(lng)) {
            return { lat, lng };
          }
        }
      } catch {
        // fall through
      }
    }

    return empty;
  });
