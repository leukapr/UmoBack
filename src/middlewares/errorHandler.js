export default function errorHandler(err, req, res, next) {
  console.error("🔥 Erreur capturée :", err.stack || err.message);

  res.status(err.status || 500).json({
    error: err.message || "Erreur serveur inattendue",
  });
}
