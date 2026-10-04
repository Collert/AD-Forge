# Slicing backend: current setup and how to scale it later

Notes from October 2026, when the old Python/PrusaSlicer backend was folded into the SvelteKit app
and switched to OrcaSlicer. Nothing described under "Scaling plan" has been built yet.

## How it works today

Everything runs inside the SvelteKit server. OrcaSlicer is run as a child process.

**Quote** (`POST /api/quote`, [src/routes/api/quote/+server.ts](../src/routes/api/quote/+server.ts)):

1. The browser sends the part as a binary STL (rotation and scale already applied by the viewer)
   plus the material, colour and print settings.
2. The server validates the settings against [src/lib/catalog/config.ts](../src/lib/catalog/config.ts),
   picks OrcaSlicer presets (printer + nozzle, closest print profile, filament matched from the
   product title or the `custom.orca_filament` metafield) and flattens their `inherits` chains.
   The Orca CLI does **not** resolve `inherits` for presets loaded from a file; without flattening
   you get a 200 mm bed and zero filament density.
3. It builds a minimal 3MF: the mesh, plus the customer's settings as **object-level** metadata in
   `Metadata/model_settings.config`. This must be a plain 3MF. One that claims to be from Bambu
   Studio without a full `project_settings.config` crashes the CLI.
4. Orca runs twice in parallel on it:
   - `--slice 0`: G-code, read for filament volume, print time and layer count (the price);
   - `--export-3mf` with no slicing: the full Bambu/Orca project, which is the file we keep.
5. The project file and a `quote.json` record are stored in `DATA_DIR/quotes/<quoteId>/`
   for 24 h.

**Save** (`POST /api/designs`, [src/lib/server/finalize.ts](../src/lib/server/finalize.ts)):
adds the viewer snapshot as the plate preview, writes `MODELS_DIR/<email>/<name>_<id>.3mf`, and
creates the unlisted Shopify product ([src/lib/server/designs.ts](../src/lib/server/designs.ts)).
It never re-slices: the stored file is exactly the one that was quoted.

Because the settings are on the object, importing the 3MF into any project keeps them, even if
that project's global process is different (verified: a part saved at 0.12 mm / 40 % cubic still
sliced that way inside a `0.24mm Draft` project).

**SLA** works the same way, with three differences:

- **Resin volume.** A solid part's volume comes straight from the mesh, with no slicing.
  A hollow part is sliced by Orca as a 2 mm shell with 0 % infill, on the X1C profile,
  since only the geometry matters.
- **Supports** are priced from the overhang area, not from Orca, since SLA supports are
  nothing like FDM supports.
- **The kept file** is an Anycubic Photon Workshop scene (`.pwscene`) instead of a 3MF.
  It's reverse-engineered from a Photon Workshop 4.1 file; the layout is documented at the
  top of `pwscene.ts`. The printer profile (Photon Mono 4) and all resin profiles are copied
  from that file into `src/lib/server/slicer/pwscene/`. The scene selects the resin and sets
  its layer height. Supports and hollowing aren't stored in the scene; they're done in
  Photon Workshop.

**CNC** doesn't use Orca. The server runs the configurator's own tool-access analysis
(`analyzeMachiningAsync` in `src/lib/viewer/machining.ts`) and prices the part with the same
estimator, so the quote equals the estimate. The analysis pauses between slices so it doesn't
freeze the server; it takes ~1.5 s for a 17k-triangle part and ~11 s for 400k. The kept file is
the customer's STEP file, exactly as uploaded; scaled parts are refused.

Slicer code: [src/lib/server/slicer/](../src/lib/server/slicer/):

| File | Role |
| --- | --- |
| `orca.ts` | Runs the CLI, limits concurrent runs, maps exit codes to messages |
| `presets.ts` | Indexes, flattens and picks Orca system presets |
| `settings.ts` | Configurator settings → Orca option keys (validated) |
| `threemf.ts` | STL parsing, the input 3MF, adding the preview to the stored 3MF |
| `quotes.ts` | Orchestrates a quote (FDM or SLA), prices it, stores and reads quote records |
| `pwscene.ts` | Writes Photon Workshop scenes for SLA |

## Why it's inside SvelteKit (for now)

Performance is about the same either way: almost all of a quote's time is Orca itself
(~1 s small parts, ~15–20 s for a 400k-triangle part with supports). Running in-process saves
small overheads rather than slicing time:

- no Shopify calls per quote (the old backend fetched price and density on every quote; the app
  already caches the catalog);
- the STL is uploaded once, not relayed to a second service;
- pricing and validation share `config.ts` with the UI, so nothing is duplicated.

Downsides of this setup:

- it needs a Node server or Docker host. Serverless hosts (Vercel, Netlify) can't run Orca, and
  the app still uses `adapter-auto`, so a deploy needs `adapter-node`;
- heavy slices share CPU with page serving (capped at two Orca runs at a time);
- the web image carries the large Orca install, so every frontend deploy rebuilds a big image.

## Scaling plan (Dokploy + Docker Swarm)

The idea: let the swarm run several slicer containers so heavy load spreads across the PCs.
That works, but **not with the code as it is**.

### What blocks running more replicas today

1. **Quotes are stored on the container's local disk.** A quote's project file is in that
   container's `data/quotes/`, and saving reads it back from there. With several replicas, the
   save can hit a different one and the customer sees "quote expired". `data/models/` would also
   end up split across containers.
2. **Swarm doesn't scale anything on its own.** It keeps the number of replicas you set. As far
   as I know Dokploy sets a replica count but doesn't scale on load (worth checking). Options:
   a fixed number of spare slicer replicas (cheap when idle), or a small script that watches load
   and runs `docker service scale`.
3. **Swarm's load balancer is round-robin.** It doesn't know which replica is busy, so a quote can
   wait behind a 20 s slice while another replica is idle. Fine at small scale.
4. **Smaller things:**
   - the concurrency cap in `orca.ts` comes from the CPU count, and a container sees the host's
     cores unless CPU limits are set. Set CPU limits per replica and cap it at 1–2;
   - the Orca image is big (~1 GB?), so pre-pull it on every node or new replicas start slowly;
   - Orca's command line has only been tested on Windows. The Linux build needs some GUI
     libraries even when used headless, so the Docker image needs a test run.

### Recommended architecture

- **Web app:** SvelteKit with 1–2 replicas. Owns all state (quote records, finalized models,
  Shopify) on **one shared volume**: NFS on one of the PCs, or MinIO for object storage.
- **Slicer service:** a small **stateless** Node service, scaled freely. It takes the STL,
  settings and chosen presets, runs Orca, and returns the stats plus the project 3MF. It stores
  nothing, so any replica can handle any request and round-robin is good enough.
- **Later, if needed:** a job queue (Redis + BullMQ, for example) between them. Slicer workers
  pull jobs when free, so load spreads properly, adding replicas adds capacity, and long slices
  can report progress.

### What moves where

- To the slicer service, nearly unchanged: `orca.ts`, `presets.ts`, `settings.ts`, `threemf.ts`,
  and the "build input 3MF → run Orca twice → read G-code stats" part of `quotes.ts`.
- Stays in the app: request validation against the catalog, pricing, quote records, finalize,
  Shopify.
- Stay in Node rather than going back to Python: the code already exists, and the two services
  can share the settings types.
