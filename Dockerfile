# Multi-stage Dockerfile for Guess the Flag.
#
# Stage 1: install production dependencies in a clean directory.
# Stage 2: copy them + the app source into a slim runtime image.
#
# Why two stages: keeps the final image small (no build tools, no dev deps,
# no npm cache) and gives us a clean layer to cache `npm ci` against.

# -------- Stage 1: deps --------
FROM node:20-alpine AS deps
WORKDIR /app

# Copy only the dependency manifests so the install layer is reused
# whenever the rest of the source changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev


# -------- Stage 2: runtime --------
FROM node:20-alpine AS runtime

# Run as a non-root user (node:20-alpine ships with a `node` user already).
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# Bring in production node_modules from the deps stage…
COPY --from=deps --chown=node:node /app/node_modules ./node_modules

# …and the app source.
COPY --chown=node:node package.json ./
COPY --chown=node:node server ./server
COPY --chown=node:node public ./public

USER node
EXPOSE 3000

# Tini (pid 1) isn't strictly required for Node, but `node --enable-source-maps`
# is a small win for production stack traces with no perf cost.
CMD ["node", "--enable-source-maps", "server/index.js"]
