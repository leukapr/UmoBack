// src/routes/files.js
import express from "express";
import multer from "multer";
import path from "path";
import { supabaseAdmin as supabase } from "../lib/supabaseClient.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";
import { fileUrlLimiter } from "../middlewares/rateLimiter.js";

const router = express.Router();

// Limites alignées avec le front (8 Mo)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
});

// ✅ POST /api/files (public/anonyme) — attendu par le front
router.post("/", upload.single("file"), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: "Aucun fichier reçu." });

    const ext = path.extname(file.originalname).toLowerCase();
    const allowed = [".pdf", ".doc", ".docx"];
    if (!allowed.includes(ext)) {
      return res.status(415).json({ error: "Type de fichier non autorisé." });
    }

    const today = new Date().toISOString().slice(0, 10);
    const key = `spontanees/${today}/${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}${ext}`;

    const { data, error } = await supabase.storage
      .from("cvs")
      .upload(key, file.buffer, {
        contentType: file.mimetype || "application/octet-stream",
        upsert: false,
      });

    if (error) {
      console.error("Upload storage error:", error.message);
      return res.status(500).json({ error: "Upload échoué." });
    }

    // Le bucket "cvs" doit être PUBLIC en lecture (sinon génère une signed URL)
    const publicUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/cvs/${data.path}`;

    return res.json({
      url: publicUrl,
      path: data.path,
      filename: file.originalname,
      mime: file.mimetype,
      size: file.size,
    });
  } catch (e) {
    console.error("POST /api/files exception:", e);
    return res.status(500).json({ error: "Erreur interne." });
  }
});

// 🔐 Option existante: POST /api/files/signed-url (protégée)
router.post("/signed-url", authMiddleware, fileUrlLimiter, async (req, res) => {
  const { path: objectPath, expiresIn } = req.body; // éviter le conflit avec le module 'path'
  if (!objectPath) {
    return res.status(400).json({ error: "Le champ 'path' est requis." });
  }

  try {
    const { data, error } = await supabase.storage
      .from("cvs")
      .createSignedUrl(objectPath, Number(expiresIn) || 60);

    if (error) {
      console.error("Signed URL error:", error.message);
      return res
        .status(500)
        .json({ error: "Erreur lors de la création de l'URL signée." });
    }

    return res.status(200).json({ signedUrl: data.signedUrl });
  } catch (err) {
    console.error("POST /api/files/signed-url exception:", err);
    return res.status(500).json({ error: "Erreur interne." });
  }
});

export default router;
