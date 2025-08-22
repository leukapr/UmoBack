// scripts/audit-france-travail.js
import "dotenv/config";
import { DEPARTEMENTS_LIST } from "../src/lib/departements.js";
import supabase from "../src/lib/supabaseClient.js";
import { getJobOffersWindowed } from "../src/services/poleEmploi.js"; // ou franceTravail.js

function iso(x) {
  return new Date(x).toISOString();
}

async function countDb({ dep, minISO, maxISO }) {
  const { count, error } = await supabase
    .from("offres_raw")
    .select("*", { count: "exact", head: true })
    .eq("provider", "france-travail")
    .eq("departement", String(dep))
    .gte("date_publication", minISO)
    .lt("date_publication", maxISO) // borne sup exclusive
    .eq("is_active", true);

  if (error) throw error;
  return count ?? 0;
}

async function runAudit({ since, until, filterDeps = [] }) {
  const minISO = iso(since);
  const maxISO = iso(until);
  const rows = [];
  let sumFt = 0,
    sumDb = 0;

  const deps = (
    filterDeps.length
      ? DEPARTEMENTS_LIST.filter((d) => filterDeps.includes(String(d.code)))
      : DEPARTEMENTS_LIST
  ).map((d) => String(d.code));

  for (const dep of deps) {
    process.stdout.write(`↳ Audit ${dep} … `);
    const ftItems = await getJobOffersWindowed(
      { departement: dep },
      minISO,
      maxISO
    );
    const ftCount = ftItems.length;
    const dbCount = await countDb({ dep, minISO, maxISO });
    const delta = dbCount - ftCount;

    rows.push({ dep, ftCount, dbCount, delta });
    sumFt += ftCount;
    sumDb += dbCount;
    console.log(
      `${ftCount} (FT) vs ${dbCount} (DB) Δ=${delta >= 0 ? "+" : ""}${delta}`
    );
  }

  console.log("\nRésumé:");
  console.table(rows);
  console.log(
    `TOTAL FT: ${sumFt} | TOTAL DB: ${sumDb} | Δ=${
      sumDb - sumFt >= 0 ? "+" : ""
    }${sumDb - sumFt}`
  );

  // Code retour non-zero si écart (utile en CI)
  const hasGap = rows.some((r) => r.delta !== 0);
  if (hasGap) process.exit(2);
}

const args = Object.fromEntries(
  process.argv.slice(2).map((p) => {
    const [k, v] = p.replace(/^--/, "").split("=");
    return [k, v];
  })
);

await runAudit({
  since:
    args.since || new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString(), // 7 jours par défaut
  until: args.until || new Date().toISOString(),
  filterDeps: (args.deps || "").split(",").filter(Boolean), // ex: --deps=31,75,974
});
