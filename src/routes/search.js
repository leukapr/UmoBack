import express from "express";
import supabase from "../lib/supabaseClient.js";

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    let query = supabase.from("offres").select("*");

    // 🔍 Recherche texte
    const { intitule, ville, rayon } = req.query;

    if (intitule) {
      query = query.ilike("intitule", `%${intitule}%`);
    }

    if (ville) {
      query = query.ilike("lieu", `%${ville}%`);
    }

    // 🎯 Filtres multiples (en CSV dans la query string)
    const multiValuedFilters = [
      "type_contrat",
      "secteur_activite",
      "niveau_etude_requis",
      "experience_requise",
      "lieu",
      "code_postal",
    ];

    multiValuedFilters.forEach((filterKey) => {
      const rawValue = req.query[filterKey];
      if (rawValue) {
        const values = rawValue.split(",").map((v) => v.trim());
        query = query.in(filterKey, values);
      }
    });

    // ✅ Filtre booléen spécifique
    if (req.query.teletravail_possible) {
      const val = req.query.teletravail_possible === "true";
      query = query.eq("teletravail_possible", val);
    }

    // 📊 Salaire min
    if (req.query.salaire_min) {
      query = query.gte("salaire_min", Number(req.query.salaire_min));
    }

    // ⏳ Ordre par date (optionnel)
    query = query.order("created_at", { ascending: false });

    const { data, error } = await query;

    if (error) {
      console.error("❌ Supabase erreur recherche :", error.message);
      return res.status(500).json({ error: "Erreur recherche offres." });
    }

    res.json(data);
  } catch (e) {
    console.error("❌ Exception recherche :", e.message);
    res.status(500).json({ error: "Erreur serveur recherche." });
  }
});

export default router;
