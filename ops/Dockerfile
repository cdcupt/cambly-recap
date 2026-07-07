# ops/Dockerfile — Cambly Recap generator image (TECH §6 "Dockerfile").
#
# One short-lived container, cron-fired via `docker compose run --rm generator`.
# Zero npm dependencies — Node 22 native fetch covers all three APIs (Cambly,
# OpenAI, Resend), so there is no install step and no lockfile to drift.
#
# Pinned to a concrete 22.x LTS minor (>= 22.8, per package.json engines and the
# --test-coverage-lines flag used in CI). node:22.12 is the first 22.x LTS ("Jod").
#
# RUNS AS ROOT — deliberate (TECH §6): the session-state secret is bind-mounted
# read-only at /secrets/cambly-state.json as a chmod-600 root-owned file, so a
# non-root process could not read that mount. Isolation is the container boundary,
# not the in-container uid. To run non-root instead, chown the secret to a service
# uid before mounting it.
FROM node:22.12-alpine

# Least-surprise runtime hardening for a short-lived job.
ENV NODE_ENV=production \
    TZ=UTC

WORKDIR /app

# package.json first: it declares "type":"module" (run.js is ESM) and the >=22.8
# engine. Copied on its own so this layer caches independently of src/ churn.
COPY package.json ./
COPY src ./src

# The container's only job: one generator run, then exit with a PRD outcome code
# (0 published/no-classes · 2 fetch-failed · 3 auth-expired). CLI flags (--backfill,
# --force, --manual) are appended by the caller: `docker compose run --rm generator --backfill`.
ENTRYPOINT ["node", "src/run.js"]
