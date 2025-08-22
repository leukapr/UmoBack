// src/routes/spontanees.js
import { createClient } from "@supabase/supabase-js";
import express from "express";
import { authMiddleware } from "../middlewares/authMiddleware.js";

const router = express.Router();

/* ------------------------ Supabase admin (bypass RLS pour POST) ------------------------ */
const adminSb =
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY,
        {
          auth: { persistSession: false },
        }
      )
    : null;

/* ------------------------------------ Helpers ------------------------------------ */

// Convertit un tableau JS -> littéral Postgres text[]
function toPgTextArray(arr = []) {
  const esc = (s) => String(s).replace(/"/g, '\\"');
  return `{${arr.map((s) => `"${esc(s)}"`).join(",")}}`;
}

// Normalise "competences" fourni en body (string ou array) -> array<string>
function normalizeCompetences(input) {
  if (Array.isArray(input)) {
    return input.map((s) => String(s).trim()).filter(Boolean);
  }
  if (typeof input === "string") {
    return input
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

function getUserIdSoft(req) {
  return req.user?.id || req.user?.sub || null; // POST public -> peut être null
}

function isArrayTypeError(err) {
  const msg = String(err?.message || "").toLowerCase();
  return (
    msg.includes("text[]") ||
    (msg.includes("array") && msg.includes("text")) ||
    (msg.includes("is of type") && msg.includes("array"))
  );
}

function mapDbErrorToHttp(err) {
  const code = err?.code;
  const msg = String(err?.message || "");
  if (/row level security/i.test(msg) || code === "42501") {
    return {
      status: 403,
      body: {
        error: "RLS",
        details:
          "Row Level Security a bloqué l'INSERT (vérifie tes policies ou active le client admin).",
      },
    };
  }
  if (code === "23502") {
    const m = msg.match(/column "?(.*?)"?/i);
    return {
      status: 400,
      body: { error: "NOT_NULL", column: m?.[1], details: msg },
    };
  }
  if (code === "22P02") {
    return {
      status: 400,
      body: { error: "INVALID_INPUT_SYNTAX", details: msg },
    };
  }
  if (code === "23503") {
    return { status: 400, body: { error: "FK_VIOLATION", details: msg } };
  }
  if (code === "23505") {
    return { status: 200, body: { ok: true, duplicate: true } };
  }
  return { status: 400, body: { error: "Insert KO", details: msg } };
}

/* -------------------------------------- Routes -------------------------------------- */

/**
 * POST /api/spontanees  (public ou connecté)
 *
 * Body attendu:
 * {
 *   email: string,           // requis
 *   cv_url: string,          // requis
 *   nom?, prenom?, telephone?, titre?,
 *   competences?: string[] | "a, b, c",
 *   cv_sha256?: string,
 *   consent_rgpd?: boolean,
 *   consent_at?: string (ISO)
 * }
 */
router.post("/", async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.email)
      return res.status(422).json({ error: "Champ requis manquant: email" });
    if (!b.cv_url)
      return res.status(422).json({ error: "Champ requis manquant: cv_url" });

    // Utilise le client admin si dispo (bypass RLS), sinon le client request (soumis aux policies)
    const sb = adminSb ?? req.sb;

    const userId = getUserIdSoft(req);

    // competences -> array<string>
    const comps = normalizeCompetences(b.competences);

    // RGPD: jamais null si colonne NOT NULL côté DB
    const consent =
      typeof b.consent_rgpd === "boolean" ? b.consent_rgpd : false;
    const consentAt = consent ? b.consent_at || new Date().toISOString() : null;

    const baseRow = {
      user_id: userId,
      email: String(b.email).trim(),
      cv_url: String(b.cv_url).trim(),
      nom: b.nom ? String(b.nom).trim() : null,
      prenom: b.prenom ? String(b.prenom).trim() : null,
      telephone: b.telephone ? String(b.telephone).trim() : null,
      titre: b.titre ? String(b.titre).trim() : null,
      cv_sha256: b.cv_sha256 ? String(b.cv_sha256) : null,
      consent_rgpd: consent,
      consent_at: consentAt,
      // statut / created_at via defaults SQL si définis (ex: 'Nouveau')
    };

    // 1) tentative jsonb
    let { data, error } = await sb
      .from("candidatures_spontanees")
      .insert([{ ...baseRow, competences: comps }])
      .select("id")
      .single();

    // 2) si la colonne est text[] -> retry avec littéral Postgres
    if (error && isArrayTypeError(error)) {
      const retry = await sb
        .from("candidatures_spontanees")
        .insert([{ ...baseRow, competences: toPgTextArray(comps) }])
        .select("id")
        .single();
      data = retry.data;
      error = retry.error;
    }

    if (error) {
      const mapped = mapDbErrorToHttp(error);
      return res.status(mapped.status).json(mapped.body);
    }

    return res.status(201).json({ id: data.id });
  } catch (e) {
    console.error("POST /spontanees error:", e);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

/**
 * GET /api/spontanees  (connecté)
 * Retourne uniquement les candidatures de l'utilisateur authentifié.
 * Query optionnelles: page, size
 */
router.get("/", authMiddleware, async (req, res) => {
  try {
    const userId = req.user?.id || req.user?.sub;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const page = Math.max(1, Number(req.query.page || 1));
    const size = Math.min(200, Math.max(1, Number(req.query.size || 50)));
    const from = (page - 1) * size;
    const to = from + size - 1;

    const { data, count, error } = await req.sb
      .from("candidatures_spontanees")
      .select(
        "id, email, cv_url, nom, prenom, telephone, titre, competences, cv_sha256, consent_rgpd, consent_at, statut, created_at",
        { count: "exact" }
      )
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .range(from, to);

    if (error) return res.status(400).json({ error: error.message });

    res.setHeader("X-Total-Count", String(count ?? 0));
    return res.json(data || []);
  } catch (e) {
    console.error("GET /spontanees error:", e);
    return res.status(500).json({ error: "Erreur interne" });
  }
});

export default router;
