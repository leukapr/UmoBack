// src/routes/geo.js
import express from "express";
import supabase from "../lib/supabaseClient.js";

const router = express.Router();

/* ---------------- Département (code -> libellé) ---------------- */
const DEPS = {
  "01": "Ain",
  "02": "Aisne",
  "03": "Allier",
  "04": "Alpes-de-Haute-Provence",
  "05": "Hautes-Alpes",
  "06": "Alpes-Maritimes",
  "07": "Ardèche",
  "08": "Ardennes",
  "09": "Ariège",
  10: "Aube",
  11: "Aude",
  12: "Aveyron",
  13: "Bouches-du-Rhône",
  14: "Calvados",
  15: "Cantal",
  16: "Charente",
  17: "Charente-Maritime",
  18: "Cher",
  19: "Corrèze",
  21: "Côte-d'Or",
  22: "Côtes-d'Armor",
  23: "Creuse",
  24: "Dordogne",
  25: "Doubs",
  26: "Drôme",
  27: "Eure",
  28: "Eure-et-Loir",
  29: "Finistère",
  "2A": "Corse-du-Sud",
  "2B": "Haute-Corse",
  30: "Gard",
  31: "Haute-Garonne",
  32: "Gers",
  33: "Gironde",
  34: "Hérault",
  35: "Ille-et-Vilaine",
  36: "Indre",
  37: "Indre-et-Loire",
  38: "Isère",
  39: "Jura",
  40: "Landes",
  41: "Loir-et-Cher",
  42: "Loire",
  43: "Haute-Loire",
  44: "Loire-Atlantique",
  45: "Loiret",
  46: "Lot",
  47: "Lot-et-Garonne",
  48: "Lozère",
  49: "Maine-et-Loire",
  50: "Manche",
  51: "Marne",
  52: "Haute-Marne",
  53: "Mayenne",
  54: "Meurthe-et-Moselle",
  55: "Meuse",
  56: "Morbihan",
  57: "Moselle",
  58: "Nièvre",
  59: "Nord",
  60: "Oise",
  61: "Orne",
  62: "Pas-de-Calais",
  63: "Puy-de-Dôme",
  64: "Pyrénées-Atlantiques",
  65: "Hautes-Pyrénées",
  66: "Pyrénées-Orientales",
  67: "Bas-Rhin",
  68: "Haut-Rhin",
  69: "Rhône",
  70: "Haute-Saône",
  71: "Saône-et-Loire",
  72: "Sarthe",
  73: "Savoie",
  74: "Haute-Savoie",
  75: "Paris",
  76: "Seine-Maritime",
  77: "Seine-et-Marne",
  78: "Yvelines",
  79: "Deux-Sèvres",
  80: "Somme",
  81: "Tarn",
  82: "Tarn-et-Garonne",
  83: "Var",
  84: "Vaucluse",
  85: "Vendée",
  86: "Vienne",
  87: "Haute-Vienne",
  88: "Vosges",
  89: "Yonne",
  90: "Territoire de Belfort",
  91: "Essonne",
  92: "Hauts-de-Seine",
  93: "Seine-Saint-Denis",
  94: "Val-de-Marne",
  95: "Val-d'Oise",
  971: "Guadeloupe",
  972: "Martinique",
  973: "Guyane",
  974: "La Réunion",
  976: "Mayotte",
};

function depFromPostalCode(cp) {
  const s = String(cp || "")
    .padStart(5, "0")
    .slice(0, 5);
  if (!/^\d{5}$/.test(s)) return { code: null, name: null };
  const d3 = s.slice(0, 3);
  if (DEPS[d3]) return { code: d3, name: DEPS[d3] };
  let code = s.slice(0, 2);
  let name = DEPS[code] || null;
  if (code === "20") {
    // Corse
    const n = parseInt(s, 10);
    if (n >= 20000 && n <= 20199) {
      code = "2A";
      name = DEPS["2A"];
    } else {
      code = "2B";
      name = DEPS["2B"];
    }
  }
  return { code, name };
}

function titleCaseFR(str = "") {
  return str
    .toString()
    .toLowerCase()
    .replace(/\b(\p{L})(\p{L}*)/gu, (_, a, b) => a.toUpperCase() + b);
}

