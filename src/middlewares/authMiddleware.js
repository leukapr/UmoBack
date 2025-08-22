// src/middlewares/authMiddleware.js
import jwt from "jsonwebtoken";
import jwksClient from "jwks-rsa";
import { supabaseForToken } from "../lib/supabaseClient.js";

// Construit l’URL JWKS par défaut depuis SUPABASE_URL
const SUPABASE_URL = process.env.SUPABASE_URL?.replace(/\/+$/, "");
const DEFAULT_JWKS = SUPABASE_URL
  ? `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`
  : undefined;

// Vars d’env attendues
const JWKS_URI =
  process.env.SUPABASE_JWKS_URL ||
  DEFAULT_JWKS ||
  "https://YOUR-PROJECT-ref.supabase.co/auth/v1/.well-known/jwks.json";

const JWT_SECRET = process.env.SUPABASE_JWT_SECRET || ""; // requis si vos tokens sont HS256

// Client JWKS (RS256)
const client = jwksClient({
  jwksUri: JWKS_URI,
  cache: true,
  cacheMaxEntries: 5,
  cacheMaxAge: 10 * 60 * 1000,
  rateLimit: true,
  jwksRequestsPerMinute: 10,
});

function getKey(header, cb) {
  client.getSigningKey(header.kid, (err, key) => {
    if (err) {
      console.error("❌ Erreur JWKS:", err.message);
      return cb(err);
    }
    cb(null, key.getPublicKey());
  });
}

// Petite tolérance d’horloge (sec) pour éviter les faux positifs exp/nbf
const CLOCK_TOLERANCE = 10;

export function authMiddleware(req, res, next) {
  const authHeader = String(req.headers.authorization || "").trim();

  if (!authHeader.toLowerCase().startsWith("bearer ")) {
    return res.status(401).json({ error: "Token manquant ou mal formaté" });
  }

  const token = authHeader.split(/\s+/)[1];
  if (!token) return res.status(401).json({ error: "Token manquant" });

  // Détecte l'algo du token
  let header;
  try {
    header = JSON.parse(
      Buffer.from(token.split(".")[0], "base64").toString("utf8")
    );
  } catch {
    return res.status(403).json({ error: "Token invalide" });
  }

  const onVerified = (err, decoded) => {
    if (err) {
      if (err.name === "TokenExpiredError")
        return res.status(401).json({ error: "Token expiré" });
      if (err.name === "NotBeforeError")
        return res.status(401).json({ error: "Token pas encore valide" });
      if (err.name === "JsonWebTokenError")
        return res.status(403).json({ error: "Token invalide" });
      console.error("❌ Vérif token:", err.message);
      return res.status(500).json({ error: "Erreur d’authentification" });
    }

    const {
      sub: id,
      email,
      role = "authenticated",
      user_metadata = {},
    } = decoded || {};

    req.user = {
      id,
      email: email || user_metadata.email || null,
      role: user_metadata.role || role || "authenticated",
      prenom: user_metadata.prenom ?? null,
      nom: user_metadata.nom ?? null,
      user_metadata,
      raw: decoded,
    };

    req.token = token;
    req.sb = supabaseForToken(token); // client Supabase scopé au JWT (RLS)
    return next();
  };

  // Choix du mode de vérification selon l'algo
  if (header?.alg === "RS256") {
    return jwt.verify(
      token,
      getKey,
      { algorithms: ["RS256"], clockTolerance: CLOCK_TOLERANCE },
      onVerified
    );
  }

  if (header?.alg === "HS256") {
    if (!JWT_SECRET) {
      console.error(
        "❌ SUPABASE_JWT_SECRET absent: impossible de vérifier HS256"
      );
      return res.status(500).json({ error: "Config JWT manquante (HS256)" });
    }
    try {
      const decoded = jwt.verify(token, JWT_SECRET, {
        algorithms: ["HS256"],
        clockTolerance: CLOCK_TOLERANCE,
      });
      return onVerified(null, decoded);
    } catch (e) {
      return onVerified(e);
    }
  }

  // Algo inattendu
  return res.status(403).json({ error: "Token invalide" });
}

export default authMiddleware;
