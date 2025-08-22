# Dépendances prod
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# Runner
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# (facultatif) si tu veux un healthcheck via curl, installe-le avant USER
# RUN apk add --no-cache curl
USER node
EXPOSE 3000
CMD ["node", "src/app.js"]
