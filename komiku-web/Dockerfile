# syntax=docker/dockerfile:1

##############################################################################
# Komik Hub — web frontend (React 19 + Vite 8 + TS + Tailwind 4)
#
# Stage 1 compiles the SPA to dist/. Stage 2 serves it with nginx and
# reverse-proxies /api + /img to the Rust backend (service: komiku-server:8788)
# on the compose network. nginx stays the only public entrypoint so browser
# calls stay same-origin (service worker + offline cache depend on that).
##############################################################################

# ---------- Stage 1: build ---------------------------------------------------
FROM node:22-alpine AS build

WORKDIR /app

# Deps first for layer caching: lockfile-only change re-runs just this layer.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# App sources (node_modules/dist excluded via .dockerignore).
COPY . .

RUN npm run build

# ---------- Stage 2: serve --------------------------------------------------
FROM nginx:alpine AS serve

# Static shell + hashed assets.
COPY --from=build /app/dist /usr/share/nginx/html

# SPA routing + /api,/img proxy to komiku-server:8788.
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
