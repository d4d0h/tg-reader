FROM node:22.23.4-alpine

WORKDIR /app

# Copy manifests first for layer caching — including the lockfile so the
# runtime image ships exactly the dependency versions CI tested (npm ci),
# with devDependencies (typescript, vitest) omitted from the final layer set.
COPY package.json package-lock.json tsconfig.json ./

# Install build toolchain in a stage-local way: install everything (tsc needed),
# compile, then prune to production dependencies only.
RUN npm ci
COPY src/ ./src/
RUN ./node_modules/.bin/tsc --outDir dist
RUN npm prune --omit=dev

# Ensure persistent volume mount point exists (Fly mounts tg_state volume here)
RUN mkdir -p /data

CMD ["node", "dist/listener.js"]
