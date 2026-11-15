FROM node:22.23.4-alpine

WORKDIR /app

# Copy manifests first for layer caching — including the lockfile so the
# runtime image ships exactly the dependency versions CI tested (npm ci).
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./

# Install everything (typescript needed for the build), compile ONLY the
# runtime graph via tsconfig.build.json (listener + its imports — operator
# scripts like enrich-*/backfill-* need `pg` and stay out of the image),
# then prune to production dependencies.
RUN npm ci
COPY src/ ./src/
RUN ./node_modules/.bin/tsc -p tsconfig.build.json
RUN npm prune --omit=dev

# Ensure persistent volume mount point exists (Fly mounts tg_state volume here)
RUN mkdir -p /data

CMD ["node", "dist/listener.js"]
