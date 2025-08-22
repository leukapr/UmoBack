import { createClient } from "@supabase/supabase-js";

// Client public (utilise la clé anonyme)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_API_KEY
);

// Client admin pour opérations critiques (ex: createUser)
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    global: {
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    },
  }
);

/**
 * Crée un client Supabase scoped sur le JWT utilisateur
 * à utiliser dans les routes protégées pour respecter le RLS
 */
function supabaseForToken(accessToken) {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_API_KEY, {
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        apikey: process.env.SUPABASE_API_KEY,
      },
    },
  });
}

export { supabase, supabaseAdmin, supabaseForToken };
export default supabase;
