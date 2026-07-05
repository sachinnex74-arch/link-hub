import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.TMS_SUPABASE_URL, process.env.TMS_SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false }});

// Test if profiles table exists
const t = await sb.from('profiles').select('id').limit(1);
console.log('profiles:', t.error ? ('ERR: '+t.error.message) : 'OK', t.data);
const r = await sb.from('user_roles').select('user_id').limit(1);
console.log('user_roles:', r.error ? ('ERR: '+r.error.message) : 'OK');

// Check users
const list = await sb.auth.admin.listUsers({ page:1, perPage: 100 });
console.log('users count:', list.data?.users?.length, list.error?.message);
const admin = list.data?.users?.find(u=>u.email==='admin@tms.local');
console.log('admin user:', admin ? admin.id : 'NOT FOUND');
