// @ts-nocheck
// SGR Work Order System — user management, callable only by MD or Admin.
//
// Why this exists: creating or changing a login needs Supabase's admin (service_role) key, which must
// never be placed in a website. This function runs inside Supabase (where the admin key is available)
// and only acts after checking, in the app.users table, that the caller is MD or Admin.
//
// Named `manage-app-users` (not `manage-users`) so it never collides with the smkrmuthu/sgrApp
// prototype's own Edge Function of a similar name, deployed on this same Supabase project.
//
// Deploy (once): see docs/SETUP.md.
//
// Supabase's platform-level "Verify JWT" check only understands its older (legacy) signing keys and
// rejects logins on newer projects before this code even runs. So the client sends the project's public
// key as the normal Authorization header (which the platform accepts) and the person's login in
// `x-user-token`. The login is then verified here with getUser(), which works with any signing key.
//
// Requests are POST with a JSON body: { action: "list" | "create" | "update" | "delete", ... }

const ROLES = ["creator", "planner", "qc", "finance", "md", "admin"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;

// Browsers may only call this function from the live site, from a page opened straight from disk
// ("null"), or from your own computer (localhost). The login token is what protects the function;
// this list only decides which web pages a browser lets call it. smkrmuthu.github.io covers both the
// prototype and this app — a check is by origin (scheme+host+port), never by path.
const ALLOWED_ORIGINS = ["https://smkrmuthu.github.io", "https://sgr.oneuptech.co", "null"];
const isLocalPage = (origin) => /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);

const clean = (v) => (typeof v === "string" ? v.trim() : "");

function corsHeaders(req) {
  const origin = req.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) || isLocalPage(origin) ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-user-token",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function friendly(error) {
  const m = (error && error.message) || "Something went wrong.";
  if (/already (been )?registered|already exists/i.test(m)) return "A user with this email already exists.";
  return m;
}

