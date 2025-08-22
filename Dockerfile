# ⚙️ Utilise une image Node.js légère
FROM node:20-slim

# 📁 Dossier de travail dans le conteneur
WORKDIR /app

# 📦 Installation des dépendances
COPY package*.json ./
RUN npm install --omit=dev

# 📁 Copie tout le reste du code
COPY . .

# 🚀 Lance l'application
CMD ["node", "src/app.js"]
