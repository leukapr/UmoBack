// src/routes/franceTravail.js
import express from "express";
import { searchOffres } from "../lib/franceTravailClient.js";
import { supabaseAdmin as supabase } from "../lib/supabaseClient.js";
// Optionnel: protège la route si tu as un rôle admin
import { authMiddleware } from "../middlewares/authMiddleware.js";

const router = express.Router();

/**
 * GET /api/france-travail/offres
 * Proxie la recherche FT (utile pour debug côté client)
 * ex: /api/france-travail/offres?motsCles=react&departement=75&range=0-149
 */
router.get("/offres", async (req, res) => {
  try {
    const { range = "0-149", ...params } = req.query;
    const m = String(range).match(/^(\d+)-(\d+)$/);
    const safeRange = m ? range : "0-149";
    const data = await searchOffres({ params, range: safeRange });
    return res.json(data);
  } catch (e) {
    const msg =
      e?.response?.data?.message ||
      e?.response?.data?.error ||
      e?.message ||
      "Erreur France Travail";
    const code = e?.response?.status || 500;
    return res.status(code).json({ error: msg });
  }
});

/**
 * POST /api/france-travail/offres/sync
 * Body JSON:
 * {
 *   "params": { "motsCles":"react", "departement":"75" }, // tout filtre FT
 *   "range": "0-149" // optionnel (pagination FT)
 * }
 *
 * => Récupère les offres FT, les mappe, puis upsert dans table "offres"
 *    onConflict: provider,external_id
 *
 * ⚠️ Pense à protéger cette route (auth admin) si besoin.
 */
router.post("/offres/sync", authMiddleware, async (req, res) => {
  try {
    // Si tu as un système de rôle, décommente pour restreindre aux admins:
    // if (req.user?.role !== "admin") return res.status(403).json({ error: "Accès refusé" });

    const { params = {}, range = "0-149" } = req.body || {};
    const m = String(range).match(/^(\d+)-(\d+)$/);
    const safeRange = m ? range : "0-149";

    const raw = await searchOffres({ params, range: safeRange });
    const list = Array.isArray(raw?.resultats) ? raw.resultats : [];

    // Mapping FT -> colonnes locales "offres"
    const rows = list.map(mapFtToOffer);

    if (!rows.length) {
      return res.json({ fetched: 0, upserted: 0 });
    }

    // Upsert en chunks (au cas où)
    const chunkSize = 500;
    let upsertedTotal = 0;

    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);
      const { data, error } = await supabase.from("offres").upsert(chunk, {
        onConflict: "provider,external_id",
        ignoreDuplicates: false,
        returning: "minimal", // plus rapide
      });

      if (error) {
        // on loggue pour débogage, mais on continue pas
        console.error("Upsert offres FT error:", error);
        return res.status(500).json({ error: error.message });
      }

      // returning:"minimal" => pas de data; on compte via chunk.length
      upsertedTotal += chunk.length;
    }

    return res.json({
      fetched: rows.length,
      upserted: upsertedTotal,
      provider: "france_travail",
    });
  } catch (e) {
    console.error(e);
    const msg =
      e?.response?.data?.message ||
      e?.response?.data?.error ||
      e?.message ||
      "Erreur lors du sync FT";
    const code = e?.response?.status || 500;
    return res.status(code).json({ error: msg });
  }
});

/** ---------- Helpers ---------- **/

/**
 * Adapte ici vers TES colonnes de table "offres".
 * Champs proposés (classiques) + source_payload pour garder la donnée FT.
 */
function mapFtToOffer(o) {
  const lieu = o?.lieuTravail || {};
  const entreprise = o?.entreprise || {};
  const origine = o?.origineOffre || {};
  const salaire = o?.salaire || {};

  // Essaie de récupérer une URL publique vers l’offre
  const guessUrl =
    origine?.urlOrigine ||
    // certains partenaires collent une URL dans "contact.courriel"
    (typeof o?.contact?.courriel === "string"
      ? (o.contact.courriel.match(/https?:\/\/\S+/) || [])[0]
      : null) ||
    null;

  return {
    // 🔑 pour l’upsert
    provider: "france_travail",
    external_id: o?.id,

    // tes champs "métier" (adapte les noms si besoin)
    title: truncate(o?.intitule, 255),
    description: o?.description || null,
    company_name: truncate(entreprise?.nom, 255) || null,

    location_label: truncate(lieu?.libelle, 255) || null,
    city: truncate(lieu?.commune, 255) || null,
    postal_code: truncate(lieu?.codePostal, 20) || null,
    latitude: toNumber(lieu?.latitude),
    longitude: toNumber(lieu?.longitude),

    contract_type:
      truncate(o?.typeContratLibelle || o?.typeContrat, 120) || null,
    work_time:
      truncate(o?.dureeTravailLibelleConverti || o?.dureeTravailLibelle, 120) ||
      null,
    experience: truncate(o?.experienceLibelle, 120) || null,
    rome_code: truncate(o?.romeCode, 20) || null,
    rome_label: truncate(o?.romeLibelle, 255) || null,

    salary_text: truncate(salaire?.libelle, 255) || null,

    source_url: guessUrl,
    published_at: o?.dateCreation || null,
    updated_at_source: o?.dateActualisation || null,

    is_active: true, // à toi d’ajuster si tu gères l’archivage

    // garde la réponse brute pour enrichissements ultérieurs (JSONB)
    source_payload: o,
  };
}

function truncate(v, max) {
  if (v == null) return v;
  const s = String(v);
  return s.length > max ? s.slice(0, max) : s;
}

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export default router;