function extractAfterDash(label = "") {
  // "31 - Colomiers" -> "Colomiers"
  const m = String(label).split(" - ");
  return m.length >= 2 ? m.slice(1).join(" - ").trim() : String(label).trim();
}

function normalizeCityFromRow(row) {
  // ordre de préférence : ville (si texte), label/lieu (partie après tiret), sinon city si non numérique
  const v1 = row.ville && !/^\d+$/.test(String(row.ville)) ? row.ville : null;
  const v2raw = row.location_label || row.lieu || null;
  const v2 = v2raw ? extractAfterDash(v2raw) : null;
  const v3 = row.city && !/^\d+$/.test(String(row.city)) ? row.city : null;
  return (v1 || v2 || v3 || "").trim();
}

function parseQuery(q) {
  const raw = (q || "").toString().trim();
  if (!raw) return { mode: "empty" };
  if (/^\d{2,5}$/.test(raw)) return { mode: "cp", cpLike: raw.slice(0, 5) };
  const m = raw.match(/^(.+?)\s*\((\d{2,5})\)\s*$/);
  if (m) {
    const city = m[1].trim();
    const depOrCp = m[2];
    if (depOrCp.length === 2 || depOrCp.length === 3) {
      return { mode: "city+dep", city, depLike: depOrCp.padStart(2, "0") };
    }
    return { mode: "city+cp", city, cpLike: depOrCp };
  }
  return { mode: "city", city: raw };
}

/**
 * GET /api/geo/suggest?q=...
 * -> [{ city, postal_code, departement_code, departement_name, label, value }]
 * label: "Colomiers (31770), Haute-Garonne"
 * value: "31770"
 */
router.get("/suggest", async (req, res) => {
  try {
    const parsed = parseQuery(req.query.q);
    if (parsed.mode === "empty") return res.json([]);

    // On sélectionne plusieurs colonnes pour retrouver un nom de ville lisible
    let sel = supabase
      .from("offres_public")
      .select("city, ville, location_label, lieu, postal_code")
      .not("postal_code", "is", null)
      .limit(400);

    // Filtres selon la saisie
    if (parsed.mode === "cp") {
      sel = sel.ilike("postal_code", `${parsed.cpLike}%`);
    } else if (parsed.mode === "city") {
      // chercher dans plusieurs champs texte (pas dans city si c'est un code INSEE)
      sel = sel.or(
        [
          `ville.ilike.%${parsed.city}%`,
          `location_label.ilike.%${parsed.city}%`,
          `lieu.ilike.%${parsed.city}%`,
        ].join(",")
      );
    } else if (parsed.mode === "city+cp") {
      sel = sel
        .or(
          [
            `ville.ilike.%${parsed.city}%`,
            `location_label.ilike.%${parsed.city}%`,
            `lieu.ilike.%${parsed.city}%`,
          ].join(",")
        )
        .ilike("postal_code", `${parsed.cpLike}%`);
    } else if (parsed.mode === "city+dep") {
      sel = sel
        .or(
          [
            `ville.ilike.%${parsed.city}%`,
            `location_label.ilike.%${parsed.city}%`,
            `lieu.ilike.%${parsed.city}%`,
          ].join(",")
        )
        .like("postal_code", `${parsed.depLike}%`);
    }

    const { data, error } = await sel;
    if (error) return res.status(400).json({ error: error.message });

    const seen = new Set();
    const items = [];

    for (const row of data || []) {
      const cp = String(row.postal_code || "").slice(0, 5);
      if (!/^\d{5}$/.test(cp)) continue;

      const cityName = normalizeCityFromRow(row);
      if (!cityName) continue;

      const key = `${cityName}|${cp}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const { code: depCode, name: depName } = depFromPostalCode(cp);
      items.push({
        city: titleCaseFR(cityName),
        postal_code: cp,
        departement_code: depCode,
        departement_name: depName,
        label: `${titleCaseFR(cityName)} (${cp})${
          depName ? `, ${depName}` : ""
        }`,
        value: cp,
      });
    }

    // Tri : ville puis CP
    items.sort((a, b) => {
      const ac = a.city.localeCompare(b.city, "fr", { sensitivity: "base" });
      return ac || a.postal_code.localeCompare(b.postal_code);
    });

    return res.json(items.slice(0, 20));
  } catch {
    return res.status(500).json({ error: "Erreur suggest" });
  }
});

export default router;
