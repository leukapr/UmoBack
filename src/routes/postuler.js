// src/routes/postuler.js
import express from "express";
import multer from "multer";
import { supabaseAdmin as supabase } from "../lib/supabaseClient.js";

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 Mo
});

async function getUserIdFromAuth(req) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return null;
  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error) return null;
    return data.user?.id || null;
  } catch {
    return null;
  }
}

router.post("/", upload.single("cv"), async (req, res) => {
  try {
    const user_id = await getUserIdFromAuth(req);

    const b = req.body || {};
    const offre_id = (b.offre_id || "").toString().trim();
    const prenom = (b.prenom || "").toString().trim();
    const nom = (b.nom || "").toString().trim();
    const email = (b.email || "").toString().trim();
    const message = (b.message || "").toString().trim() || null;

    // téléphone optionnel
    let telephone = null;
    if (b.telephone) {
      const digits = String(b.telephone).replace(/\D+/g, "");
      telephone = digits.length ? digits : null;
    }

    // validations
    if (!offre_id) return res.status(422).json({ error: "offre_id requis" });
    if (!email) return res.status(422).json({ error: "email requis" });
    if (!nom && !prenom)
      return res.status(422).json({ error: "nom ou prénom requis" });

    const nomComplet = nom || prenom;

    // CV: url fournie OU upload fichier
    let cv_url = b.cv_url || null;
    if (!cv_url && req.file) {
      const ext = (
        req.file.originalname.split(".").pop() || "pdf"
      ).toLowerCase();
      const key = `postuler/${user_id || "anon"}/${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from("cvs")
        .upload(key, req.file.buffer, {
          contentType: req.file.mimetype || "application/pdf",
          upsert: false,
        });
      if (upErr) {
        console.error("Upload CV error:", upErr);
        return res.status(500).json({ error: "Échec upload CV" });
      }
      cv_url = `${process.env.SUPABASE_URL}/storage/v1/object/public/cvs/${key}`;
    }

    const insert = {
      offre_id,
      nom: nomComplet,
      email,
      message,
      telephone, // peut être NULL
      cv_url: cv_url || null,
      user_id: user_id || null,
      status: "En attente",
    };

    const { data, error } = await supabase
      .from("candidatures")
      .insert(insert)
      .select("*")
      .single();

    if (error) {
      console.error("Insert candidatures (postuler) error:", error);
      return res.status(500).json({ error: "Erreur serveur" });
    }

    return res.status(201).json(data);
  } catch (err) {
    console.error("POST /postuler error:", err);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

export default router;
