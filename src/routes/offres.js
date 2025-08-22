// src/routes/offres.js
import { createClient } from "@supabase/supabase-js";
import axios from "axios";
import express from "express";
import { batchResolveInsee } from "../lib/inseeClient.js"; // ✅ INSEE → commune
import supabase from "../lib/supabaseClient.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";

const router = express.Router();

/* ---------------------------------------------
   🔧 Vue configurable (offres_public / _v2, etc.)
--------------------------------------------- */
const OFFRES_VIEW = process.env.OFFRES_VIEW_NAME || "offres_public";
/** Active la recherche accent-insensible si ta vue expose une colonne `search_text` (déaccentuée). */
const OFFRES_HAS_SEARCH_TEXT =
  String(process.env.OFFRES_HAS_SEARCH_TEXT || "").toLowerCase() === "true";

/* ---------------------------------------------
   🗝️ Client Supabase admin (bypass RLS)
--------------------------------------------- */
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
   🔎 Proxy public (simple) : GET /offres/externe
--------------------------------------------- */
router.get("/externe", async (req, res) => {
  try {
    const token = await getFranceTravailToken();
    const { range, ...rest } = req.query;

    const { data } = await axios.get(FT_SEARCH_URL, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        Range: sanitizeRange(range),
      },
      params: rest,
    });

    return res.json(data);
  } catch (e) {
    const msg =
      e?.response?.data?.message ||
      e?.response?.data?.error_description ||
      e?.message ||
      "Erreur France Travail";
    return res
      .status(e?.response?.status || 500)
      .json({ error: msg, from: "france-travail" });
  }
});

/* ---------------------------------------------
   🔎 Proxy public (pagination auto) : GET /offres/externe/all
--------------------------------------------- */
router.get("/externe/all", async (req, res) => {
  try {
    const token = await getFranceTravailToken();

    const { range, step, start, maxPages, maxResults, ...rest } = req.query;

    const pageSize = Math.min(150, Math.max(1, Number(step ?? 150)));
    let from = Math.max(0, Number(start ?? 0));
    const limitPages = Math.min(1000, Math.max(1, Number(maxPages ?? 50)));
    const limitResults = Number.isFinite(Number(maxResults))
      ? Number(maxResults)
      : 5000;

    const all = [];
    let total = null;
    let pages = 0;

    while (pages < limitPages && all.length < limitResults) {
      const to = from + pageSize - 1;

      const resp = await axios.get(FT_SEARCH_URL, {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          Range: `${from}-${to}`,
        },
        params: rest,
      });

      const items = Array.isArray(resp.data?.resultats)
        ? resp.data.resultats
        : [];
      all.push(...items);

      const cr =
        resp.headers?.["content-range"] || resp.headers?.["Content-Range"];
      if (cr && total == null) {
        const m =
          String(cr).match(/(\d+)-(\d+)\/(\d+)/) || String(cr).match(/\/(\d+)/);
        if (m) total = Number(m[m.length - 1]);
      }

      pages += 1;
      if (items.length < pageSize) break;
      from = to + 1;
    }

    res.setHeader("X-Total-Count-Hint", String(total ?? all.length));
    res.setHeader("X-Pages-Done", String(pages));
    res.setHeader("X-Page-Size", String(pageSize));

    return res.json({
      total_hint: total,
      fetched: all.length,
      pages_done: pages,
      page_size: pageSize,
      params_used: rest,
      resultats: all,
    });
  } catch (e) {
    const msg =
      e?.response?.data?.message ||
      e?.response?.data?.error_description ||
      e?.message ||
      "Erreur FT (pagination auto)";
    return res
      .status(e?.response?.status || 500)
      .json({ error: msg, from: "france-travail" });
  }
});

/* ============================================================
   🗂️ Import FT (une page) → table public.offres
============================================================ */
async function importFromFranceTravail(req, res) {
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
}

/* ---------- Helper commun pour import "full" d’un département ---------- */
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

async function importFromFranceTravailFull(req, res) {
  try {
    const token = await getFranceTravailToken();

    const merged = {
      ...(req.query || {}),
      ...(typeof req.body === "object" && req.body ? req.body : {}),
    };

    if (!merged.departement) {
      return res.status(400).json({
        error: "Paramètre 'departement' requis pour l'import complet.",
      });
    }

    const sb = adminSb ?? req.sb ?? supabase;
    const stats = await importFT_DepartementFull(sb, token, merged);

    return res.json({
      ...stats,
      using_admin: Boolean(adminSb),
    });
  } catch (e) {
    const msg =
      e?.response?.data?.message ||
      e?.response?.data?.error_description ||
      e?.message ||
      "Import FT complet impossible";
    return res.status(e?.response?.status || 500).json({ error: msg });
  }
}

