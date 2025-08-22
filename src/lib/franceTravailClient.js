// src/lib/franceTravailClient.js
import axios from "axios";

const {
  FRANCE_TRAVAIL_TOKEN_URL,
  FRANCE_TRAVAIL_CLIENT_ID,
  FRANCE_TRAVAIL_CLIENT_SECRET,
  FRANCE_TRAVAIL_SCOPE,
  FRANCE_TRAVAIL_SEARCH_URL,
} = process.env;

let cachedToken = null;
let tokenExpiresAt = 0; // epoch ms

async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt - 30_000) {
    return cachedToken;
  }

  const params = new URLSearchParams();
  params.append("grant_type", "client_credentials");
  params.append("client_id", FRANCE_TRAVAIL_CLIENT_ID);
  params.append("client_secret", FRANCE_TRAVAIL_CLIENT_SECRET);
  if (FRANCE_TRAVAIL_SCOPE) params.append("scope", FRANCE_TRAVAIL_SCOPE);

  const { data } = await axios.post(FRANCE_TRAVAIL_TOKEN_URL, params, {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 10_000,
  });

  // { access_token, token_type, expires_in }
  cachedToken = data.access_token;
  tokenExpiresAt = now + (data.expires_in || 900) * 1000;
  return cachedToken;
}

export async function searchOffres({ params = {}, range = "0-149" }) {
  const token = await getAccessToken();

  // Nettoyage / mapping des critères (motsCles, codeROME, commune, departement, minCreationDate, maxCreationDate…)
  const qp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    qp.set(k, String(v));
  }

  const url = `${FRANCE_TRAVAIL_SEARCH_URL}?${qp.toString()}`;
  const resp = await axios.get(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      // la recherche retourne 150 max par fenêtre (0-149, 150-299, …)
      Range: range,
    },
    timeout: 10_000,
    // Important : on veut les en-têtes (Content-Range)
    validateStatus: (s) => s === 200 || s === 206,
  });

  // La réponse contient {filtresPossibles, resultats} et l’en-tête Content-Range
  return {
    contentRange: resp.headers["content-range"] || null,
    ...resp.data,
  };
}
