#!/usr/bin/env bash
set -euo pipefail

OFFRES_URL='https://api.francetravail.io/partenaire/offresdemploi/v2/offres/search'
: "${TOKEN:?Export d'abord le token :  export TOKEN='...'}"

DEPS='01 02 03 04 05 06 07 08 09 10 11 12 13 14 15 16 17 18 19 2A 2B 21 22 23 24 25 26 27 28 29 30 31 32 33 34 35 36 37 38 39 40 41 42 43 44 45 46 47 48 49 50 51 52 53 54 55 56 57 58 59 60 61 62 63 64 65 66 67 68 69 70 71 72 73 74 75 76 77 78 79 80 81 82 83 84 85 86 87 88 89 90 91 92 93 94 95 971 972 973 974 976'
PAGE=150

mkdir -p ft_dump
: > all_france.ndjson

for DEP in $DEPS; do
  echo "[${DEP}] interrogation du total (7 jours)…"
  HDR="$(mktemp)"
  HTTP_STATUS=$(curl -sS -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer $TOKEN" \
    -H "Accept: application/json;charset=utf-8" \
    -H "Range: offres 0-0" \
    -D "$HDR" \
    "$OFFRES_URL?departement=$DEP&publieeDepuis=7" || true)

  TOTAL="$(awk 'BEGIN{IGNORECASE=1} /^Content-Range:/ {split($3,a,"/"); print a[2]}' "$HDR" | tr -d '\r')"
  rm -f "$HDR"

  if [ -z "${TOTAL:-}" ]; then
    echo "  ↳ pas de Content-Range (status $HTTP_STATUS) → on saute."
    continue
  fi
  if ! [[ "$TOTAL" =~ ^[0-9]+$ ]]; then
    echo "  ↳ TOTAL invalide='$TOTAL' — on saute."
    continue
  fi
  if [ "$TOTAL" -eq 0 ]; then
    echo "  ↳ 0 offre"
    continue
  fi

  echo "  ↳ $TOTAL offres"

  s=0
  while [ "$s" -lt "$TOTAL" ]; do
    e=$((s+PAGE-1)); max=$((TOTAL-1)); [ "$e" -gt "$max" ] && e="$max"

    out="ft_dump/ft_${DEP}_${s}-${e}.json"
    echo "    • page $s-$e …"
    curl -sS --retry 5 --retry-delay 2 --retry-connrefused \
      -H "Authorization: Bearer $TOKEN" \
      -H "Accept: application/json;charset=utf-8" \
      -H "Range: offres $s-$e" \
      "$OFFRES_URL?departement=$DEP&publieeDepuis=7" > "$out"

    node -e "const fs=require('fs');try{const j=JSON.parse(fs.readFileSync('$out','utf8'));(j.resultats||[]).forEach(r=>process.stdout.write(JSON.stringify(r)+'\n'));}catch(e){}" >> all_france.ndjson

    s=$((e+1))
    sleep 0.25
  done
done

echo "----"
if command -v wc >/dev/null 2>&1; then
  echo "Lignes NDJSON : $(wc -l < all_france.ndjson 2>/dev/null || echo 0)"
fi
head -n 3 all_france.ndjson || true
