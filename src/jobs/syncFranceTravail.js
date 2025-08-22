// src/jobs/syncFranceTravail.js
import "dotenv/config";
import { DEPARTEMENTS_LIST } from "../lib/departements.js";
import supabase from "../lib/supabaseClient.js";
import { ftSearchWindowed, mapFtOffer } from "../services/franceTravail.js";

function iso(d) {
  return new Date(d).toISOString();
}

async function upsertBatch(rows, seenAtISO) {
  if (!rows.length) return;

  // on force le last_seen_at et is_active=true
  const payload = rows.map((r) => ({
    ...r,
    last_seen_at: seenAtISO,
    is_active: true,
  }));

  const { error } = await supabase
    .from("offres_raw")
    .upsert(payload, { onConflict: "provider,provider_id" });

  if (error) throw error;
}

export async function syncFranceTravail({ days = 14 } = {}) {
  const started = new Date();
  const seenAtISO = started.toISOString();

  const minISO = iso(new Date(Date.now() - days * 24 * 3600 * 1000));
  const maxISO = iso(new Date());

  for (const { code } of DEPARTEMENTS_LIST) {
    console.log(`↳ FT sync département ${code} [${minISO} → ${maxISO}]`);
    const offers = await ftSearchWindowed(
      { departement: code },
      minISO,
      maxISO
    );

    // map → upsert par paquets
    const mapped = offers.map(mapFtOffer);
    const CHUNK = 1000;
    for (let i = 0; i < mapped.length; i += CHUNK) {
      await upsertBatch(mapped.slice(i, i + CHUNK), seenAtISO);
    }
  }

  // Désactiver tout ce qui n'a pas été "vu" pendant ce tour
  const { error: updErr } = await supabase
    .from("offres_raw")
    .update({ is_active: false })
    .lte("last_seen_at", iso(started)) // plus ancien que ce tour
    .eq("provider", "france-travail");

  if (updErr) throw updErr;

  console.log("✓ Sync France Travail terminée");
}
