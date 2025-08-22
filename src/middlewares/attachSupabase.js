// src/middlewares/attachSupabase.js
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_API_KEY = process.env.SUPABASE_API_KEY; // 🔹 aligné avec lib/supabaseClient.js

export function attachSupabase(req, _res, next) {
  // si l’authMiddleware a déjà mis req.sb (user connecté), on ne touche à rien
  if (req.sb) return next();

  // sinon on attache un client "anon" (RLS = rôle anon)
  req.sb = createClient(SUPABASE_URL, SUPABASE_API_KEY, {
    global: { headers: { Authorization: req.headers.authorization || "" } },
  });

  next();
}
