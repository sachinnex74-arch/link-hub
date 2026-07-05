import { createMiddleware } from "@tanstack/react-start";
import { ensureSupabase } from "./client";

/**
 * Client functionMiddleware: attach the current user's access token to every
 * outgoing createServerFn call so server middleware can validate it.
 */
export const attachSupabaseAuth = createMiddleware({ type: "function" }).client(
  async ({ next }) => {
    try {
      const sb = await ensureSupabase();
      const { data } = (await sb?.auth.getSession()) ?? { data: { session: null } };
      const token = data?.session?.access_token;
      if (token) {
        return next({ headers: { Authorization: `Bearer ${token}` } });
      }
    } catch {
      // Fall through unauthenticated; the server middleware will 401 if needed.
    }
    return next();
  },
);
