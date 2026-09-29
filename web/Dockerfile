# The game server, with the built site inside it: one container hosts the pages and
# the meadow. Build from the web/ directory:
#
#   docker build -t fly-meadow .
#   docker run -p 8787:8787 fly-meadow
#
# Then http://localhost:8787/play.html is the game and /healthz says who is in it.
# Any host that runs a container and passes WebSockets through will do (Fly.io,
# Railway, Render, a VPS). Give it one core per meadow: each meadow is a brain on
# its own thread, and a brain needs a core to run at real time.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# the pages, then the server bundle (esbuild, shipped with vite)
RUN npx vite build && node server/build.mjs

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8787
COPY --from=build /app/package.json /app/package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/server/dist ./server/dist
# the brain: the subnet and its wiring, read by the brain thread at start-up
COPY --from=build /app/public/data/subnet.bin /app/public/data/pet.json ./public/data/
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost:8787/healthz || exit 1
CMD ["node", "server/dist/main.mjs"]
