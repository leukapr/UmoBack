// src/routes/newsletters.js
import express from "express";
import { supabaseAdmin as supabase } from "../lib/supabaseClient.js";

const router = express.Router();

function isValidEmail(v = "") {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v).trim());
}

router.post("/", async (req, res) => {
  try {
    const { email, source = "footer", user_id = null } = req.body || {};
    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ error: "Email invalide." });
    }

    const ip =
      req.headers["cf-connecting-ip"] ||
      req.headers["x-forwarded-for"] ||
      req.ip ||
      null;
    const user_agent = req.get("user-agent") || null;

    const now = new Date().toISOString();
    const row = {
      email, // citext → insensible à la casse
      source,
      user_id: user_id || null,
      subscribed: true,
      unsubscribed_at: null,
      ip,
      user_agent,
      updated_at: now,
      // created_at géré par défaut SQL
    };

    // upsert sur email (unique index)
    const { data, error } = await supabase
      .from("newsletters")
      .upsert(row, { onConflict: "email" })
      .select("id,email,subscribed,created_at,updated_at")
      .single();

    if (error) {
      // Contrainte d’email (check/unique)
      if (
        String(error.message || "")
          .toLowerCase()
          .includes("email")
      ) {
        return res.status(400).json({ error: "Email invalide." });
      }
      console.error("newsletter upsert error:", error);
      return res.status(500).json({ error: "Erreur serveur." });
    }

    return res.status(201).json({ ok: true, data });
  } catch (err) {
    console.error("newsletter route exception:", err);
    return res.status(500).json({ error: "Erreur serveur." });
  }
});

export default router;
