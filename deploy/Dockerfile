# Self-hosted PokéRogue (savestate fork): static Vite build served by nginx,
# which also relays /rogueapi/* to the official API (see deploy/nginx.conf).
# Distinct from the upstream ./Dockerfile (which containerizes the dev server).
#
# Build FROM THE REPO ROOT (submodules assets/ and locales/ must be checked out):
#   docker build -f deploy/Dockerfile \
#     --build-arg VITE_SERVER_URL=https://pokerogue.antomarioni.com/rogueapi -t pokerogue .

FROM node:24 AS build
WORKDIR /app

COPY package.json pnpm-lock.yaml ./
# The repo's postinstall runs lefthook + git config, which need a git repo
RUN corepack enable && git init -q . && pnpm install --frozen-lockfile

COPY . .

# Baked into the bundle: where the client reaches the (proxied) API
ARG VITE_SERVER_URL=https://pokerogue.antomarioni.com/rogueapi
ENV VITE_SERVER_URL=${VITE_SERVER_URL}

RUN pnpm build

FROM nginx:1.29-alpine
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
