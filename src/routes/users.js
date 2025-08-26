import express from "express";
import multer from "multer";
import { supabaseAdmin as supabase } from "../lib/supabaseClient.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";

const router = express.Router();
const storage = multer.memoryStorage();
const upload = multer({ storage });

/* ---------------------------- Helpers ---------------------------- */
function normalizePhone(input = "") {
  // garde uniquement les chiffres, tronque à 10
  return String(input).replace(/\D+/g, "").slice(0, 10);
}

function getStoragePathFromPublicUrl(publicUrl) {
  // public:  https://<proj>.supabase.co/storage/v1/object/public/cvs/<path>
  // retourne: <path>
  if (!publicUrl) return null;
  const marker = "/storage/v1/object/public/cvs/";
  const idx = publicUrl.indexOf(marker);
  if (idx === -1) return null;
  return publicUrl.slice(idx + marker.length);
}

/* ------------------------------ Routes ------------------------------ */

/**
 * ✅ GET /api/users/me — Profil utilisateur actuel (via token)
 */
router.get("/me", authMiddleware, async (req, res) => {
  const userId = req.user?.id || req.user?.sub;

  if (!userId) {
    return res.status(401).json({ error: "Non authentifié" });
  }

  try {
    const { data, error } = await supabase
      .from("user_profiles")
      .select(
        "id, email, prenom, nom, role, telephone, cv_url, avatar_url, updated_at, created_at"
      )
      .eq("id", userId)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: "Utilisateur non trouvé" });
    }

    res.status(200).json(data);
  } catch (err) {
    console.error("❌ Erreur serveur:", err.message);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

/**
 * 🔍 GET /api/users/:id — Profil par ID (authentifié et restreint)
 */
router.get("/:id", authMiddleware, async (req, res) => {
  const { id } = req.params;

  if (!req.user?.id) {
    console.warn("⛔ Aucun utilisateur authentifié.");
    return res.status(401).json({ error: "Authentification requise." });
  }

  if (id !== req.user.id) {
    console.warn(`🔐 Accès refusé : ${id} ≠ ${req.user.id}`);
    return res.status(403).json({ error: "Accès interdit." });
  }

  try {
    const { data, error } = await supabase
      .from("user_profiles")
      .select(
        "id, email, prenom, nom, telephone, avatar_url, role, cv_url, updated_at, created_at"
      )
      .eq("id", id)
      .single();

    if (error || !data) {
      console.error("❌ Utilisateur introuvable :", error?.message);
      return res.status(404).json({ error: "Utilisateur non trouvé." });
    }

    res.json(data);
  } catch (err) {
    console.error("❌ Erreur serveur :", err.message);
    res.status(500).json({ error: "Erreur serveur." });
  }
});

/**
 * ✏️ PATCH /api/users/:id — Mettre à jour prénom/nom/téléphone
 *  - Email NON modifiable
 *  - Téléphone: 10 chiffres (constraint 'telephone_format')
 */
router.patch("/:id", authMiddleware, async (req, res) => {
  const { id } = req.params;

  if (!req.user?.id) {
    return res.status(401).json({ error: "Authentification requise." });
  }
  if (id !== req.user.id) {
    return res.status(403).json({ error: "Accès interdit." });
  }

  // Interdire toute tentative de modifier l'email
  if ("email" in req.body) {
    return res
      .status(400)
      .json({ error: "Le champ email n'est pas modifiable." });
  }

  const update = {};
  if (typeof req.body.prenom === "string")
    update.prenom = req.body.prenom.trim();
  if (typeof req.body.nom === "string") update.nom = req.body.nom.trim();

  if (typeof req.body.telephone === "string") {
    const normalized = normalizePhone(req.body.telephone);
    if (normalized && normalized.length !== 10) {
      return res
        .status(422)
        .json({ error: "Numéro invalide (10 chiffres attendus)." });
    }
    update.telephone = normalized || null; // null autorisé si l'utilisateur efface
  }

  if (!Object.keys(update).length) {
    return res.status(400).json({ error: "Aucune modification." });
  }

  update.updated_at = new Date().toISOString();

  try {
    const { data, error } = await supabase
      .from("user_profiles")
      .update(update)
      .eq("id", id)
      .select("*")
      .single();

    if (error) {
      const code = error.code || "";
      const msg = error.message || "";

      if (code === "23505" || /duplicate key value|unique/i.test(msg)) {
        // unicité (ex: unique_telephone)
        if (/unique_telephone/i.test(msg)) {
          return res.status(409).json({ error: "Ce numéro est déjà utilisé." });
        }
        return res.status(409).json({ error: "Contrainte d'unicité violée." });
      }
      if (code === "23514" || /telephone_format/i.test(msg)) {
        return res
          .status(422)
          .json({ error: "Numéro invalide (10 chiffres attendus)." });
      }

      console.error("❌ Update profil:", error);
      return res.status(500).json({ error: "Erreur serveur." });
    }

    return res.json(data);
  } catch (err) {
    console.error("❌ Exception PATCH:", err);
    return res.status(500).json({ error: "Erreur serveur." });
  }
});

/**
 * 📤 POST /api/users/:id/upload-cv — Upload de CV PDF vers Supabase Storage
 */
router.post(
  "/:id/upload-cv",
  authMiddleware,
  upload.single("cv"),
  async (req, res) => {
    const { id } = req.params;
    const file = req.file;

    if (!req.user?.id || id !== req.user.id) {
      console.warn(`⛔ Upload refusé : ${id} ≠ ${req.user?.id}`);
      return res.status(403).json({ error: "Accès non autorisé." });
    }

    if (!file || !file.originalname.toLowerCase().endsWith(".pdf")) {
      return res.status(400).json({ error: "Un fichier PDF est requis." });
    }

    try {
      const filePath = `users/${id}/cv_${Date.now()}_${file.originalname}`;
      const { data: uploadData, error: uploadError } = await supabase.storage
        .from("cvs")
        .upload(filePath, file.buffer, { contentType: file.mimetype });

      if (uploadError) {
        console.error("❌ Upload échoué :", uploadError.message);
        return res.status(500).json({ error: "Échec de l'envoi du CV." });
      }

      const publicUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/cvs/${uploadData.path}`;

      const { error: updateError } = await supabase
        .from("user_profiles")
        .update({ cv_url: publicUrl, updated_at: new Date().toISOString() })
        .eq("id", id);

      if (updateError) {
        console.error("❌ Mise à jour profil :", updateError.message);
        return res
          .status(500)
          .json({ error: "Impossible de mettre à jour le profil." });
      }

      res.status(200).json({ cv_url: publicUrl });
    } catch (err) {
      console.error("❌ Exception serveur :", err.message);
      res.status(500).json({ error: "Erreur interne." });
    }
  }
);

/**
 * 🗑️ DELETE /api/users/:id/cv — Supprimer le CV du storage et du profil
 */
router.delete("/:id/cv", authMiddleware, async (req, res) => {
  const { id } = req.params;

  if (!req.user?.id || id !== req.user.id) {
    return res.status(403).json({ error: "Accès non autorisé." });
  }

  try {
    // Récupérer l'URL actuelle
    const { data: prof, error: readErr } = await supabase
      .from("user_profiles")
      .select("cv_url")
      .eq("id", id)
      .single();

    if (readErr) {
      console.error("❌ Lecture profil:", readErr.message);
      return res.status(500).json({ error: "Erreur serveur." });
    }

    const path = getStoragePathFromPublicUrl(prof?.cv_url);
    if (path) {
      const { error: delErr } = await supabase.storage
        .from("cvs")
        .remove([path]);
      if (delErr) {
        console.error("❌ Suppression fichier:", delErr.message);
        // On continue malgré tout pour nettoyer la base
      }
    }

    const { error: updErr } = await supabase
      .from("user_profiles")
      .update({ cv_url: null, updated_at: new Date().toISOString() })
      .eq("id", id);

    if (updErr) {
      console.error("❌ Mise à jour profil:", updErr.message);
      return res
        .status(500)
        .json({ error: "Impossible de mettre à jour le profil." });
    }

    return res.status(200).json({ cv_url: null });
  } catch (err) {
    console.error("❌ Exception DELETE CV:", err.message);
    return res.status(500).json({ error: "Erreur interne." });
  }
});

export default router;