// ✅ routes import (avant /:id)
router.post("/import/france-travail", importFromFranceTravail);
router.post("/france-travail/import", importFromFranceTravail); // alias
router.post("/import/france-travail/full", importFromFranceTravailFull);
router.post("/france-travail/import/full", importFromFranceTravailFull); // alias

/* ============================================================
   🇫🇷 Import national — POST /offres/import/france-travail/france
============================================================ */
const FR_DEPARTEMENTS = [
  ...Array.from({ length: 95 }, (_, i) => String(i + 1).padStart(2, "0")),
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

/* ------------------------------------------------------------------
   🧭 Helper: trouver automatiquement un centre (lat/lng)
------------------------------------------------------------------- */
async function resolveCenter(
  sb,
  { center_lat, center_lng, postal_code, code_postal, city, departement }
) {
  // 1) centre explicite
  if (center_lat != null && center_lng != null) {
    const lat = Number(center_lat);
    const lng = Number(center_lng);
    if (!Number.isNaN(lat) && !Number.isNaN(lng)) return { lat, lng };
  }

  const avg = (arr, key) =>
    arr.reduce((s, r) => s + Number(r?.[key] || 0), 0) / (arr.length || 1);

  // 2) depuis code postal
  const cp = (postal_code || code_postal || "").toString().slice(0, 5);
  if (cp) {
    const { data } = await sb
      .from(OFFRES_VIEW)
      .select("latitude,longitude")
      .eq("postal_code", cp)
      .not("latitude", "is", null)
      .not("longitude", "is", null)
      .limit(300);
    if (data?.length)
      return { lat: avg(data, "latitude"), lng: avg(data, "longitude") };
  }

  // 3) depuis ville (+dep optionnel)
  if (city) {
    const dep = departement ? String(departement).padStart(2, "0") : null;

    let q = sb
      .from(OFFRES_VIEW)
      .select("latitude,longitude,postal_code")
      .ilike("city", `%${city}%`)
      .not("latitude", "is", null)
      .not("longitude", "is", null)
      .limit(500);

    if (dep) q = q.like("postal_code", `${dep}%`);

    const { data } = await q;
    if (data?.length)
      return { lat: avg(data, "latitude"), lng: avg(data, "longitude") };
  }

  return null;
}

/* ============================================================
   🔍 Filtres & Liste — GET /api/offres
   + Gestion du rayon (RPC offres_search_radius)
   + ✅ Post-traitement INSEE → commune
============================================================ */
router.get("/", async (req, res) => {
  try {
    const sb = req.sb ?? supabase;

    // --------- normalisations légères ----------
    const qparams = { ...req.query };

    // region -> departement (ex: pays-de-la-loire)
    if (qparams.region === "pays-de-la-loire" && !qparams.departement) {
      qparams.departement = "44,49,53,72,85";
    }
    // remote yes/no -> true/false
    if (qparams.remote === "yes") qparams.remote = "true";
    if (qparams.remote === "no") qparams.remote = "false";
    // alias "contract" -> type_contrat
    if (qparams.contract && !qparams.type_contrat) {
      qparams.type_contrat = qparams.contract;
    }
    // alias "rome" -> rome_code
    if (qparams.rome && !qparams.rome_code) {
      qparams.rome_code = qparams.rome;
    }
    // tri alias published_at_desc/asc
    if (qparams.sort === "published_at_desc")
      qparams.sort = "date_publication.desc";
    if (qparams.sort === "published_at_asc")
      qparams.sort = "date_publication.asc";

    const {
      q,
      provider,
      departement,
      city,
      postal_code,
      code_postal,
      type_contrat,
      contract_type,
      experience,
      studies,
      niveau_etude_requis,
      work_time,
      salary_min_month,
      salary_max_month,
      rome_code,
      remote,
      postedWithin,
      page = 1,
      per_page,
      limit,
      size,
      sort = "date_publication.desc",
      rayon,
      rayonKm,
      center_lat,
      center_lng,
    } = qparams;

    const sizeParam = per_page ?? limit ?? size ?? 50;
    const pageSize = Math.min(200, Math.max(1, Number(sizeParam)));
    const p = Math.max(1, Number(page));

    /* ------------------ 🎯 Mode "rayon" via RPC ------------------ */
    const radiusKm = Number(rayonKm ?? rayon);
    const hasGeoBase =
      (city && String(city).trim()) ||
      (postal_code && String(postal_code).trim()) ||
      (code_postal && String(code_postal).trim()) ||
      (center_lat != null && center_lng != null);

    if (!Number.isNaN(radiusKm) && radiusKm > 0 && hasGeoBase) {
      try {
        const center = await resolveCenter(sb, {
          center_lat,
          center_lng,
          postal_code,
          code_postal,
          city,
          departement,
        });

        if (center) {
          const { data, error } = await sb.rpc("offres_search_radius", {
            _lat: center.lat,
            _lng: center.lng,
            _km: radiusKm,
            _q: q || null,
            _provider: provider || null,
            _departement: null,
            _city: null,
            _type_contrat: type_contrat || contract_type || null,
            _experience: experience || null,
            _posted_within: postedWithin ? Number(postedWithin) : null,
          });

          if (!error) {
            let arr = Array.isArray(data) ? data : [];

            // Télétravail côté Node (fallback JSON/description)
            if (remote === "true" || remote === "1") {
              arr = arr.filter(
                (o) =>
                  o?.teletravail_possible === true ||
                  /t[ée]l[ée]travail/i.test(o?.description || "") ||
                  /oui|partiel/i.test(
                    String(o?.source_payload?.teletravail || "")
                  )
              );
            } else if (remote === "false" || remote === "0") {
              arr = arr.filter(
                (o) =>
                  o?.teletravail_possible === false ||
                  /non/i.test(String(o?.source_payload?.teletravail || ""))
              );
            }

            // ✅ INSEE → commune
            const mapInseeToName = await batchResolveInsee(
              arr.map((r) => r?.city).filter(Boolean)
            );
            const patched = arr.map((r) => {
              const c = String(r?.city ?? "");
              if (/^\d{5}$/.test(c)) {
                const resolved = mapInseeToName[c];
                if (resolved) return { ...r, city: resolved };
              }
              return r;
            });

            const from = (p - 1) * pageSize;
            const sliced = patched.slice(from, from + pageSize);

            res.setHeader("X-Total-Count", String(patched.length));
            res.setHeader("X-Radius-Center", `${center.lat},${center.lng}`);
            res.setHeader("X-Radius-Km", String(radiusKm));
            return res.json(sliced);
          }

          // RPC KO → on retombe en mode classique
          res.setHeader("X-Geo-Disabled", "true");
          res.setHeader("X-Geo-Error", error?.message || "rpc failed");
          console.warn("RPC offres_search_radius error:", error?.message);
        }
      } catch (e) {
        // Erreur géo non bloquante
        res.setHeader("X-Geo-Disabled", "true");
        res.setHeader("X-Geo-Error", e?.message || "center/geo error");
        console.warn("resolveCenter/RPC error:", e?.message);
      }
      // si pas de centre, on continue en mode classique
    }

    /* ------------------ 🔙 Mode classique (vue) ------------------ */
    let sel = sb.from(OFFRES_VIEW).select("*", { count: "exact" });

    sel = applyOffresFilters(sel, {
      q,
      provider,
      departement,
      city,
      postal_code,
      code_postal,
      type_contrat,
      contract_type,
      experience,
      studies,
      niveau_etude_requis,
      work_time,
      salary_min_month,
      salary_max_month,
      rome_code,
      remote,
      postedWithin,
    });

    // Tri (accepte "col.dir" ou "col_dir")
    let sortParam = String(sort || "").trim();
    if (sortParam && !sortParam.includes(".")) {
      sortParam = sortParam.replace(/_(asc|desc)$/i, ".$1");
    }
    if (sortParam) {
      const [col, dir] = sortParam.split(".");
      if (col)
        sel = sel.order(col, {
          ascending: String(dir).toLowerCase() !== "desc",
        });
    } else {
      sel = sel.order("date_publication", { ascending: false });
    }

    // Pagination
    const from = (p - 1) * pageSize;
    const to = from + pageSize - 1;
    sel = sel.range(from, to);

    const { data, count, error } = await sel;
    if (error) return res.status(400).json({ error: error.message });

    // ✅ INSEE → commune AVANT retour front
    const mapInseeToName = await batchResolveInsee(
      (data || []).map((r) => r?.city).filter(Boolean)
    );
    const patched = (data || []).map((r) => {
      const c = String(r?.city ?? "");
      if (/^\d{5}$/.test(c)) {
        const resolved = mapInseeToName[c];
        if (resolved) return { ...r, city: resolved };
      }
      return r;
    });

    res.setHeader("X-Total-Count", String(count ?? 0));
    return res.json(patched ?? []);
  } catch (e) {
    return res.status(500).json({ error: "Erreur lecture offres" });
  }
});

/* ============================================================
   📊 Facettes — GET /api/offres/facets
============================================================ */
router.get("/facets", async (req, res) => {
  try {
    const sb = req.sb ?? supabase;

    const qparams = { ...req.query };
    if (qparams.region === "pays-de-la-loire" && !qparams.departement) {
      qparams.departement = "44,49,53,72,85";
    }
    if (qparams.remote === "yes") qparams.remote = "true";
    if (qparams.remote === "no") qparams.remote = "false";
    if (qparams.contract && !qparams.type_contrat) {
      qparams.type_contrat = qparams.contract;
    }
    if (qparams.rome && !qparams.rome_code) {
      qparams.rome_code = qparams.rome;
    }

    const {
      q,
      provider,
      departement,
      city,
      postal_code,
      code_postal,
      type_contrat,
      contract_type,
      experience,
      remote,
      postedWithin,
    } = qparams;

    const base = {
      q,
      provider,
      departement,
      city,
      postal_code,
      code_postal,
      remote,
      postedWithin,
    };

    const total = await countOffres(sb, {
      q,
      provider,
      departement,
      city,
      postal_code,
      code_postal,
      type_contrat,
      contract_type,
      experience,
      remote,
      postedWithin,
    });

    const CONTRACT_TYPES = [
      "CDI",
      "CDD",
      "Intérim",
      "Alternance",
      "Stage",
      "Freelance",
      "Saisonnier",
    ];
    const typeContratCounts = Object.fromEntries(
      await Promise.all(
        CONTRACT_TYPES.map(async (val) => [
          val,
          await countOffres(sb, { ...base, type_contrat: val }),
        ])
      )
    );

    const EXPERIENCE_LABELS = [
      "Débutant accepté",
      "Expérience exigée",
      "Non communiqué",
    ];
    const experienceCounts = Object.fromEntries(
      await Promise.all(
        EXPERIENCE_LABELS.map(async (label) => [
          label,
          await countOffres(sb, { ...base, experience: label }),
        ])
      )
    );

    const remoteCounts = {
      yes: await countOffres(sb, { ...base, remote: "true" }),
      no: await countOffres(sb, { ...base, remote: "false" }),
    };

    const DAYS = [1, 3, 7, 14, 30];
    const postedWithinCounts = Object.fromEntries(
      await Promise.all(
        DAYS.map(async (d) => [
          String(d),
          await countOffres(sb, { ...base, postedWithin: String(d) }),
        ])
      )
    );

    return res.json({
      total,
      facets: {
        type_contrat: typeContratCounts,
        experience: experienceCounts,
        remote: remoteCounts,
        postedWithin: postedWithinCounts,
      },
    });
  } catch {
    return res.status(500).json({ error: "Erreur facettes" });
  }
});

/* ---------------------------------------------
   🔎 GET /offres/:id  (détail) + ✅ INSEE → commune
--------------------------------------------- */
router.get("/:id", async (req, res) => {
  try {
    const sb = req.sb ?? supabase;
    const { data, error } = await sb
      .from("offres")
      .select("*")
      .eq("id", req.params.id)
      .single();

    if (error) return res.status(404).json({ error: "Offre non trouvée" });

    // ✅ corriger city si code INSEE
    let out = data;
    const c = String(out?.city ?? "");
    if (/^\d{5}$/.test(c)) {
      const map = await batchResolveInsee([c]);
      if (map[c]) out = { ...out, city: map[c] };
    }

    return res.json(out);
  } catch {
    return res.status(500).json({ error: "Erreur lecture offre" });
  }
});

/* ---------------------------------------------
   ✍️ CRUD local (protégé) pour offres manuelles
--------------------------------------------- */
router.post("/", authMiddleware, async (req, res) => {
  try {
    const sb = req.sb ?? supabase;
    const { intitule, description, lieu, code_postal, source } = req.body;

    if (!intitule?.trim())
      return res.status(400).json({ error: 'Champ "intitule" requis.' });

    if (code_postal && !/^\d{5}$/.test(code_postal))
      return res
        .status(400)
        .json({ error: 'Champ "code_postal" invalide (5 chiffres).' });

    const { data, error } = await sb
      .from("offres")
      .insert([
        {
          intitule,
          description,
          lieu,
          code_postal,
          source: source || "manuelle",
          provider: "local",
          statut_validation: "Publiée",
          is_active: true,
        },
      ])
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });
    return res.status(201).json(data);
  } catch {
    return res.status(500).json({ error: "Erreur ajout offre" });
  }
});

