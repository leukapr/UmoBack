// src/routes/offres.import.js
import { createClient } from "@supabase/supabase-js";
import axios from "axios";
import express from "express";
import supabase from "../lib/supabaseClient.js";

const router = express.Router();

/* ---------------------------------------------
   🗝️ Client Supabase admin (bypass RLS)
--------------------------------------------- */
const adminSb =
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY,
        { auth: { persistSession: false } }
      )
    : null;

/* ---------------------------------------------
   🔐 TOKEN FRANCE TRAVAIL (cache mémoire)
--------------------------------------------- */
let cachedToken = null;
let tokenExpirationMs = 0;

async function getFranceTravailToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpirationMs) return cachedToken;

  const tokenURL =
    process.env.FRANCE_TRAVAIL_TOKEN_URL ||
    "https://entreprise.francetravail.fr/connexion/oauth2/access_token?realm=/partenaire";

  const clientId = process.env.FRANCE_TRAVAIL_CLIENT_ID;
  const clientSecret = process.env.FRANCE_TRAVAIL_CLIENT_SECRET;
  const scope =
    process.env.FRANCE_TRAVAIL_SCOPE || "api_offresdemploiv2 o2dsoffre";

  if (!clientId || !clientSecret) {
    throw new Error("FRANCE_TRAVAIL_CLIENT_ID/SECRET manquants");
  }

  const authHeader =
    "Basic " +
    Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64");
  const body = new URLSearchParams({ grant_type: "client_credentials", scope });

  const { data } = await axios.post(tokenURL, body.toString(), {
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: authHeader,
    },
  });

  cachedToken = data.access_token;
  tokenExpirationMs = now + (data.expires_in ?? 1500) * 1000;
  return cachedToken;
}

function sanitizeRange(range) {
  const m = String(range || "").match(/^(\d+)-(\d+)$/);
  return m ? range : "0-149";
}

const FT_SEARCH_URL =
  "https://api.francetravail.io/partenaire/offresdemploi/v2/offres/search";

/* ---------------------------------------------
   🔄 Helpers (mapping / utils)
--------------------------------------------- */
function stripUndefined(obj) {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined)
  );
}

function mapFtOfferToRow(o = {}) {
  const lieu = o.lieuTravail || {};
  const entreprise = o.entreprise || {};
  const contact = o.contact || {};
  const origine = o.origineOffre || {};

  let lien = origine?.urlOrigine || null;
  if (
    !lien &&
    typeof contact?.coordonnees1 === "string" &&
    contact.coordonnees1.includes("http")
  ) {
    lien = contact.coordonnees1;
  }

  const pc = lieu.codePostal ? String(lieu.codePostal).slice(0, 5) : null;

  return {
    intitule: o.intitule ?? null,
    description: o.description ?? null,
    lieu: lieu.libelle ?? null,
    date_publication: o.dateCreation
      ? new Date(o.dateCreation).toISOString()
      : null,

    entreprise_nom: entreprise.nom ?? null,
    company_name: entreprise.nom ?? null,
    location_label: lieu.libelle ?? null,
    city: lieu.commune ?? null,

    code_postal: pc,
    postal_code: pc,

    latitude: typeof lieu.latitude === "number" ? lieu.latitude : null,
    longitude: typeof lieu.longitude === "number" ? lieu.longitude : null,

    type_contrat: o.typeContratLibelle ?? o.typeContrat ?? null,
    contract_type: o.typeContratLibelle ?? o.typeContrat ?? null,
    work_time: o.dureeTravailLibelleConverti ?? o.dureeTravailLibelle ?? null,

    salaire_min: null,
    salaire_max: null,
    salary_text: o.salaire?.libelle ?? null,

    experience: o.experienceLibelle ?? null,
    rome_code: o.romeCode ?? null,
    rome_label: o.romeLibelle ?? null,

    lien_externe: lien,
    source_url: origine?.urlOrigine ?? null,

    published_at: o.dateCreation
      ? new Date(o.dateCreation).toISOString()
      : null,
    updated_at_source: o.dateActualisation
      ? new Date(o.dateActualisation).toISOString()
      : null,

    is_active: true,
    statut_validation: "Publiée",

    provider: "france_travail",
    external_id: o.id ?? null,

    source_payload: o,
  };
}

/* ============================================================
   🗂️ Import FT (une page) → table public.offres
============================================================ */
router.post("/import/france-travail", async (req, res) => {
  try {
    const token = await getFranceTravailToken();

    const merged = {
      ...(req.query || {}),
      ...(typeof req.body === "object" && req.body ? req.body : {}),
    };
    const { range, ...params } = merged;

    const { data } = await axios.get(FT_SEARCH_URL, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        Range: sanitizeRange(range),
      },
      params,
    });

    const results = Array.isArray(data?.resultats) ? data.resultats : [];
    const rows = results.map(mapFtOfferToRow).map(stripUndefined);

    if (!rows.length) {
      return res.json({ imported: 0, upserted: 0, duplicates: 0 });
    }

    const sb = adminSb ?? req.sb ?? supabase;
    const { data: upserted, error } = await sb
      .from("offres")
      .upsert(rows, { onConflict: "provider,external_id" })
      .select("id, provider, external_id");

    if (error) return res.status(400).json({ error: error.message });

    const upsertedSet = new Set(
      (upserted ?? []).map((r) => `${r.provider}:${r.external_id}`)
    );
    const duplicates = rows.filter(
      (r) => !upsertedSet.has(`${r.provider}:${r.external_id}`)
    ).length;

    return res.json({
      imported: rows.length,
      upserted: upserted?.length ?? 0,
      duplicates,
      sample: (upserted ?? []).slice(0, 3),
      using_admin: Boolean(adminSb),
    });
  } catch (e) {
    const msg =
      e?.response?.data?.message ||
      e?.response?.data?.error_description ||
      e?.message ||
      "Import FT impossible";
    return res.status(e?.response?.status || 500).json({ error: msg });
  }
});

