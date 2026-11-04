FROM node:20-alpine

# Install build dependencies for compiling canvas / binary modules on Alpine
RUN apk add --no-cache python3 make g++ pkgconfig pixman-dev cairo-dev pango-dev libjpeg-turbo-dev giflib-dev

WORKDIR /app

COPY package*.json ./

RUN npm ci --only=production

COPY backend/ ./backend/

# Bez roota: proces v kontejneru nemá práva správce (review 2, skupina 5).
RUN chown -R node:node /app
USER node

ENV PORT=4000
EXPOSE 4000

CMD ["node", "backend/server.js"]