router.patch("/:id", authMiddleware, async (req, res) => {
  try {
    const sb = req.sb ?? supabase;
    const { intitule, description, lieu, code_postal, source } = req.body;

    if (code_postal && !/^\d{5}$/.test(code_postal))
      return res
        .status(400)
        .json({ error: 'Champ "code_postal" invalide (5 chiffres).' });

    const fields = stripUndefined({
      intitule,
      description,
      lieu,
      code_postal,
      source,
    });

    const { data, error } = await sb
      .from("offres")
      .update(fields)
      .eq("id", req.params.id)
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });
    return res.json(data);
  } catch {
    return res.status(500).json({ error: "Erreur mise à jour offre" });
  }
});

router.delete("/:id", authMiddleware, async (req, res) => {
  try {
    const sb = req.sb ?? supabase;
    const { error } = await sb.from("offres").delete().eq("id", req.params.id);
    if (error) return res.status(400).json({ error: error.message });
    return res.json({ message: "✅ Offre supprimée." });
  } catch {
    return res.status(500).json({ error: "Erreur suppression offre" });
  }
});

/* ---------------------------------------------
   🔄 Helpers (filtres, mapping, utilitaires)
--------------------------------------------- */
function stripUndefined(obj) {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined)
  );
}

/** Déaccentue côté Node (utile pour fabriquer le motif `search_text` si activé) */
function stripAccents(str = "") {
  try {
    return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  } catch {
    return str;
  }
}

