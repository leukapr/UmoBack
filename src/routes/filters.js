// src/routes/filters.js
import express from "express";
import supabase from "../lib/supabaseClient.js";

const router = express.Router();

/**
 * GET /api/filters
 * Exemples :
 *   /api/filters?q=react&departement=31
 *   /api/filters?provider=france_travail&type_contrat=CDI&postedWithin=7d
 *
 * Ne renvoie QUE { total } pour afficher "X offres d'emploi".
 * (La fonction SQL facets_offres(...) doit être créée côté DB)
 */
router.get("/", async (req, res) => {
  try {
    const sb = req.sb ?? supabase;

    // Récupération & normalisation légère des filtres
    const {
      q = null,
      departement = null,
      provider = null,
      type_contrat = null,
      experience = null,
      postedWithin = null, // '24h' | '7d' | '30d'
    } = req.query;

    const allowedPosted = new Set(["24h", "7d", "30d"]);
    const posted =
      typeof postedWithin === "string" &&
      allowedPosted.has(postedWithin.toLowerCase())
        ? postedWithin.toLowerCase()
        : null;

    // Appel RPC (doit exister : public.facets_offres(...))
    const { data, error } = await sb.rpc("facets_offres", {
      p_q: q || null,
      p_departement: departement || null,
      p_provider: provider || null,
      p_type_contrat: type_contrat || null,
      p_experience: experience || null,
      p_posted_within: posted,
    });

    if (error) {
      console.error("❌ facets_offres RPC error:", error.message);
      return res
        .status(400)
        .json({ error: "Erreur lors du calcul des filtres." });
    }

    // On renvoie UNIQUEMENT le total (conforme à ta demande)
    const total =
      Array.isArray(data) && data[0] ? Number(data[0].total) || 0 : 0;
    return res.json({ total });
  } catch (e) {
    console.error("❌ /api/filters:", e?.message || e);
    return res.status(500).json({ error: "Erreur interne serveur" });
  }
});

export default router;
