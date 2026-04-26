# Multi-stage Dockerfile for Guess the Flag.
#
# Stage 1: install production dependencies in a clean directory.
# Stage 2: copy them + the app source into a slim runtime image.
#
# Why two stages: keeps the final image small (no build tools, no dev deps,
# no npm cache) and gives us a clean layer to cache `npm ci` against.
#
# better-sqlite3 is a native module that needs python + a C++ toolchain
# at install time, but only the compiled .node binary at runtime — so we
# build it in stage 1 and the final image stays slim.

# -------- Stage 1: deps --------
FROM node:20-alpine AS deps
WORKDIR /app

# Toolchain for native modules. Removed automatically because this stage
# is dropped from the final image.
RUN apk add --no-cache python3 make g++

# Copy only the dependency manifests so the install layer is reused
# whenever the rest of the source changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev


# -------- Stage 2: runtime --------
FROM node:20-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
# Default location for the SQLite leaderboard DB. The compose file mounts
# a volume here so the file persists across container restarts.
ENV DATA_DIR=/data

# Bring in production node_modules (already includes the compiled
# better-sqlite3 binary from stage 1).
COPY --from=deps --chown=node:node /app/node_modules ./node_modules

# …and the app source.
COPY --chown=node:node package.json ./
COPY --chown=node:node server ./server
COPY --chown=node:node public ./public

# Make sure the data dir exists and is writable by the `node` user.
RUN mkdir -p /data && chown -R node:node /data
VOLUME ["/data"]

USER node
EXPOSE 3000

CMD ["node", "--enable-source-maps", "server/index.js"]
