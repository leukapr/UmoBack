// src/lib/inseeClient.js
import axios from "axios";

/**
 * Petit cache mémoire TTL (par code INSEE).
 * - maxAgeMs par défaut: 24h
 */
class TTLCache {
  constructor(maxAgeMs = 24 * 3600 * 1000) {
    this.maxAge = maxAgeMs;
    this.map = new Map();
  }
  get(key) {
    const hit = this.map.get(key);
    if (!hit) return null;
    if (Date.now() - hit.t > this.maxAge) {
      this.map.delete(key);
      return null;
    }
    return hit.v;
  }
  set(key, val) {
    this.map.set(key, { v: val, t: Date.now() });
  }
}

const cache = new TTLCache();

/**
 * Retourne le nom de la commune pour un code INSEE (string 5 chiffres).
 * @param {string} codeInsee ex: "31396"
 * @returns {Promise<string|null>}
 */
export async function getCommuneNameByInsee(codeInsee) {
  if (!/^\d{5}$/.test(String(codeInsee || ""))) return null;

  const cached = cache.get(codeInsee);
  if (cached) return cached;

  try {
    // Doc: https://geo.api.gouv.fr/decouvrir
    const url = `https://geo.api.gouv.fr/communes/${codeInsee}?fields=nom&format=json`;
    const { data } = await axios.get(url, {
      timeout: 6000,
      validateStatus: (s) => s >= 200 && s < 500,
    });

    // Réponses possibles :
    //  - 200: { nom: "Caraman", ... }
    //  - 404: {}
    const name =
      data && typeof data.nom === "string" && data.nom.trim()
        ? data.nom.trim()
        : null;

    if (name) cache.set(codeInsee, name);
    return name || null;
  } catch (e) {
    // on reste silencieux (fallback au code brut)
    return null;
  }
}

/**
 * Résout en batch un tableau de codes INSEE uniques → {code: nom|null}
 */
export async function batchResolveInsee(codes) {
  const unique = [
    ...new Set((codes || []).filter((c) => /^\d{5}$/.test(String(c || "")))),
  ];
  const out = {};
  await Promise.all(
    unique.map(async (code) => {
      out[code] = await getCommuneNameByInsee(code);
    })
  );
  return out;
}
