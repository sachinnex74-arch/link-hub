// Cross-device synced setting backed by Supabase `app_settings` table.
// Mirrors the value into localStorage for instant boot, hydrates from
// cloud on mount, listens to realtime updates, and pushes local edits.

import { useEffect, useRef, useState } from "react";
import { pushSetting, subscribeSetting, getCachedSetting } from "@/lib/supaSync";

const ECHO_QUIET_MS = 1500;

export function useSyncedSetting<T>(key: string, defaultValue: T) {
  const [value, setValue] = useState<T>(() => {
    const cached = getCachedSetting<T>(key);
    return cached === undefined ? defaultValue : cached;
  });

  // Last value we know is in sync with the cloud: either the cached/default
  // value we booted with, the last value we received via subscribe, or the
  // last value we pushed. We only push when `value` diverges from this.
  // This is StrictMode-safe (double-invoked effects don't re-push) and
  // hydration-safe (defaults are never pushed back to cloud).
  const syncedStrRef = useRef<string>(JSON.stringify(
    (getCachedSetting<T>(key) ?? defaultValue) ?? null
  ));
  const lastPushAtRef = useRef(0);

  // Subscribe to cloud changes (hydration + realtime)
  useEffect(() => {
    const unsub = subscribeSetting<T>(key, (incoming) => {
      const incomingStr = JSON.stringify(incoming ?? null);
      // Same as what we're already showing → no-op.
      if (incomingStr === syncedStrRef.current) return;
      // Stale echo arriving right after a local push → ignore so it
      // can't clobber the user's most recent edit.
      if (Date.now() - lastPushAtRef.current < ECHO_QUIET_MS) return;
      syncedStrRef.current = incomingStr;
      setValue(incoming === undefined ? defaultValue : incoming);
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Push local edits to cloud (only when value actually diverges from
  // the last synced value — never on initial mount or StrictMode re-runs).
  useEffect(() => {
    const valueStr = JSON.stringify(value ?? null);
    if (valueStr === syncedStrRef.current) return;
    syncedStrRef.current = valueStr;
    lastPushAtRef.current = Date.now();
    pushSetting(key, value);
  }, [key, value]);

  return [value, setValue] as const;
}
