const { createClient } = require('@supabase/supabase-js');

function projectConfig() {
  const url = process.env.SUPABASE_URL?.trim();
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY?.trim();

  if (!url || !publishableKey) {
    throw new Error('SUPABASE_URL y SUPABASE_PUBLISHABLE_KEY deben estar configuradas para DATA_BACKEND=supabase.');
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error('SUPABASE_URL debe ser una URL válida de Supabase Cloud.');
  }
  if (parsedUrl.protocol !== 'https:' || !parsedUrl.hostname.endsWith('.supabase.co')) {
    throw new Error('SUPABASE_URL debe apuntar a un proyecto Supabase Cloud mediante HTTPS.');
  }
  if (!publishableKey.startsWith('sb_publishable_')) {
    throw new Error('SUPABASE_PUBLISHABLE_KEY debe ser una clave publishable; no uses claves secret o service_role.');
  }

  return { url, publishableKey };
}

function createSupabaseClient() {
  const { url, publishableKey } = projectConfig();
  return createClient(url, publishableKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false
    }
  });
}

function createSupabaseAdminClient() {
  const { url } = projectConfig();
  const secretKey = process.env.SUPABASE_SECRET_KEY?.trim();
  if (!secretKey || !secretKey.startsWith('sb_secret_')) {
    throw new Error('SUPABASE_SECRET_KEY debe ser una clave secret del servidor; no uses una clave publishable ni service_role antigua.');
  }
  return createClient(url, secretKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false
    }
  });
}

module.exports = { createSupabaseClient, createSupabaseAdminClient };
