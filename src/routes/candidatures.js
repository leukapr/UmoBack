// src/routes/candidatures.js
import express from "express";
import multer from "multer";
import { authMiddleware } from "../middlewares/authMiddleware.js";

const router = express.Router();
const storage = multer.memoryStorage();
const upload = multer({ storage });

/* ========== 🔐 POST /api/candidatures ========== */
router.post("/", authMiddleware, upload.single("cv"), async (req, res) => {
  const { nom, email, telephone, message = "", offre_id } = req.body;
  const cvFile = req.file;
  const user = req.user;
  const sb = req.sb; // ← client Supabase scopé au JWT

  if (!nom || !email || !telephone || !offre_id) {
    return res.status(400).json({ error: "Champs requis manquants." });
  }

  try {
    // 🔁 Anti-doublon : refuse si déjà postulé à cette offre
    const { data: existsRows, error: existsErr } = await sb
      .from("candidatures")
      .select("id")
      .eq("user_id", user.id)
      .eq("offre_id", offre_id)
      .limit(1);

    if (existsErr) {
      console.error("❌ Check duplicate candidature:", existsErr.message);
      return res
        .status(500)
        .json({ error: "Erreur vérification précédente candidature." });
    }
    if (Array.isArray(existsRows) && existsRows.length > 0) {
      return res
        .status(409)
        .json({ error: "Vous avez déjà postulé à cette offre." });
    }

    // 📁 Upload CV (optionnel)
    let cv_url = null;
    if (cvFile) {
      const safeName = cvFile.originalname.replace(/\s+/g, "_");
      const filename = `candidatures/${user.id}/${Date.now()}_${safeName}`;

      const { data: uploadData, error: uploadError } = await sb.storage
        .from("cvs")
        .upload(filename, cvFile.buffer, {
          contentType: cvFile.mimetype,
          upsert: false,
        });

      if (uploadError) {
        console.error("❌ Upload CV:", uploadError.message);
        return res.status(500).json({ error: "Échec upload CV." });
      }

      // Bucket public
      const { data: publicUrlData } = sb.storage
        .from("cvs")
        .getPublicUrl(uploadData.path);
      cv_url = publicUrlData.publicUrl;

      // Si bucket privé : générer une URL signée (ex.)
      // const { data: signed } = await sb.storage.from("cvs").createSignedUrl(uploadData.path, 60 * 60 * 24 * 7);
      // cv_url = signed.signedUrl;
    }

    // 💾 Insertion DB (RLS: user_id = req.user.id)
    const { data: inserted, error: insertError } = await sb
      .from("candidatures")
      .insert([
        {
          user_id: user.id,
          nom,
          email,
          telephone,
          message,
          offre_id,
          cv_url,
        },
      ])
      .select()
      .single();

    if (insertError) {
      console.error("❌ Insertion DB:", insertError.message);
      return res.status(500).json({ error: "Erreur insertion candidature." });
    }

    return res.status(201).json(inserted);
  } catch (err) {
    console.error("❌ Exception serveur:", err.message);
    return res.status(500).json({ error: "Erreur serveur." });
  }
});

/* ========== 🔐 GET /api/candidatures ========== */
router.get("/", authMiddleware, async (req, res) => {
  const user = req.user;
  const sb = req.sb; // ← important

  try {
    const { data, error } = await sb
      .from("candidatures")
      .select(
        `
        id,
        created_at,
        nom,
        email,
        telephone,
        cv_url,
        offre_id,
        offres (
          intitule,
          entreprise_nom
        )
      `
      )
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("❌ SELECT candidatures:", error.message);
      return res.status(500).json({ error: "Erreur lecture candidatures." });
    }

    const result = (data || []).map((c) => ({
      offre_id: c.offre_id, // ← essentiel pour activer l’étoile favoris côté Front
      id: c.id,
      titre: c.offres?.intitule || "Offre inconnue",
      entreprise: c.offres?.entreprise_nom || "N/A",
      date: c.created_at,
      status: "En attente",
      cv_url: c.cv_url ?? null,
    }));

    return res.json(result);
  } catch (err) {
    console.error("❌ Exception serveur:", err.message);
    return res.status(500).json({ error: "Erreur serveur." });
  }
});

/* ========== 🔐 GET /api/candidatures/check?offre_id=... ==========
   Optionnel : utile pour griser le bouton "Postuler" côté UI si déjà postulé */
router.get("/check", authMiddleware, async (req, res) => {
  const user = req.user;
  const sb = req.sb;
  const offreId = req.query.offre_id;
  if (!offreId) {
    return res.status(400).json({ error: "Paramètre offre_id requis." });
  }

  try {
    const { data, error } = await sb
      .from("candidatures")
      .select("id")
      .eq("user_id", user.id)
      .eq("offre_id", offreId)
      .limit(1);

    if (error) {
      console.error("❌ /api/candidatures/check:", error.message);
      return res.status(500).json({ error: "Erreur serveur." });
    }
    return res.json({ applied: Array.isArray(data) && data.length > 0 });
  } catch (e) {
    console.error("❌ /api/candidatures/check exception:", e);
    return res.status(500).json({ error: "Erreur serveur." });
  }
});

export default router;
