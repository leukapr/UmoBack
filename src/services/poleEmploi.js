// src/services/poleEmploi.js
// ✅ France Travail (ex Pôle emploi) – service OAuth + recherche Offres v2
// - Token OAuth2 (client_credentials)
// - Entête Range: "offres 0-149" (PAS en query string)
// - Helpers: pagination (<= 1150), fenêtrage par dates si > 1150

import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

/* ------------------------------ Config ------------------------------ */

const config = {
  // OAuth
  tokenUrl:
    process.env.FRANCE_TRAVAIL_TOKEN_URL ||
    process.env.POLE_EMPLOI_TOKEN_URL || // rétro compat
    "https://entreprise.francetravail.fr/connexion/oauth2/access_token?realm=/partenaire",
  clientId:
    process.env.FRANCE_TRAVAIL_CLIENT_ID || process.env.POLE_EMPLOI_CLIENT_ID,
  clientSecret:
    process.env.FRANCE_TRAVAIL_CLIENT_SECRET ||
    process.env.POLE_EMPLOI_CLIENT_SECRET,
  scope:
    process.env.FRANCE_TRAVAIL_SCOPE ||
    process.env.POLE_EMPLOI_SCOPE ||
    "api_offresdemploiv2",

  // API Offres v2
  offresUrl:
    process.env.FRANCE_TRAVAIL_OFFRES_URL ||
    "https://api.francetravail.io/partenaire/offresdemploi/v2/offres/search",
};

// Vérification basique de la conf
if (
  !config.tokenUrl ||
  !config.clientId ||
  !config.clientSecret ||
  !config.scope
) {
  throw new Error(
    "❌ Variables d’environnement manquantes pour l’API France Travail."
  );
}

/* ---------------------------- Token cache --------------------------- */

let cachedToken = null;
let tokenExpiresAt = 0; // epoch ms

/**
 * 🔐 Récupère un token OAuth2 (client_credentials) avec cache (marge 60s).
 */
export async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt - 60_000) return cachedToken;

  const params = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: config.clientId,
    client_secret: config.clientSecret,
    scope: config.scope,
  });

  try {
    const { data } = await axios.post(config.tokenUrl, params.toString(), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    cachedToken = data.access_token;
    tokenExpiresAt = now + (Number(data.expires_in) || 1800) * 1000;
    return cachedToken;
  } catch (error) {
    const payload = error?.response?.data || error.message;
    console.error("❌ Échec de l’obtention du token France Travail:", payload);
    throw new Error("Erreur d’authentification France Travail");
  }
}

/* ----------------------------- Helpers ------------------------------ */

const MAX_STEP = 150; // taille de page par entête Range
const MAX_FIRST = 1000; // borne max du premier index
const MAX_LAST = 1149; // borne max absolue
const RPS_DELAY_MS = 350; // ~3 req/s

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildRangeHeader(from = 0, to = 149) {
  const f = Math.max(0, Math.min(from, MAX_FIRST));
  const t = Math.max(f, Math.min(to, MAX_LAST));
  return `offres ${f}-${t}`;
}

function parseTotalFromContentRange(crHeader = "") {
  // format attendu: "offres 0-149/300749"
  const total = String(crHeader).split("/")[1];
  return total ? Number(total.replace(/\D/g, "")) : null;
}

/* ------------------------------ Search ------------------------------ */

/**
 * 📦 Appelle l’endpoint France Travail avec Range unique.
 * @param {Object} options - paramètres FT (voir doc officielle)
 *   Ex: { motsCles, commune, departement, codePostal, rayon, minCreationDate, maxCreationDate, ... }
 * @param {number} from - index début pour l'entête Range
 * @param {number} size - nombre d'éléments (max 150)
 */
export async function getJobOffersOnce(options = {}, from = 0, size = 150) {
  const token = await getAccessToken();
  const rangeHeader = buildRangeHeader(from, from + size - 1);

  try {
    const { data, headers } = await axios.get(config.offresUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        Range: rangeHeader, // <-- IMPORTANT: en-tête, pas ?range=
      },
      params: {
        // On passe les options telles quelles (motsCles, departement, commune, etc.)
        ...options,
      },
    });

    const items = Array.isArray(data?.resultats) ? data.resultats : [];
    const total = parseTotalFromContentRange(headers["content-range"]);
    return { items, total, headers, raw: data };
  } catch (error) {
    const payload = error?.response?.data || error.message;
    console.error("❌ Erreur FT getJobOffersOnce:", payload);
    throw new Error("Erreur lors de la récupération des offres France Travail");
  }
}

/**
 * 🔁 Récupère toutes les pages disponibles jusqu’à 1150 éléments pour un même jeu de paramètres.
 * (0-149, 150-299, ..., 1000-1149)
 */
export async function getJobOffersAllPages(options = {}) {
  let from = 0;
  const out = [];
  let total = null;

  while (from <= MAX_FIRST) {
    const { items, total: t } = await getJobOffersOnce(options, from, MAX_STEP);
    if (t != null) total = t;
    if (!items.length) break;

    out.push(...items);

    // borne max atteinte
    if (from + MAX_STEP - 1 >= MAX_LAST) break;

    from += MAX_STEP;
    await sleep(RPS_DELAY_MS);
  }

  return { items: out, total };
}

/**
 * 🪟 Fenêtrage par dates si total > 1150.
 * Utilise minCreationDate/maxCreationDate (ISO). Divise la fenêtre tant que nécessaire.
 * @param {Object} options - mêmes options que getJobOffersOnce
 * @param {string} minISO - borne min ISO (ex: "2025-01-01T00:00:00.000Z")
 * @param {string} maxISO - borne max ISO
 * @returns {Array} liste d’offres (concaténée sur toutes les fenêtres)
 */
export async function getJobOffersWindowed(options = {}, minISO, maxISO) {
  const merged = {
    ...options,
    minCreationDate: minISO,
    maxCreationDate: maxISO,
  };
  const { items, total } = await getJobOffersAllPages(merged);

  if (total && total > 1150) {
    // trop de résultats -> coupe la fenêtre en deux
    const start = new Date(minISO);
    const end = new Date(maxISO);
    const gap = end - start;

    // seuil minimal: 1 jour -> on prend ce qu’on peut (FT tronque à 1150)
    if (gap <= 24 * 3600 * 1000) return items;

    const mid = new Date(start.getTime() + gap / 2);
    const left = await getJobOffersWindowed(
      options,
      start.toISOString(),
      mid.toISOString()
    );
    await sleep(RPS_DELAY_MS);
    const right = await getJobOffersWindowed(
      options,
      mid.toISOString(),
      end.toISOString()
    );
    return [...left, ...right];
  }

  return items;
}

/* ------------------------------ Exemples ----------------------------- */
/**
 * Exemple d’usage simple:
 *   const { items, total } = await getJobOffersAllPages({ departement: "31", motsCles: "developpeur" });
 *
 * Exemple avec fenêtrage:
 *   const since = new Date(Date.now() - 14*24*3600*1000).toISOString();
 *   const now = new Date().toISOString();
 *   const items = await getJobOffersWindowed({ departement: "31" }, since, now);
 */

export default {
  getAccessToken,
  getJobOffersOnce,
  getJobOffersAllPages,
  getJobOffersWindowed,
};
