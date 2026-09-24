import { supabase } from './auth.js';

// Role ladder: superadmin > admin > developer. The row comes from the server
// session (RLS-filtered to self) — unforgeable from the device. Fail closed:
// unknown or unreachable means plain user.
let cached = null;

export async function myRole() {
  if (cached) return cached;
  try {
    const { data } = await supabase.from('user_roles').select('role').limit(1).maybeSingle();
    cached = data?.role || null;
  } catch {
    cached = null;
  }
  return cached;
}

export async function isAdmin() {
  const r = await myRole();
  return r === 'admin' || r === 'superadmin';
}

export async function isSuperadmin() {
  return (await myRole()) === 'superadmin';
}