/* ---------- Helper “full département” réutilisable ---------- */
async function importFT_DepartementFull(sb, token, params) {
  const pageSize = Math.min(Number(params.pageSize || 150), 150);
  const maxPages = Math.min(Number(params.maxPages || 200), 1000);

  const qParams = { ...params };
  delete qParams.pageSize;
  delete qParams.maxPages;
  delete qParams.range;

  let start = 0;
  let page = 0;
  let total = null;
  let imported = 0;
  let upsertedCount = 0;
  const samples = [];

  while (page < maxPages) {
    const end = start + pageSize - 1;

    const resp = await axios.get(FT_SEARCH_URL, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        Range: `${start}-${end}`,
      },
      params: qParams,
    });

    const results = Array.isArray(resp.data?.resultats)
      ? resp.data.resultats
      : [];
    const cr =
      resp.headers?.["content-range"] || resp.headers?.["Content-Range"];
    if (cr && total == null) {
      const m =
        String(cr).match(/(\d+)-(\d+)\/(\d+)/) || String(cr).match(/\/(\d+)/);
      if (m) total = Number(m[m.length - 1]);
    }

    if (!results.length) break;

    const rows = results.map(mapFtOfferToRow).map(stripUndefined);
    imported += rows.length;

    const { data: upserted, error } = await sb
      .from("offres")
      .upsert(rows, { onConflict: "provider,external_id" })
      .select("id, provider, external_id")
      .limit(3);

    if (error) {
      throw new Error(
        `${error.message} (dep ${qParams.departement}, range ${start}-${end})`
      );
    }

    upsertedCount += upserted?.length ?? 0;
    if (samples.length < 3 && upserted?.length) {
      samples.push(...upserted.slice(0, 3 - samples.length));
    }

    if (results.length < pageSize) break;
    start = end + 1;
    page += 1;
    if (total != null && start >= total) break;
  }

  return {
    imported,
    upserted: upsertedCount,
    total_hint: total,
    pages_done: page + 1,
    page_size: pageSize,
    sample: samples,
  };
}

/* ============================================================
   🗂️ Import FT “full département”
============================================================ */
router.post("/import/france-travail/full", async (req, res) => {
  try {
    const token = await getFranceTravailToken();

    const merged = {
      ...(req.query || {}),
      ...(typeof req.body === "object" && req.body ? req.body : {}),
    };

    if (!merged.departement) {
      return res
        .status(400)
        .json({
          error: "Paramètre 'departement' requis pour l'import complet.",
        });
    }

    const sb = adminSb ?? req.sb ?? supabase;
    const stats = await importFT_DepartementFull(sb, token, merged);

    return res.json({ ...stats, using_admin: Boolean(adminSb) });
  } catch (e) {
    const msg =
      e?.response?.data?.message ||
      e?.response?.data?.error_description ||
      e?.message ||
      "Import FT complet impossible";
    return res.status(e?.response?.status || 500).json({ error: msg });
  }
});

/* ============================================================
   🇫🇷 Import national — POST /offres/import/france-travail/france
   - Itère sur tous les départements (métropole + DOM principaux)
   - Paramètres optionnels: pageSize, maxPages, deps[]=31&deps[]=33...
============================================================ */
const FR_DEPARTEMENTS = [
  ...Array.from({ length: 95 }, (_, i) => String(i + 1).padStart(2, "0")), // 01..95
  "2A",
  "2B",
  "971",
  "972",
  "973",
  "974",
  "976",
];

router.post("/import/france-travail/france", async (req, res) => {
  try {
    const token = await getFranceTravailToken();
    const sb = adminSb ?? req.sb ?? supabase;

    const deps = (
      Array.isArray(req.query.deps) && req.query.deps.length
        ? req.query.deps
        : FR_DEPARTEMENTS
    ).map(String);

    const pageSize = req.query.pageSize || req.body?.pageSize;
    const maxPages = req.query.maxPages || req.body?.maxPages;

    const perDep = [];
    let totalImported = 0;
    let totalUpserted = 0;

    for (const dep of deps) {
      try {
        const stats = await importFT_DepartementFull(sb, token, {
          departement: dep,
          pageSize,
          maxPages,
        });
        perDep.push({ departement: dep, ...stats });
        totalImported += stats.imported;
        totalUpserted += stats.upserted;
      } catch (e) {
        perDep.push({ departement: dep, error: e?.message || "échec import" });
      }
    }

    return res.json({
      deps_done: perDep.length,
      total_imported: totalImported,
      total_upserted: totalUpserted,
      details: perDep.slice(0, 10),
      using_admin: Boolean(adminSb),
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Import national KO" });
  }
});

export default router;
