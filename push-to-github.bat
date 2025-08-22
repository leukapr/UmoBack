@echo off
echo === Umoja : Initialisation Git ===

:: Déclare le dossier comme safe
git config --global --add safe.directory E:/umoja-project/backend

cd backend
git add .
git commit -m "Mise à jour backend"
git push origin main

echo === ✅ Code poussé sur GitHub avec succès ! ===
pause
