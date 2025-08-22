// routes/jobs.js
import express from "express";
import { getJobOffers } from "../services/poleEmploi.js";

const router = express.Router();

router.get("/", async (req, res) => {
  const { keyword, commune, limit } = req.query;

  try {
    const offers = await getJobOffers({
      motsCles: keyword || "développeur",
      commune: commune || "75",
      range: `0-${limit ? parseInt(limit) - 1 : 9}`,
    });

    res.json(offers);
  } catch (err) {
    res.status(500).json({ error: "Erreur lors de la récupération des offres." });
  }
});

export default router;
