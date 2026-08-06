# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An internal planning tool for **Feeding South Florida (FSF)** program staff to spot geographic gaps in food-access partner coverage. Staff overlay census-tract **need** (poverty, SNAP, no-vehicle, low-income, USDA food-desert flags) against FSF **distribution accomplishment** and current partner-agency locations, then surface high-need tracts that no agency covers.

Covers four Florida counties: Miami-Dade (FIPS `086`), Broward (`011`), Palm Beach (`099`), Monroe (`087`).

## Commands

**Frontend** (`frontend/`):
```bash
npm install
npm run dev       # Vite dev server on :5173
npm run build     # → frontend/dist (Vercel output)
npm run lint      # eslint
npm run preview
```

**Backend** (`backend/`, requires the venv):
```bash
source venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

The only tests are `backend/tests/test_impact_score.py` (24 self-contained unit tests for the impact-score formula — they import nothing from the app). Run with `python -m pytest tests/ -q` from `backend/`. There is **no test coverage for the need score**; verify those changes by running both servers and driving the map at `localhost:5173/map`.

### Data pipeline (offline / one-time scripts, run from `backend/`)

The map's static data is produced by scripts, not at request time. Rough order:

1. `fetch_acs.py` — pull ACS 5-year tables from the Census API → `acs_raw.csv` (needs `CENSUS_API_KEY`)
2. `compute_index.py` — percentile-rank normalize indicators + weighted need score → `acs_with_index.csv`. Also joins on the `food_desert` flag from `food_desert.load_flags()`, because `build_geojson.py` bakes that column into the GeoJSON. Its own 4-indicator weighting is a **static fallback only** — `normalizeTracts()` in `HealthMap.jsx` overwrites every `need_score`/`*_norm` it bakes in, on every load. Nothing reads the baked values.
3. `build_geojson.py` — join scores onto the tract shapefile (`geo/tl_2022_12_tract.shp`) → `backend/tracts_2022.geojson`. **Then copy it manually to `frontend/public/tracts_2022.geojson`** — that copy is the one the app actually serves; the `backend/` original is gitignored.
4. `geocode_agencies.py` — geocode `frontend/public/agencies.csv` → `frontend/public/agencies.geojson` (Census geocoder, no key)
5. `food_desert.py --build` — regenerate the committed `food_desert_flags.json` (GEOID→0/1) from the USDA atlas + 2010→2020 crosswalk in `geo/`; `food_desert.py --sink=db` pushes flags into Supabase. (Replaces the old `add_usda.py`/`load_food_desert.py`.)

These scripts only rebuild the **static** artifacts (tract geometry, food-desert flags). ACS records reach the database exclusively through `POST /api/acs/fetch` — there is no seeding script. (`seed.py` and `migrate_to_supabase.py` were removed: `seed.py` never set `acs_year`, so the batches it wrote were invisible to every read endpoint, and `migrate_to_supabase.py` was a one-time SQLite→Supabase migration whose source data is long stale.)

The primary runtime path is `POST /api/acs/fetch?acs_year=` (2020–2025 only): `_do_acs_fetch` runs `fetch_acs.fetch_acs_data` on a background thread, attaches the `food_desert` flag from `food_desert.load_flags()`, computes a **real** `need_score` via `scoring.compute_need_scores`, and bulk-inserts. Progress is tracked in the DB (`acs_fetch_jobs` table via `_set_fetch_job`), not in memory — so it survives restarts and works across workers.

### Shared logic — `backend/scoring.py`
Single source of truth for both scores and shared lookups: `ZIP_POPULATION`/`DEFAULT_ZIP_POP`, `normalize_county` (fuzzy free-text county name → canonical Title Case, incl. Monroe), `impact_score(individuals, meals, population)`, and `compute_need_scores(df)` (percentile-rank weighted avg incl. `food_desert` at **18%**, matching the frontend `DEFAULT_WEIGHTS`). Resolving a county *from a tract GEOID* is frontend-only — `countyFromGeoid` in `frontend/src/lib/counties.js`. **Do not re-implement these formulas** — the map (`HealthMap.jsx`), trend chart (`TrendChart.jsx`), and stored DB values all read the county rollup from `GET /api/fsf/county-summary`, which is the one place the impact score is computed.

**Tract eligibility is enforced in three places and they must agree**: `scoring.eligible_tract_mask()` (backend), `isEligibleTract()` in `HealthMap.jsx` (live map), and the filter in `compute_index.py` (offline). All three drop institutional tracts (code 9800–9999 — prisons, dorms, barracks, airports) and tracts with population < 100. The frontend recomputes need scores from raw indicators, so **omitting the check there silently re-admits tracts the backend excluded** — a 9800-series group-quarters tract with 83% poverty otherwise ranks as the single highest-need tract on the map and tops the coverage-gap list.

## Architecture

**Three deployed pieces:**
- **Frontend** — React + Vite, static, on Vercel. Framework setting in the Vercel dashboard must be `null` for the custom `buildCommand`/`outputDirectory` in `vercel.json` to apply. `VITE_API_URL` (Vercel env) points at the Render backend.
- **Backend** — FastAPI on Render.com (`render.yaml`). Free tier → ~15s cold start on first request. Env vars `DATABASE_URL` and `CENSUS_API_KEY` set in the Render dashboard.
- **Database** — Supabase PostgreSQL (falls back to local `sqlite:///./fsf_data.db` when `DATABASE_URL` is unset). Holds ACS records for multiple years (2021–2024) + FSF distribution uploads.

