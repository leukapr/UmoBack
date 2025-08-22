import express from "express";
import multer from "multer";
import { supabaseAdmin as supabase } from "../lib/supabaseClient.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";

const router = express.Router();
const storage = multer.memoryStorage();
const upload = multer({ storage });

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
      .select("id, email, prenom, nom, role, telephone, cv_url")
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
      .select("id, email, prenom, nom, avatar_url, role, cv_url")
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
        .update({ cv_url: publicUrl })
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

export default router;
