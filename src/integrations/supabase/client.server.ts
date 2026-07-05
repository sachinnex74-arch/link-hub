import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let _admin: SupabaseClient | null = null;

export function getSupabaseAdmin(): SupabaseClient {
  if (_admin) return _admin;
  const url = process.env.TMS_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const key = process.env.TMS_SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Missing Cloud credentials: set TMS_SUPABASE_URL + TMS_SUPABASE_SERVICE_ROLE_KEY or SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY",
    );
  }
  _admin = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _admin;
}
