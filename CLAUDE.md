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

There is **no test suite**. Verify changes by running both servers and driving the map at `localhost:5173/map`.

### Data pipeline (offline / one-time scripts, run from `backend/`)

The map's static data is produced by scripts, not at request time. Rough order:

1. `fetch_acs.py` — pull ACS 5-year tables from the Census API → `acs_raw.csv` (needs `CENSUS_API_KEY`)
2. `compute_index.py` — percentile-rank normalize indicators + weighted need score → `acs_with_index.csv`. Also joins on the `food_desert` flag from `food_desert.load_flags()`, because **both** downstream consumers of that CSV need the column (`build_geojson.py` bakes it into the GeoJSON, `migrate_to_supabase.py` writes it to `ACSRecord`). Its own 4-indicator weighting is only the static fallback baked into the GeoJSON — the live map recomputes need from all 7 indicators.
3. `build_geojson.py` — join scores onto the tract shapefile (`geo/tl_2022_12_tract.shp`) → tract GeoJSON
4. `seed.py` (local SQLite) / `migrate_to_supabase.py` (→ Supabase) — load ACS records into the DB
5. `geocode_agencies.py` — geocode `frontend/public/agencies.csv` → `frontend/public/agencies.geojson` (Census geocoder, no key)
6. `food_desert.py --build` — regenerate the committed `food_desert_flags.json` (GEOID→0/1) from the USDA atlas + 2010→2020 crosswalk in `geo/`; `food_desert.py --sink=db` pushes flags into Supabase. (Replaces the old `add_usda.py`/`load_food_desert.py`.)

The primary runtime path is `POST /api/acs/fetch?acs_year=` (2020–2025 only): `_do_acs_fetch` runs `fetch_acs.fetch_acs_data` on a background thread, attaches the `food_desert` flag from `food_desert.load_flags()`, computes a **real** `need_score` via `scoring.compute_need_scores`, and bulk-inserts. Progress is tracked in the DB (`acs_fetch_jobs` table via `_set_fetch_job`), not in memory — so it survives restarts and works across workers.

### Shared logic — `backend/scoring.py`
Single source of truth for both scores and shared lookups: `ZIP_POPULATION`/`DEFAULT_ZIP_POP`, `normalize_county`/`county_from_geoid` (canonical Title Case, incl. Monroe), `impact_score(individuals, meals, population)`, and `compute_need_scores(df)` (percentile-rank weighted avg incl. `food_desert` at 20%, matching the frontend `DEFAULT_WEIGHTS`; drops institutional 9800–9999 and pop<100 tracts). The frontend mirror is `frontend/src/lib/counties.js`. **Do not re-implement these formulas** — the map (`HealthMap.jsx`), trend chart (`TrendChart.jsx`), and stored DB values all read the county rollup from `GET /api/fsf/county-summary`, which is the one place the impact score is computed.

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
- **NaN/Inf breaks JSON serialization** (Starlette rejects it). The ACS tracts endpoint runs every float through `_clean()`; keep that when adding fields.
- Choropleth colors use MapLibre `setFeatureState`, which requires the source tiles to be ready — set feature state inside `map.once("idle", ...)` after `source.setData()`, or colors silently don't render.
- Tract IDs are 11-digit strings (state 2 + county 3 + tract 6, e.g. `12086013600`); the DB and `tracts_2022.geojson` GEOIDs match exactly (1526/1526). Preserve leading zeros — `.zfill(11)` when building keys from numeric sources.
- `.env`, `*.env`, `backend/geo/`, `backend/fsf_data.db`, and `frontend/dist/` are gitignored; the `geo/` shapefiles and USDA xlsx are large local-only inputs for the pipeline. **`geo/` is NOT present on Render at runtime** — anything the server needs from it must come from a committed artifact (e.g. `backend/food_desert_flags.json`), never read `geo/` in request/fetch code.
- `backend/.env` `DATABASE_URL` points at **production Supabase**. When testing fetch/upload/delete locally, override to SQLite (`DATABASE_URL=sqlite:///./fsf_data.db`) — never run mutations against Supabase during dev.
- ACS fetch is restricted to years **2020–2025** (`MIN_ACS_YEAR`/`MAX_ACS_YEAR` in `main.py`): earlier vintages use 2010 tract boundaries that won't join `tracts_2022.geojson`.
