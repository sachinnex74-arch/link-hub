import { useEffect, useState, useRef } from "react";
import { ensureSupabase } from "@/integrations/supabase/client";
import { getGlobalLogoutStatus } from "@/lib/tms.functions";
import { markHalted } from "@/lib/haltState";

const LOGIN_AT_KEY = "tms_login_at";

const USERNAME_DOMAIN = "tms.local";

// Bump this on every deploy. The server holds a `min_app_version` in app_settings;
// if a running tab's APP_VERSION is below it, the tab is running stale code and is
// ejected to /login (which loads fresh code). This is what stops weeks-old tabs
// from silently writing — they can no longer keep running once you raise the
// server minimum. To force all stale tabs out after a deploy, set min_app_version
// to this same number in app_settings.
export const APP_VERSION = 1;

// Re-exported for convenience; the source of truth lives in haltState.ts.
export { isHalted } from "@/lib/haltState";

// Hard-stop this tab: mark halted so background loops bail immediately, then do a
// REAL navigation to the login page. We use location.replace (not reload) so the
// running page context — and all its timers/evaluators — is destroyed and cannot
// resume from cache or via the back button.
let REDIRECTING = false;
function haltAndRedirectToLogin() {
  markHalted();
  if (REDIRECTING) return;
  REDIRECTING = true;
  try {
    localStorage.removeItem(LOGIN_AT_KEY);
  } catch {
    // ignore storage errors
  }
  try {
    // replace() leaves no history entry, so the stale page can't be navigated back to.
    window.location.replace("/login");
  } catch {
    // last-resort fallback
    window.location.href = "/login";
  }
}

export function emailFor(username: string) {
  return `${String(username || "").trim().toLowerCase()}@${USERNAME_DOMAIN}`;
}

export function usernameFromEmail(email: string | null | undefined) {
  if (!email) return "";
  const at = email.indexOf("@");
  return at > 0 ? email.slice(0, at) : email;
}

export async function signInWithUsername(username: string, password: string) {
  const sb = await ensureSupabase();
  if (!sb) throw new Error("Cloud not available yet. Try again in a moment.");
  const { data, error } = await sb.auth.signInWithPassword({
    email: emailFor(username),
    password,
  });
  if (error) throw error;
  localStorage.setItem(LOGIN_AT_KEY, new Date().toISOString());
  return data;
}

export async function signOut() {
  const sb = await ensureSupabase();
  if (!sb) return;
  localStorage.removeItem(LOGIN_AT_KEY);
  await sb.auth.signOut({ scope: "local" });
}

export function useAuthSession() {
  const [state, setState] = useState<{
    ready: boolean;
    userId: string | null;
    username: string;
  }>({ ready: false, userId: null, username: "" });
  const checkingRef = useRef(false);

  useEffect(() => {
    let unsub: { unsubscribe: () => void } | null = null;
    let alive = true;
    (async () => {
      const sb = await ensureSupabase();
      if (!sb || !alive) {
        setState({ ready: true, userId: null, username: "" });
        return;
      }
      const { data } = await sb.auth.getSession();
      const u = data.session?.user;
      setState({
        ready: true,
        userId: u?.id ?? null,
        username:
          (u?.user_metadata as any)?.username ?? usernameFromEmail(u?.email),
      });
      const sub = sb.auth.onAuthStateChange((_evt, session) => {
        const usr = session?.user;
        setState({
          ready: true,
          userId: usr?.id ?? null,
          username:
            (usr?.user_metadata as any)?.username ?? usernameFromEmail(usr?.email),
        });
      });
      unsub = sub.data.subscription;
    })();
    return () => {
      alive = false;
      unsub?.unsubscribe();
    };
  }, []);

  // Poll for forced global logout
  useEffect(() => {
    if (!state.userId) return;
    const check = async () => {
      if (checkingRef.current) return;
      checkingRef.current = true;
      try {
        const { forceLogoutAt, minAppVersion } = await getGlobalLogoutStatus();
        // STALE CODE CHECK: if the server requires a newer build than this tab is
        // running, eject. This catches old tabs that don't even have current logic.
        if (minAppVersion != null && Number(minAppVersion) > APP_VERSION) {
          haltAndRedirectToLogin();
          return;
        }
        if (!forceLogoutAt) return;
        const loginAt = localStorage.getItem(LOGIN_AT_KEY);
        // No local login stamp but a global logout exists → this tab is stale.
        // Eject it rather than letting it keep running.
        if (!loginAt) {
          haltAndRedirectToLogin();
          return;
        }
        if (new Date(forceLogoutAt).getTime() > new Date(loginAt).getTime()) {
          // Halt FIRST (stops background writers this tick), sign out, then a
          // real navigation that destroys the page. No window.location.reload():
          // reload re-runs the same (possibly stale) page and lets it keep writing.
          await signOut();
          haltAndRedirectToLogin();
        }
      } catch {
        // ignore network errors
      } finally {
        checkingRef.current = false;
      }
    };
    check();
    const id = setInterval(check, 30_000);
    return () => clearInterval(id);
  }, [state.userId]);

  return state;
}