// admin = a Supabase client created with the service-role key, scoped to the app schema.
export async function handle(req, admin) {
  const headers = { ...corsHeaders(req), "Content-Type": "application/json" };
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers });

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return reply(405, { error: "Use POST." });

  // 1. Who is calling? The site sends the person's login token in x-user-token (see the note at the top).
  //    Authorization is accepted too, for callers that send the login there.
  const token = (req.headers.get("x-user-token") || req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return reply(401, { error: "Not signed in." });
  const { data: who, error: whoError } = await admin.auth.getUser(token);
  if (whoError || !who || !who.user) return reply(401, { error: "Not signed in." });
  const caller = who.user;

  // 2. Are they MD or Admin? Decided by the database row, never by anything the browser claims.
  const { data: me, error: meError } = await admin.from("users").select("role,is_active").eq("id", caller.id).maybeSingle();
  // A failed lookup is a server problem, not "you're not allowed" — say so instead of a misleading 403.
  if (meError) return reply(500, { error: `Couldn't check your role: ${meError.message}` });
  if (!me || !me.is_active || !["md", "admin"].includes(me.role)) return reply(403, { error: "Only MD or Admin can manage users." });

  let body;
  try { body = await req.json(); } catch (e) { return reply(400, { error: "Bad request." }); }

  const roleCount = async (role) => {
    const { count } = await admin.from("users").select("id", { count: "exact", head: true }).eq("role", role);
    return count || 0;
  };

  // ---------------------------------------------------------------- list
  if (body.action === "list") {
    const { data: users, error } = await admin.from("users")
      .select("id,email,full_name,role,is_active,created_at").order("created_at", { ascending: true });
    if (error) return reply(500, { error: error.message });
    const { data: listed } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    const lastSeen = new Map(((listed && listed.users) || []).map((u) => [u.id, u.last_sign_in_at || null]));
    return reply(200, { users: users.map((u) => ({ ...u, last_sign_in_at: lastSeen.get(u.id) || null })) });
  }

  // ---------------------------------------------------------------- create
  if (body.action === "create") {
    const email = clean(body.email).toLowerCase();
    const password = typeof body.password === "string" ? body.password : "";
    const fullName = clean(body.full_name);
    const role = body.role || "creator";
    if (!EMAIL_RE.test(email)) return reply(400, { error: "Enter a valid email address." });
    if (password.length < MIN_PASSWORD) return reply(400, { error: `Password must be at least ${MIN_PASSWORD} characters.` });
    if (!ROLES.includes(role)) return reply(400, { error: "Unknown role." });

    const { data: created, error } = await admin.auth.admin.createUser({
      email, password, email_confirm: true, user_metadata: { full_name: fullName },
    });
    if (error) return reply(400, { error: friendly(error) });

    const { error: userError } = await admin.from("users")
      .upsert({ id: created.user.id, email, full_name: fullName, role });
    if (userError) {
      await admin.auth.admin.deleteUser(created.user.id);      // don't leave a login with no role behind
      return reply(500, { error: "Could not save the user's role. Nothing was created." });
    }
    return reply(200, { user: { id: created.user.id, email, full_name: fullName, role } });
  }

  // ---------------------------------------------------------------- update
  if (body.action === "update") {
    const id = clean(body.id);
    if (!id) return reply(400, { error: "Missing user." });
    const { data: target } = await admin.from("users").select("id,role").eq("id", id).maybeSingle();
    if (!target) return reply(404, { error: "User not found." });

    const role = body.role === undefined ? target.role : body.role;
    if (!ROLES.includes(role)) return reply(400, { error: "Unknown role." });
    // A role change (or deactivation, below) may not remove the last MD or the last Admin — the two
    // roles that can reach this function at all — so nobody can lock everyone else out by accident.
    if (target.role !== role && ["md", "admin"].includes(target.role) && (await roleCount(target.role)) <= 1) {
      return reply(400, { error: `There must always be at least one ${target.role === "md" ? "MD" : "Admin"}.` });
    }

    const authChanges = {};
    const userChanges = { role };
    if (body.email !== undefined) {
      const email = clean(body.email).toLowerCase();
      if (!EMAIL_RE.test(email)) return reply(400, { error: "Enter a valid email address." });
      authChanges.email = email; authChanges.email_confirm = true; userChanges.email = email;
    }
    if (body.password) {
      if (typeof body.password !== "string" || body.password.length < MIN_PASSWORD) {
        return reply(400, { error: `Password must be at least ${MIN_PASSWORD} characters.` });
      }
      authChanges.password = body.password;
    }
    if (body.full_name !== undefined) {
      userChanges.full_name = clean(body.full_name);
      authChanges.user_metadata = { full_name: userChanges.full_name };
    }
    if (body.is_active !== undefined) {
      if (body.is_active === false && ["md", "admin"].includes(target.role) && (await roleCount(target.role)) <= 1) {
        return reply(400, { error: `There must always be at least one active ${target.role === "md" ? "MD" : "Admin"}.` });
      }
      userChanges.is_active = !!body.is_active;
    }

    if (Object.keys(authChanges).length) {
      const { error } = await admin.auth.admin.updateUserById(id, authChanges);
      if (error) return reply(400, { error: friendly(error) });
    }
    const { error: userError } = await admin.from("users").update(userChanges).eq("id", id);
    if (userError) return reply(500, { error: userError.message });
    return reply(200, { ok: true });
  }

  // ---------------------------------------------------------------- delete
  if (body.action === "delete") {
    const id = clean(body.id);
    if (!id) return reply(400, { error: "Missing user." });
    if (id === caller.id) return reply(400, { error: "You can't delete your own login." });
    const { data: target } = await admin.from("users").select("role").eq("id", id).maybeSingle();
    if (target && ["md", "admin"].includes(target.role) && (await roleCount(target.role)) <= 1) {
      return reply(400, { error: `There must always be at least one ${target.role === "md" ? "MD" : "Admin"}.` });
    }
    const { error } = await admin.auth.admin.deleteUser(id);
    if (error) {
      // Work Orders, approvals, inspections etc. point at the person who did them, so the database refuses
      // to remove anyone with history. Say what to do instead of showing a raw "Database error".
      if (/database error|foreign key|violat/i.test(error.message || "")) {
        return reply(400, { error: "This person already has activity on record (Work Orders, approvals, inspections…), so they can't be deleted. Untick Active instead — that stops them signing in to anything and keeps the history intact." });
      }
      return reply(400, { error: friendly(error) });
    }
    return reply(200, { ok: true });          // the app.users row goes with it (on delete cascade)
  }

  return reply(400, { error: "Unknown action." });
}

// Started by Supabase; skipped when this file is imported by tests.
if (typeof Deno !== "undefined" && Deno.serve) {
  const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2.117.2");
  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: "app" },
  });
  Deno.serve((req) => handle(req, admin));
}
