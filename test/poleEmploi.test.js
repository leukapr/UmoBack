import { getJobOffers } from "../src/poleEmploi.js";

describe("API Pôle Emploi", () => {
  test("devrait récupérer des offres pour le mot-clé 'développeur'", async () => {
    const data = await getJobOffers({ keyword: "développeur", commune: "75056", limit: 3 });
    expect(data).toHaveProperty("resultats");
    expect(Array.isArray(data.resultats)).toBe(true);
    expect(data.resultats.length).toBeGreaterThan(0);
  }, 10000);

  test("devrait retourner une erreur pour une commune invalide", async () => {
    await expect(getJobOffers({ keyword: "développeur", commune: "00000", limit: 3 }))
      .rejects
      .toThrow(/erreur|error/i);
  }, 10000);

  test("devrait retourner une erreur si le token est invalide", async () => {
    // Sauvegarde de la valeur originale du token
    const oldEnv = { ...process.env };
    process.env.POLE_EMPLOI_CLIENT_SECRET = "invalid_secret";

    try {
      await expect(getJobOffers({ keyword: "développeur", commune: "75056", limit: 3 }))
        .rejects
        .toThrow(/401|unauthorized|invalid/i);
    } finally {
      process.env = oldEnv; // Restauration de l'environnement
    }
  }, 10000);
});