**Backend (`backend/main.py`, `database.py`):**
- Four tables (`database.py`): `ACSRecord` + `UploadBatch` (ACS need data), `FSFDistribution` + `FSFUploadBatch` (distribution accomplishment). Both domains use a **batch pattern**: one active batch per year, older batches marked `archived` rather than deleted.
- ACS endpoints: `/api/acs/{tracts,available-years,fetch,fetch-status,upload-history}`.
- FSF endpoints: `/api/fsf/{upload,distributions,available-years,upload-history}` — upload is a CSV keyed by `zip_code`/`county`; the backend computes an `impact_score` (0–100) per row and again at the county level.
- CORS allows `localhost:5173` and any `*.vercel.app` origin.

**Frontend (`frontend/src/pages/HealthMap.jsx` — ~1500 lines, the whole app):**
- Routes: `/` (`Home.jsx`) and `/map` (`HealthMap.jsx`). MapLibre GL JS choropleth.
- Two toggleable layers: **need** (ACS) and **accomplishment/impact** (FSF distribution).
- Tract geometry loads from the static `frontend/public/tracts_2022.geojson` (1526 tracts) and is joined **client-side** by `tract_id` GEOID against ACS values fetched from the API. Agency points load from static `frontend/public/agencies.geojson`.
- **Default map view frames the tri-county core, not all four counties.** Monroe runs west to the Dry Tortugas (−83.1°W), which would triple the viewport width; `HealthMap.jsx` fits bounds over non-`12087` tracts and only widens `maxBounds` to include Monroe, so the Keys are reachable by panning. `fullBounds` (the reset-view target) is the tri-county box.
- **Weighted need score is recomputed in the browser**, not the DB. `normalizeTracts()` percentile-rank normalizes each indicator (CDC SVI method — robust to outliers; `median_income` inverted), then applies user-adjustable weight sliders (`DEFAULT_WEIGHTS`). Editing weights re-scores live.
- **Gap analysis** (`recomputeGap`): draws coverage circles of adjustable `radius` (miles) around agencies and flags high-need tracts whose centroid falls outside all circles.

## Gotchas

- **psycopg3 only** (`psycopg[binary]`, no psycopg2). `database.py` rewrites any `postgres://` / `postgresql://` `DATABASE_URL` to the `postgresql+psycopg://` prefix and appends `sslmode=require` (Supabase needs SSL). Don't hand it a bare `postgresql://` and expect psycopg2.
- **ACS percent fields are already percentages** (e.g. `pct_below_poverty = 17.58` means 17.58%). Do **not** multiply by 100 in the frontend.
- **`housing_cost_burden_pct` excludes households whose cost ratio ACS never computes** — B25106 zero/negative-income owners and renters, and renters paying no cash rent (`HOUSING_UNCOMPUTED_CODES` in `fetch_acs.py`). They sit inside the `B25106_001E` total but can never appear in the "30 percent or more" numerator, so dividing by the raw total understates the rate — measured at 1.6pp on average and up to 10.5pp, worst in high-poverty tracts. This matches HUD's standard treatment. **Years fetched before this change are ~1–2pp low; re-fetch with `force=true` to correct them.**
- **Unpopulated `ACSRecord` columns are NULL, not `0.0`** (`pct_low_income`, `pct_children_under18`, `pct_seniors_65plus`). A stored `0.0` is indistinguishable from a real measured zero. `safe_float` also returns `None` rather than NaN — Postgres would otherwise store a literal `'NaN'::float8` that poisons any later `AVG()`, while SQLite coerces it to NULL, so dev and prod would disagree.
- **NaN/Inf breaks JSON serialization** (Starlette rejects it). The ACS tracts endpoint runs every float through `_clean()`; keep that when adding fields.
- Choropleth colors use MapLibre `setFeatureState`, which requires the source tiles to be ready — set feature state inside `map.once("idle", ...)` after `source.setData()`, or colors silently don't render.
- Tract IDs are 11-digit strings (state 2 + county 3 + tract 6, e.g. `12086013600`); the DB and `tracts_2022.geojson` GEOIDs match exactly (1526/1526). Preserve leading zeros — `.zfill(11)` when building keys from numeric sources.
- `.env`, `*.env`, `backend/geo/`, `backend/fsf_data.db`, and `frontend/dist/` are gitignored; the `geo/` shapefiles and USDA xlsx are large local-only inputs for the pipeline. **`geo/` is NOT present on Render at runtime** — anything the server needs from it must come from a committed artifact (e.g. `backend/food_desert_flags.json`), never read `geo/` in request/fetch code.
- `backend/.env` `DATABASE_URL` points at **production Supabase**. When testing fetch/upload/delete locally, override to SQLite (`DATABASE_URL=sqlite:///./fsf_data.db`) — never run mutations against Supabase during dev. The override does work: `load_dotenv()` defaults to `override=False`, so a shell variable wins over `.env`.
- **Check nothing is already listening on :8000 before trusting that override.** If a `uvicorn` is already running (e.g. an old `--reload` session from days ago), a second one fails with `[Errno 48] address already in use`, exits, and every request silently goes to the *first* server — which is probably on production. The failure is only visible in the new server's log, not in the response. Confirm with `lsof -i :8000 -sTCP:LISTEN` and check `GET /api/acs/upload-history` (production has 1526-row batches; the local SQLite snapshot has 1497-row ones).
- ACS fetch is restricted to years **2020–2025** (`MIN_ACS_YEAR`/`MAX_ACS_YEAR` in `main.py`): earlier vintages use 2010 tract boundaries that won't join `tracts_2022.geojson`.
