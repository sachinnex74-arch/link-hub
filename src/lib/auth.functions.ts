import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const USERNAME_DOMAIN = "tms.local";
const ADMIN_USERNAME = "admin";
const ADMIN_PASSWORD = "8826";

function emailFor(username: string) {
  return `${String(username || "").trim().toLowerCase()}@${USERNAME_DOMAIN}`;
}

function usernameFromEmail(email: string | null | undefined) {
  if (!email) return "";
  const at = email.indexOf("@");
  return at > 0 ? email.slice(0, at) : email;
}

async function admin() {
  const { getSupabaseAdmin } = await import("@/integrations/supabase/client.server");
  return getSupabaseAdmin();
}

async function isAdmin(userId: string): Promise<boolean> {
  const sb = await admin();
  const { data, error } = await sb
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  if (error) throw new Error(error.message);
  return !!data;
}

async function assertAdmin(userId: string) {
  if (!(await isAdmin(userId))) throw new Error("Admin access required");
}

/** Idempotently ensures the seed admin user exists. Safe to call on every app load. */
export const ensureAdminBootstrap = createServerFn({ method: "POST" }).handler(async () => {
  const sb = await admin();

  // Look up profile first (fast path).
  const { data: existingProfile } = await sb
    .from("profiles")
    .select("id")
    .eq("username", ADMIN_USERNAME)
    .maybeSingle();

  let adminUserId: string | null = existingProfile?.id ?? null;

  if (!adminUserId) {
    // Create the admin auth user.
    const { data, error } = await sb.auth.admin.createUser({
      email: emailFor(ADMIN_USERNAME),
      password: ADMIN_PASSWORD,
      email_confirm: true,
      user_metadata: { username: ADMIN_USERNAME },
    });
    if (error && !/registered|exists/i.test(error.message || "")) {
      throw new Error("Failed to bootstrap admin: " + error.message);
    }
    if (data?.user) {
      adminUserId = data.user.id;
    } else {
      // Email may already exist (race). Look it up by email via listUsers.
      const { data: list } = await sb.auth.admin.listUsers({ page: 1, perPage: 1000 });
      const found = list?.users?.find((u) => u.email === emailFor(ADMIN_USERNAME));
      adminUserId = found?.id ?? null;
    }
    // Make sure profile row exists (the trigger should have done it).
    if (adminUserId) {
      await sb
        .from("profiles")
        .upsert({ id: adminUserId, username: ADMIN_USERNAME }, { onConflict: "id" });
    }
  }

  if (!adminUserId) return { ok: false, reason: "no_admin_id" };

  // Ensure admin role.
  await sb
    .from("user_roles")
    .upsert({ user_id: adminUserId, role: "admin" }, { onConflict: "user_id,role" });

  return { ok: true };
});

/** Returns { userId, username, isAdmin } for the caller. */
export const getMe = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { userId } = context as any;
    const sb = await admin();
    const { data: profile } = await sb
      .from("profiles")
      .select("username")
      .eq("id", userId)
      .maybeSingle();
    const adminFlag = await isAdmin(userId);
    return { userId, username: profile?.username ?? "", isAdmin: adminFlag };
  });

export const listUsers = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { userId } = context as any;
    await assertAdmin(userId);
    const sb = await admin();

    const { data: profiles, error } = await sb
      .from("profiles")
      .select("id, username, created_at")
      .order("created_at", { ascending: true });
    if (error) throw new Error(error.message);

    const { data: roles } = await sb.from("user_roles").select("user_id, role");
    const roleMap = new Map<string, string>();
    (roles || []).forEach((r: any) => {
      // 'admin' wins over 'user'.
      if (r.role === "admin" || !roleMap.has(r.user_id)) roleMap.set(r.user_id, r.role);
    });

    return (profiles || []).map((p: any) => ({
      id: p.id,
      username: p.username,
      role: (roleMap.get(p.id) || "user") as "admin" | "user",
      created_at: p.created_at,
    }));
  });

export const createUser = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: { username: string; password: string; role: "admin" | "user" }) => {
      const username = String(d.username || "").trim().toLowerCase();
      if (!/^[a-z0-9_.-]{2,40}$/.test(username))
        throw new Error("Username must be 2-40 chars: a-z 0-9 _ . -");
      const password = String(d.password || "");
      if (password.length < 4) throw new Error("Password must be at least 4 characters");
      const role = d.role === "admin" ? "admin" : "user";
      return { username, password, role };
    },
  )
  .handler(async ({ data, context }) => {
    const { userId } = context as any;
    await assertAdmin(userId);
    const sb = await admin();

    const { data: created, error } = await sb.auth.admin.createUser({
      email: emailFor(data.username),
      password: data.password,
      email_confirm: true,
      user_metadata: { username: data.username },
    });
    if (error) throw new Error(error.message);
    const newId = created.user!.id;

    await sb
      .from("profiles")
      .upsert({ id: newId, username: data.username }, { onConflict: "id" });
    await sb
      .from("user_roles")
      .upsert({ user_id: newId, role: data.role }, { onConflict: "user_id,role" });

    return { ok: true, id: newId };
  });

export const resetUserPassword = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { userId: string; password: string }) => {
    if (!d.userId) throw new Error("userId required");
    if (!d.password || d.password.length < 4) throw new Error("Password too short");
    return d;
  })
  .handler(async ({ data, context }) => {
    const { userId } = context as any;
    await assertAdmin(userId);
    const sb = await admin();
    const { error } = await sb.auth.admin.updateUserById(data.userId, {
      password: data.password,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const deleteUser = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { userId: string }) => {
    if (!d.userId) throw new Error("userId required");
    return d;
  })
  .handler(async ({ data, context }) => {
    const { userId } = context as any;
    await assertAdmin(userId);
    if (data.userId === userId) throw new Error("Cannot delete your own account");
    const sb = await admin();
    const { error } = await sb.auth.admin.deleteUser(data.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const setUserRole = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { userId: string; role: "admin" | "user" }) => {
    if (!d.userId) throw new Error("userId required");
    const role = d.role === "admin" ? "admin" : "user";
    return { userId: d.userId, role };
  })
  .handler(async ({ data, context }) => {
    const { userId } = context as any;
    await assertAdmin(userId);
    const sb = await admin();
    // Clear existing role rows, then insert the new one.
    await sb.from("user_roles").delete().eq("user_id", data.userId);
    const { error } = await sb
      .from("user_roles")
      .insert({ user_id: data.userId, role: data.role });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export { usernameFromEmail };
