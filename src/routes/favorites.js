// src/routes/favorites.js
import express from "express";
import supabase from "../lib/supabaseClient.js";

const router = express.Router();

const OFFRES_VIEW = process.env.OFFRES_VIEW_NAME || "offres_public";
const FAV_TABLE = process.env.FAVORITES_TABLE_NAME || "favoris";

function getSb(req) {
  return req.sb ?? supabase;
}
function getUserId(req) {
  return req.user?.id || req.user?.sub || null;
}

/* --- Debug: permet de vérifier que le router est bien monté --- */
router.get("/__ping", (_req, res) =>
  res.json({ ok: true, route: "favorites" })
);

/* ------------------------------------------------------------------
   GET /api/favorites
   → Renvoie la liste d'OFFRES favorites de l’utilisateur (jointure IN)
------------------------------------------------------------------- */
router.get("/", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const sb = getSb(req);
    const page = Math.max(1, Number(req.query.page || 1));
    const size = Math.min(200, Math.max(1, Number(req.query.size || 50)));
    const from = (page - 1) * size;
    const to = from + size - 1;

    const {
      data: favRows,
      count,
      error: favErr,
    } = await sb
      .from(FAV_TABLE)
      .select("offre_id", { count: "exact" })
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .range(from, to);

    if (favErr) return res.status(400).json({ error: favErr.message });

    const ids = (favRows || []).map((r) => r.offre_id);
    if (!ids.length) {
      res.setHeader("X-Total-Count", String(count ?? 0));
      return res.json([]);
    }

    const { data: offres, error: offresErr } = await sb
      .from(OFFRES_VIEW)
      .select("*")
      .in("id", ids);

    if (offresErr) return res.status(400).json({ error: offresErr.message });

    // Conserver l’ordre récent (même ordre que favoris)
    const order = new Map(ids.map((id, i) => [id, i]));
    const sorted = (offres || []).slice().sort((a, b) => {
      const ia = order.get(a.id) ?? 0;
      const ib = order.get(b.id) ?? 0;
      return ia - ib;
    });

    res.setHeader("X-Total-Count", String(count ?? ids.length));
    return res.json(sorted);
  } catch (e) {
    console.error("favorites GET / error:", e);
    return res.status(500).json({ error: "Erreur liste favoris" });
  }
});

/* ------------------------------------------------------------------
   GET /api/favorites/ids
   → Renvoie uniquement la liste des UUID d’offres favorites
------------------------------------------------------------------- */
router.get("/ids", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const sb = getSb(req);
    const { data, error } = await sb
      .from(FAV_TABLE)
      .select("offre_id")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(5000);

    if (error) return res.status(400).json({ error: error.message });
    return res.json((data || []).map((r) => r.offre_id));
  } catch (e) {
    console.error("favorites GET /ids error:", e);
    return res.status(500).json({ error: "Erreur lecture ids favoris" });
  }
});

/* ------------------------------------------------------------------
   POST /api/favorites/:offreId  (ajout)
------------------------------------------------------------------- */
router.post("/:offreId", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const offreId = req.params.offreId;
    if (!offreId) return res.status(400).json({ error: "offreId requis" });

    const sb = getSb(req);
    const { error } = await sb
      .from(FAV_TABLE)
      .insert([{ user_id: userId, offre_id: offreId }]);

    if (error) {
      if (error.code === "23505" || /duplicate/i.test(error.message)) {
        return res.status(200).json({ ok: true, duplicate: true });
      }
      if (error.code === "23503") {
        return res
          .status(400)
          .json({ error: "OFFRE_ID_INVALIDE (FK)", details: error.message });
      }
      return res.status(400).json({ error: error.message });
    }
    return res.status(201).json({ ok: true });
  } catch (e) {
    console.error("favorites POST param error:", e);
    return res.status(500).json({ error: "Erreur ajout favori" });
  }
});

/* ------------------------------------------------------------------
   POST /api/favorites  (ajout par body {offre_id})
------------------------------------------------------------------- */
router.post("/", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const offreId = req.body?.offre_id;
    if (!offreId) return res.status(400).json({ error: "offre_id requis" });

    const sb = getSb(req);
    const { error } = await sb
      .from(FAV_TABLE)
      .insert([{ user_id: userId, offre_id: offreId }]);

    if (error) {
      if (error.code === "23505" || /duplicate/i.test(error.message)) {
        return res.status(200).json({ ok: true, duplicate: true });
      }
      if (error.code === "23503") {
        return res
          .status(400)
          .json({ error: "OFFRE_ID_INVALIDE (FK)", details: error.message });
      }
      return res.status(400).json({ error: error.message });
    }
    return res.status(201).json({ ok: true });
  } catch (e) {
    console.error("favorites POST body error:", e);
    return res.status(500).json({ error: "Erreur ajout favori (body)" });
  }
});

/* ------------------------------------------------------------------
   DELETE /api/favorites/:offreId  (suppression)
------------------------------------------------------------------- */
router.delete("/:offreId", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const offreId = req.params.offreId;
    if (!offreId) return res.status(400).json({ error: "offreId requis" });

    const sb = getSb(req);
    const { error } = await sb
      .from(FAV_TABLE)
      .delete()
      .eq("user_id", userId)
      .eq("offre_id", offreId);

    if (error) return res.status(400).json({ error: error.message });
    return res.json({ ok: true });
  } catch (e) {
    console.error("favorites DELETE error:", e);
    return res.status(500).json({ error: "Erreur suppression favori" });
  }
});

export default router;