// Normalise libellé -> code FT (D/E/S) + libellé canonique + plages "0-2"/"5+"
function normalizeExperienceParam(value) {
  if (!value) return null;
  const v = String(value).toLowerCase();

  // plages numériques "0-2", "3-5", "5+"
  const m = v.match(/^(\d+)\s*-\s*(\d+)$/);
  if (m) {
    const a = Number(m[1]);
    if (a === 0) return { code: "D", label: "Débutant accepté" };
    return { code: "E", label: "Expérience exigée" };
  }
  if (/^\d+\s*\+$/.test(v)) return { code: "E", label: "Expérience exigée" };

  if (v === "d" || v.includes("débutant") || v.includes("debutant")) {
    return { code: "D", label: "Débutant accepté" };
  }
  if (v === "e" || v.includes("exig")) {
    return { code: "E", label: "Expérience exigée" };
  }
  if (
    v === "s" ||
    v.includes("non") ||
    v.includes("inconnu") ||
    v.includes("nc")
  ) {
    return { code: "S", label: "Non communiqué" };
  }
  return { code: null, label: String(value) };
}

// Parse salaire FT -> min/max mensuels (si détectables)
function parseFtSalaryToMonthly(o) {
  const lib = o?.salaire?.libelle || o?.salary_text || "";
  const lower = String(lib).toLowerCase();
  const nums = (lib.match(/[\d]+(?:[.,]\d+)?/g) || []).map((n) =>
    Number(n.replace(",", "."))
  );
  const hasMensuel = lower.includes("mensuel");
  const hasAnnuel = lower.includes("annuel");
  const n1 = Number.isFinite(nums[0]) ? nums[0] : null;
  const n2 = Number.isFinite(nums[1]) ? nums[1] : null;

  if ((hasMensuel || hasAnnuel) && (n1 || n2)) {
    let min = Math.min(n1 ?? n2 ?? 0, n2 ?? n1 ?? 0) || null;
    let max = Math.max(n1 ?? 0, n2 ?? 0) || null;
    if (hasAnnuel) {
      min = min ? min / 12 : null;
      max = max ? max / 12 : null;
    }
    return { min, max };
  }
  return { min: null, max: null };
}

