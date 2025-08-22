import rateLimit from "express-rate-limit";

// 🔒 Limiteur global (optionnel, couvre toutes les API si appliqué)
export const globalRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // max 100 requêtes par IP
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: 429,
    error: "Trop de requêtes. Veuillez réessayer plus tard.",
  },
});

// 🔐 Auth limiter (spécial pour /auth/login, /auth/register)
export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 10, // 10 tentatives max
  message: {
    status: 429,
    error: "Trop de tentatives de connexion. Réessaye plus tard.",
  },
});

// 📁 Signed URL limiter (éviter génération illimitée de liens)
export const fileUrlLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 min
  max: 30, // 30 URLs max
  message: {
    status: 429,
    error: "Trop de demandes de liens signés. Patiente un moment.",
  },
});
