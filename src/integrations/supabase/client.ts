import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Cache on globalThis so every bundled copy of this module shares ONE client.
// Without this, multiple chunks (main app + serverFn middleware chunk) each
// create their own GoTrueClient against the same storageKey "tms-auth" and
// race on token refresh — which silently kills Realtime sockets.
type GlobalStore = {
  __tmsSupabaseClient?: SupabaseClient | null;
  __tmsSupabasePending?: Promise<SupabaseClient | null> | null;
  __tmsSupabaseMissing?: string[];
};
const G = globalThis as unknown as GlobalStore;

export function getSupabase(): SupabaseClient | null {
  return G.__tmsSupabaseClient ?? null;
}

export function getMissingPublicConfig(): string[] {
  return G.__tmsSupabaseMissing ?? [];
}

export async function ensureSupabase(): Promise<SupabaseClient | null> {
  if (typeof window === "undefined") return null;
  if (G.__tmsSupabaseClient) return G.__tmsSupabaseClient;
  if (G.__tmsSupabasePending) return G.__tmsSupabasePending;
  G.__tmsSupabasePending = (async () => {
    try {
      const env = import.meta.env;
      // Publishable URL + anon key are safe to embed (RLS protects data).
      // Hardcoded defaults guarantee Realtime works even when VITE_* env vars
      // aren't injected at build time on preview/published.
      const DEFAULT_URL = "https://xkuxizypbrzzkugjnquw.supabase.co";
      const DEFAULT_ANON = "sb_publishable_hwCaNkApKRONVrR-UyEyOg_bfuvCb7k";
      const url =
        env.VITE_TMS_SUPABASE_URL ||
        env.VITE_SUPABASE_URL ||
        DEFAULT_URL;
      const anonKey =
        env.VITE_TMS_SUPABASE_PUBLISHABLE_KEY ||
        env.VITE_TMS_SUPABASE_ANON_KEY ||
        env.VITE_SUPABASE_PUBLISHABLE_KEY ||
        env.VITE_SUPABASE_ANON_KEY ||
        DEFAULT_ANON;
      G.__tmsSupabaseMissing = [];
      if (!url || !anonKey) {
        console.warn("[supabase] missing public config; realtime disabled");
        return null;
      }
      G.__tmsSupabaseClient = createClient(url, anonKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          storageKey: "tms-auth",
        },
        realtime: { params: { eventsPerSecond: 40 } },
      });
      return G.__tmsSupabaseClient;
    } catch (e) {
      console.warn("[supabase] failed to initialize browser client", e);
      return null;
    }
  })();
  return G.__tmsSupabasePending;
}
