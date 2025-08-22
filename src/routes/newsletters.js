// src/routes/newsletters.js
import express from "express";
import rateLimit from "express-rate-limit";
import { supabaseAdmin as supabase } from "../lib/supabaseClient.js";

const router = express.Router();

// Limite douce : 50 inscriptions / h / IP
const limiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
});
router.use(limiter);

router.post("/", async (req, res) => {
  try {
    const { email, source = "footer" } = req.body || {};
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "Email invalide" });
    }

    const ip =
      String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "")
        .split(",")[0]
        .trim() || null;
    const userAgent = req.headers["user-agent"] || null;
    const userId = req.user?.id || req.user?.sub || null; // si authMiddleware a rempli req.user

    // Upsert : réactive l’abonnement si l’email existe déjà
    const { data, error } = await supabase
      .from("newsletters")
      .upsert(
        {
          email,
          source,
          ip,
          user_agent: userAgent,
          user_id: userId,
          subscribed: true,
          unsubscribed_at: null,
        },
        { onConflict: "email", ignoreDuplicates: false }
      )
      .select("id, email")
      .single();

    if (error) {
      console.error("Newsletter upsert error:", error);
      return res.status(500).json({ error: "Erreur serveur" });
    }

    return res.status(201).json({ ok: true, id: data.id });
  } catch (e) {
    console.error("Newsletter route error:", e);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

export default router;
