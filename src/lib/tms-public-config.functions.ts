import { createServerFn } from "@tanstack/react-start";

export const getTmsPublicConfig = createServerFn({ method: "GET" }).handler(async () => {
  const url =
    process.env.TMS_SUPABASE_URL ??
    process.env.SUPABASE_URL ??
    process.env.VITE_SUPABASE_URL ??
    "";
  const anonKey =
    process.env.TMS_SUPABASE_PUBLISHABLE_KEY ??
    process.env.SUPABASE_PUBLISHABLE_KEY ??
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
    process.env.SUPABASE_ANON_KEY ??
    "";
  const missing: string[] = [];
  if (!url) missing.push("SUPABASE_URL");
  if (!anonKey) missing.push("SUPABASE_PUBLISHABLE_KEY");
  return { url, anonKey, missing };
});