/**
 * Applique les filtres.
 */
function applyOffresFilters(builder, params) {
  const {
    q,
    provider,
    departement,
    city,
    postal_code,
    code_postal,
    type_contrat,
    contract_type,
    experience,
    studies,
    niveau_etude_requis,
    work_time,
    salary_min_month,
    salary_max_month,
    rome_code,
    remote,
    postedWithin,
  } = params;

  // Recherche "q" (multi-champs + option `search_text` si activée)
  if (q && String(q).trim()) {
    const term = String(q).trim();
    const norm = stripAccents(term);
    const ors = [
      `intitule.ilike.%${term}%`,
      `entreprise_nom.ilike.%${term}%`,
      `rome_label.ilike.%${term}%`,
      `lieu.ilike.%${term}%`,
      `city.ilike.%${term}%`,
      `location_label.ilike.%${term}%`,
    ];
    if (OFFRES_HAS_SEARCH_TEXT) {
      // match accent-insensible si ta vue expose `search_text`
      ors.push(`search_text.ilike.%${norm}%`);
    }
    builder = builder.or(ors.join(","));
  }

  // Filtres directs
  if (provider) builder = builder.eq("provider", provider);

  // type_contrat : liste ou valeur unique
  if (type_contrat) {
    const list = String(type_contrat)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (list.length > 1) builder = builder.in("type_contrat", list);
    else builder = builder.eq("type_contrat", list[0]);
  }

  // contract_type (idem)
  if (contract_type) {
    const list = String(contract_type)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (list.length > 1) builder = builder.in("contract_type", list);
    else builder = builder.eq("contract_type", list[0]);
  }

  // Expérience : D/E/S, libellé, et plages "0-2,3-5,5+"
  if (experience) {
    const items = String(experience)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const ors = [];
    for (const it of items) {
      const norm = normalizeExperienceParam(it);
      if (norm.code) {
        ors.push(`source_payload->>experienceExige.eq.${norm.code}`);
      }
      const like = norm.label.replaceAll(",", " ");
      ors.push(`experience.ilike.%${like}%`);
      ors.push(`experience_requise.ilike.%${like}%`);
      ors.push(`source_payload->>experienceLibelle.ilike.%${like}%`);
    }
    if (ors.length) builder = builder.or(ors.join(","));
  }

  // Études
  const studiesVal = niveau_etude_requis || studies;
  if (studiesVal) {
    const vals = String(studiesVal)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const ors = vals.map(
      (v) => `niveau_etude_requis.ilike.%${v.replaceAll(",", " ")}%`
    );
    if (ors.length) builder = builder.or(ors.join(","));
  }

  // Temps de travail
  if (work_time) {
    const v = String(work_time).toLowerCase();
    if (["fulltime", "temps plein", "plein"].some((k) => v.includes(k)))
      builder = builder.ilike("work_time", "%plein%");
    else if (
      ["parttime", "temps partiel", "partiel", "mi-temps", "mi temps"].some(
        (k) => v.includes(k)
      )
    )
      builder = builder.or(
        "work_time.ilike.%partiel%,work_time.ilike.%mi-temps%,work_time.ilike.%mi temps%"
      );
    else builder = builder.ilike("work_time", `%${work_time}%`);
  }

  // Salaire mensuel (numérique)
  const minSal = Number(salary_min_month);
  if (!Number.isNaN(minSal) && minSal > 0) {
    builder = builder.or(`salaire_min.gte.${minSal},salaire_max.gte.${minSal}`);
  }
  const maxSal = Number(salary_max_month);
  if (!Number.isNaN(maxSal) && maxSal > 0) {
    builder = builder.or(`salaire_min.lte.${maxSal},salaire_max.lte.${maxSal}`);
  }

  // ROME
  if (rome_code) builder = builder.ilike("rome_code", `%${rome_code}%`);

  // Télétravail
  if (remote === "true" || remote === "1") {
    builder = builder.or(
      [
        "teletravail_possible.eq.true",
        "source_payload->>teletravail.ilike.%oui%",
        "source_payload->>teletravail.ilike.%partiel%",
        "description.ilike.%télétravail%",
        "description.ilike.%teletravail%",
      ].join(",")
    );
  }
  if (remote === "false" || remote === "0") {
    builder = builder.or(
      [
        "teletravail_possible.eq.false",
        "source_payload->>teletravail.ilike.%non%",
      ].join(",")
    );
  }

  // Code postal précis
  const cpExact =
    (postal_code && String(postal_code).slice(0, 5)) ||
    (code_postal && String(code_postal).slice(0, 5));
  if (cpExact) {
    builder = builder.or(`postal_code.eq.${cpExact},code_postal.eq.${cpExact}`);
  }

  // Département
  if (!cpExact && departement) {
    const deps = String(departement)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    if (deps.length === 1 && /^\d{2,3}$/.test(deps[0])) {
      const d = deps[0].padStart(2, "0");
      builder = builder.or(`postal_code.like.${d}%,code_postal.like.${d}%`);
    } else if (deps.length > 1) {
      const orsDep = [];
      for (const d0 of deps) {
        const d = d0.padStart(2, "0");
        orsDep.push(`postal_code.like.${d}%`);
        orsDep.push(`code_postal.like.${d}%`);
      }
      builder = builder.or(orsDep.join(","));
    }
  }

  // Ville / commune
  if (city && String(city).trim()) {
    const c = String(city).trim();
    builder = builder.or(
      `city.ilike.%${c}%,lieu.ilike.%${c}%,location_label.ilike.%${c}%`
    );
  }

  // Période (publiée il y a N jours)
  if (postedWithin && /^\d+$/.test(String(postedWithin))) {
    const days = Number(postedWithin);
    const since = new Date(
      Date.now() - days * 24 * 60 * 60 * 1000
    ).toISOString();
    builder = builder.gte("date_publication", since);
  }

  // Actives/publication
  builder = builder.eq("is_active", true).eq("statut_validation", "Publiée");

  return builder;
}

