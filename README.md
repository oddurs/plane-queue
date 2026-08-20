# plane queue

A boarding strategy simulator. It runs a cabin full of passengers — bags, seat
shuffles, families, aisle congestion — under eight different boarding orders and
measures what actually happens, rather than what the airline says happens.

The simulation is the interface: it starts boarding as soon as the page opens.
Configuration lives in a drawer, analysis lives under the handle at the bottom.

## Running it

```sh
npm install
npm run dev        # vite dev server
npm test           # 192 tests, ~2s
npm run typecheck  # tsc --noEmit
npm run build      # typecheck + production build into dist/
```

## Layout

- `src/engine/` — the simulation. Deterministic given a seed; no DOM.
- `src/render/` — canvas layers: the cabin and the congestion heatmap.
- `src/ui/` — panels, controls, charts.
- `src/gate/` — the founders-gate cookie signing, used by `middleware.ts`.
- `test/` — the engine's contracts, plus a sweep of every configuration the
  controls can produce.

## Deployment

The site deploys to Vercel as a static build, behind a password gate.

`middleware.ts` runs at the edge ahead of the static files: without a valid
cookie it serves a login page, and it fails closed if no password is configured,
so a missing environment variable can never publish the site by accident.

One environment variable, on every environment that should be reachable:

```sh
vercel env add FOUNDERS_PASSWORD production
```

The cookie is signed with the password itself, so changing it signs everyone
out — that is the revocation mechanism. Sessions last 30 days.

To run the gate locally, `vercel dev` with `FOUNDERS_PASSWORD` set; plain
`npm run dev` serves the site ungated, which is what you want while working.
