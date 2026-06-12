#!/bin/sh
# One-shot entrypoint for the compose `seed` service (node:22 container).
# Installs deps, waits for Directus health (node fetch — no curl/wget dependency),
# then runs the idempotent bootstrap. Invoked via `make seed`.
set -e
cd /work

echo "seed: installing deps..."
npm install --no-audit --no-fund --no-package-lock

echo "seed: waiting for Directus health (max 120s)..."
node -e '
  const url = process.env.DIRECTUS_URL + "/server/health";
  const deadline = Date.now() + 120000;
  (async () => {
    for (;;) {
      try { const r = await fetch(url); if (r.ok) { console.log("seed: directus healthy"); return; } } catch {}
      if (Date.now() > deadline) { console.error("seed: directus health timeout"); process.exit(1); }
      await new Promise((s) => setTimeout(s, 2000));
    }
  })();
'

node bootstrap.mjs
