import { createMiddleware } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { getRequestHeader } from "@tanstack/react-start/server";

/**
 * Server middleware: validates the Bearer token from the request and attaches
 * an authenticated Supabase client + userId/claims to context.
 *
 * Pair with `attachSupabaseAuth` (functionMiddleware in src/start.ts) so the
 * browser auto-forwards the user's access token on every createServerFn call.
 */
export const requireSupabaseAuth = createMiddleware({ type: "function" }).server(
  async ({ next }) => {
    const authHeader = getRequestHeader("authorization") || getRequestHeader("Authorization");
    if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
      throw new Response("Unauthorized: No authorization header provided", { status: 401 });
    }
    const token = authHeader.slice(7).trim();
    if (!token) throw new Response("Unauthorized: Empty bearer token", { status: 401 });

    const url = process.env.TMS_SUPABASE_URL ?? process.env.SUPABASE_URL;
    const anonKey =
      process.env.TMS_SUPABASE_PUBLISHABLE_KEY ??
      process.env.TMS_SUPABASE_ANON_KEY ??
      process.env.SUPABASE_PUBLISHABLE_KEY ??
      process.env.SUPABASE_ANON_KEY;
    if (!url || !anonKey) {
      throw new Response("Server misconfigured: missing Supabase env", { status: 500 });
    }

    const supabase = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    });

    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) {
      throw new Response("Unauthorized: Invalid token", { status: 401 });
    }

    return next({ context: { supabase, userId: data.user.id, claims: data.user } });
  },
);
