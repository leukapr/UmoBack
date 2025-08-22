// convert-jwk-to-pem.js
import fs from "fs";
import jwkToPem from "jwk-to-pem";

// Colle ici ta JWK (clé publique JSON Web Key)
const jwk = {
  x: "AJfKlZORuz78XaqdR5x7nw1g6pf3030BVtvJX_PM0ps",
  y: "gnc2oLAPS_yegzlB7eBpghse7WcujvweQfUBz-6mXJk",
  alg: "ES256",
  crv: "P-256",
  ext: true,
  kid: "58df6068-ea7d-4ac6-b329-6cefa56eec6a",
  kty: "EC",
  key_ops: ["verify"]
};

// Conversion en format PEM
const pem = jwkToPem(jwk);

// Écriture dans un fichier
fs.writeFileSync("supabase_public_key.pem", pem);

console.log("✅ Fichier supabase_public_key.pem généré !");
