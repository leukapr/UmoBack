// ⚙️ Dépendances
const express = require("express");
const router = express.Router();
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY // SERVICE_ROLE obligatoire
);

router.post("/register", async (req, res) => {
  const { email, password, prenom, nom, role = "candidat" } = req.body;

  console.log("📩 Tentative d'inscription :", { email, prenom, nom, role });

  // ✅ Vérification des champs
  if (!email || !password || !prenom || !nom) {
    console.warn("⚠️ Champs requis manquants");
    return res.status(400).json({ error: "Champs requis manquants" });
  }

  try {
    // 👤 Étape 1 : Créer l'utilisateur dans Supabase Auth
    const { data: userData, error: userError } =
      await supabase.auth.admin.createUser({
        email,
        password,
        email_confirm: true, // ou false si tu veux qu’il confirme via un email
        user_metadata: { prenom, nom, role },
      });

    if (userError) {
      console.error("❌ Erreur création utilisateur :", userError);
      const code = userError.code || "unknown_error";

      if (code === "23505") {
        // doublon email
        return res.status(409).json({ error: "Email déjà utilisé" });
      }

      return res.status(500).json({
        error: "Erreur création utilisateur",
        details: userError.message,
      });
    }

    const user = userData?.user;

    if (!user || !user.id) {
      console.error("❌ Utilisateur non retourné par Supabase");
      return res.status(500).json({ error: "Aucune ID utilisateur retournée" });
    }

    const userId = user.id;

    // 📄 Étape 2 : Créer le profil dans la base
    const { error: profileError } = await supabase
      .from("user_profiles")
      .insert([
        {
          id: userId,
          email,
          prenom,
          nom,
          role,
          created_at: new Date().toISOString(),
        },
      ]);

    if (profileError) {
      console.error("❌ Erreur création user_profiles :", profileError);
      return res.status(500).json({
        error: "Erreur création du profil",
        details: profileError.message,
      });
    }

    console.log("✅ Inscription réussie pour :", email);
    return res.status(201).json({ user: user });
  } catch (err) {
    console.error("❌ Erreur serveur inattendue :", err);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

module.exports = router;
