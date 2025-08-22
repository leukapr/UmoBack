import cron from "node-cron";
import { syncFranceTravail } from "../jobs/syncFranceTravail.js";

export function registerCrons() {
  // Toutes les 2 heures (TZ serveur)
  cron.schedule("0 */2 * * *", async () => {
    try {
      await syncFranceTravail({ days: 14 });
    } catch (e) {
      console.error("FT cron error:", e);
    }
  });
}
