// src/app.js
import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";

import { attachSupabase } from "./middlewares/attachSupabase.js";
import { authMiddleware } from "./middlewares/authMiddleware.js";

// Routes
import candidaturesRoutes from "./routes/candidatures.js";
import favoritesRoutes from "./routes/favorites.js";
import filesRoutes from "./routes/files.js";
import filtersRoutes from "./routes/filters.js";
import franceTravailRoutes from "./routes/franceTravail.js";
import geoRouter from "./routes/geo.js";
import newslettersRoutes from "./routes/newsletters.js";
import offresRoutes from "./routes/offres.js";
import searchRoutes from "./routes/search.js";
import spontaneesRoutes from "./routes/spontanees.js";
import usersRoutes from "./routes/users.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === "production";

/* ---------------- Security ---------------- */
app.use(
  helmet({
    // Ajoute des options ici si tu sers des assets cross-origin
  })
);
if (isProd) {
  app.use(
    helmet.hsts({
      maxAge: 15552000, // 180 jours
      includeSubDomains: true,
      preload: true,
    })
  );
}

/* ---------------- CORS ---------------- */
const allowlist = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const corsOptions = {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // server-to-server / curl
    if (!isProd && allowlist.length === 0) return cb(null, true);
    if (allowlist.includes(origin)) return cb(null, true);
    return cb(new Error("Not allowed by CORS"));
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Authorization", "Content-Type"],
  credentials: false,
  maxAge: 86400,
};
app.options("*", cors(corsOptions));
app.use(cors(corsOptions));

/* ---------------- Parsers & proxy ---------------- */
app.use(express.json({ limit: "1mb" }));
app.set("trust proxy", 1);

/* ---------------- Supabase on req ---------------- */
app.use(attachSupabase);

/* ---------------- Rate limiting ---------------- */
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: 429,
    error: "Trop de requêtes. Veuillez réessayer plus tard.",
  },
});
app.use(globalLimiter);

// Exemple de limiteur plus strict pour un endpoint login si besoin
// const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });

/* ---------------- Health ---------------- */
app.get("/api/ping", (_req, res) => res.send("pong"));
app.get("/api/__health", (_req, res) =>
  res.json({ ok: true, time: new Date().toISOString() })
);

/* ---------------- Routes publiques ---------------- */
app.use("/api/filters", filtersRoutes);
app.use("/api/search", searchRoutes);

// ✅ Router des offres (contient POST /import/france-travail)
app.use("/api/offres", offresRoutes);

// ✅ Alias pratique : /api/france-travail/import → réutilise le handler défini dans routes/offres.js
app.post("/api/france-travail/import", (req, res, next) => {
  const qs =
    req._parsedUrl && req._parsedUrl.search ? req._parsedUrl.search : "";
  req.url = `/import/france-travail${qs}`;
  return offresRoutes(req, res, next);
});

// Router dédié France Travail (ex: GET /api/france-travail/offres)
app.use("/api/france-travail", franceTravailRoutes);
app.use("/api/geo", geoRouter);

/* ---------------- Routes protégées ---------------- */
app.use("/api/candidatures", authMiddleware, candidaturesRoutes);
app.use("/api/files", filesRoutes);
app.use("/api/users", usersRoutes);
app.use("/api/favorites", authMiddleware, favoritesRoutes);
app.use("/api/newsletters", newslettersRoutes); // ⬅️ ici

// Candidatures spontanées : POST public / GET protégé dans le router
app.use("/api/spontanees", spontaneesRoutes);

/* ---------------- 404 & error handler ---------------- */
app.use((_req, res) => {
  res.status(404).json({ error: "Route non trouvée." });
});

app.use((err, _req, res, _next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Erreur serveur" });
});

/* ---------------- Listen ---------------- */
app.listen(PORT, () => {
  console.log(`🚀 Serveur lancé sur http://localhost:${PORT}`);
  if (!isProd) {
    console.log(
      "CORS allowlist:",
      allowlist.length ? allowlist : "(dev: toutes origines acceptées)"
    );
  }
});

export default app;