async function countOffres(sb, params) {
  let q = sb.from(OFFRES_VIEW).select("id", { count: "exact", head: true });
  q = applyOffresFilters(q, params);
  const { count, error } = await q;
  if (error) throw new Error(error.message);
  return count ?? 0;
}

/* ---------- Mapping France Travail -> table offres ---------- */
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

  // 🔢 salaire min/max mensuel
  const { min: salMin, max: salMax } = parseFtSalaryToMonthly({
    salaire: o.salaire,
    salary_text: o.salaire?.libelle,
  });

  return {
    // Base
    intitule: o.intitule ?? null,
    description: o.description ?? null,
    lieu: lieu.libelle ?? null,
    date_publication: o.dateCreation
      ? new Date(o.dateCreation).toISOString()
      : null,

    // Entreprise / localisation
    entreprise_nom: entreprise.nom ?? null,
    company_name: entreprise.nom ?? null,
    location_label: lieu.libelle ?? null,
    city: lieu.commune ?? null, // ⚠️ peut être un code INSEE → corrigé au retour API

    // ✅ CP dans les 2 colonnes
    code_postal: pc,
    postal_code: pc,

    latitude: typeof lieu.latitude === "number" ? lieu.latitude : null,
    longitude: typeof lieu.longitude === "number" ? lieu.longitude : null,

    // Contrat / horaires
    type_contrat: o.typeContratLibelle ?? o.typeContrat ?? null,
    contract_type: o.typeContratLibelle ?? o.typeContrat ?? null,
    work_time: o.dureeTravailLibelleConverti ?? o.dureeTravailLibelle ?? null,

    // Salaire (mensuel brut normalisé quand détectable)
    salaire_min: salMin,
    salaire_max: salMax,
    salary_text: o.salaire?.libelle ?? null,

    // Divers FT
    experience: o.experienceLibelle ?? null, // libellé
    rome_code: o.romeCode ?? null,
    rome_label: o.romeLibelle ?? null,
    niveau_etude_requis: o?.formations?.[0]?.niveauLibelle ?? null,

    // URLs / provenance
    lien_externe: lien,
    source_url: origine?.urlOrigine ?? null,

    // publication & MAJ
    published_at: o.dateCreation
      ? new Date(o.dateCreation).toISOString()
      : null,
    updated_at_source: o.dateActualisation
      ? new Date(o.dateActualisation).toISOString()
      : null,

    // flags
    is_active: true,
    statut_validation: "Publiée",

    // unicité
    provider: "france_travail",
    external_id: o.id ?? null,

    // payload brut (debug)
    source_payload: o,
  };
}

export default router;
