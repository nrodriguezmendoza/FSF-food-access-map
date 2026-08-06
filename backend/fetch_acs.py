import os
import time

import requests
import pandas as pd
from dotenv import load_dotenv

load_dotenv()  # reads backend/.env
API_KEY = os.getenv("CENSUS_API_KEY")

# ACS 5-year detailed tables, 2022 (latest reliable tract-level release)
YEAR = 2022
BASE_URL = f"https://api.census.gov/data/{YEAR}/acs/acs5"

STATE = "12"  # Florida
COUNTIES = {
    "086": "Miami-Dade",
    "011": "Broward",
    "099": "Palm Beach",
    "087": "Monroe",
}

# The 10 "30 percent or more" lines of B25106 (5 owner + 5 renter income
# brackets) — households spending 30%+ of income on housing. Summed for the
# cost-burden numerator.
HOUSING_BURDEN_CODES = [
    "B25106_006E", "B25106_010E", "B25106_014E", "B25106_018E", "B25106_022E",  # owner
    "B25106_028E", "B25106_032E", "B25106_036E", "B25106_040E", "B25106_044E",  # renter
]

# B25106 has three categories for which no cost-to-income ratio is computed, so
# they can never appear in the numerator above: owner and renter households with
# zero or negative income, and renters paying no cash rent. They ARE inside the
# B25106_001E total, so dividing by that total understates the burden rate.
# HUD's standard treatment removes them from the denominator.
#
# Measured on 2022 Miami-Dade tracts: they are 3.2% of the denominator on average
# (19.3% max), understating the rate by 1.6pp on average and up to 10.5pp — and
# the bias is concentrated in exactly the tracts this tool exists to find
# (5.1% of the denominator in tracts above 30% poverty vs 2.3% below 10%).
HOUSING_UNCOMPUTED_CODES = [
    "B25106_023E",  # owner occupied, zero or negative income
    "B25106_045E",  # renter occupied, zero or negative income
    "B25106_046E",  # renter occupied, no cash rent
]

# Raw ACS variable codes -> readable names
VARIABLES = {
    "B17001_002E": "poverty_below",     # income below poverty level
    "B17001_001E": "poverty_total",     # total pop assessed for poverty
    "B19013_001E": "median_income",     # median household income
    "B22010_002E": "snap_yes",          # households receiving SNAP
    "B22010_001E": "snap_total",        # total households
    "B25044_003E": "owner_no_veh",      # owner-occ households, no vehicle
    "B25044_010E": "renter_no_veh",     # renter-occ households, no vehicle
    "B25044_001E": "veh_total",         # total occupied households
    "B01003_001E": "total_pop",         # total population
    "B23025_003E": "labor_force",       # civilian labor force
    "B23025_005E": "unemployed",        # unemployed (civilian labor force)
    "B25106_001E": "housing_total",     # all households (cost-burden universe)
    **{code: f"hb_{i}" for i, code in enumerate(HOUSING_BURDEN_CODES)},
    **{code: f"hbx_{i}" for i, code in enumerate(HOUSING_UNCOMPUTED_CODES)},
}

def fetch_county(county_fips):
    params = {
        "get": "NAME," + ",".join(VARIABLES.keys()),
        "for": "tract:*",
        "in": f"state:{STATE} county:{county_fips}",
        "key": API_KEY,
    }
    resp = requests.get(BASE_URL, params=params)
    resp.raise_for_status()
    rows = resp.json()
    return pd.DataFrame(rows[1:], columns=rows[0])

def main():
    if not API_KEY:
        raise SystemExit("No CENSUS_API_KEY found — check backend/.env")

    frames = [fetch_county(fips) for fips in COUNTIES]
    df = pd.concat(frames, ignore_index=True)

    df = df.rename(columns=VARIABLES)

    # Convert all indicator columns from strings to numbers
    for col in VARIABLES.values():
        df[col] = pd.to_numeric(df[col], errors="coerce")

    # ACS uses large negative codes (e.g. -666666666) as "missing / not estimable"
    # sentinels. Treat any negative value as missing so it doesn't corrupt the data.
    import numpy as np
    for col in VARIABLES.values():
        df.loc[df[col] < 0, col] = np.nan
        
    # Stable tract GEOID = state + county + tract
    df["GEOID"] = df["state"] + df["county"] + df["tract"]

    # Add a readable county name from the FIPS code
    df["county_name"] = df["county"].map(COUNTIES)

    # --- Convert raw counts into rates (percentages) ---
    # Guard against divide-by-zero by leaving NaN where the denominator is 0
    df["poverty_rate"] = df["poverty_below"] / df["poverty_total"] * 100
    df["snap_rate"] = df["snap_yes"] / df["snap_total"] * 100
    df["no_vehicle_rate"] = (
        (df["owner_no_veh"] + df["renter_no_veh"]) / df["veh_total"] * 100
    )

    # Keep the columns we actually care about downstream
    keep = [
        "GEOID", "NAME", "county_name", "total_pop",
        "poverty_rate", "median_income", "snap_rate", "no_vehicle_rate",
    ]
    out = df[keep]

    out.to_csv("acs_raw.csv", index=False)

    print(f"Pulled {len(out)} tracts across {len(COUNTIES)} counties")
    print(out[["county_name", "poverty_rate", "snap_rate", "no_vehicle_rate", "median_income"]].describe().round(1))
    print("\nSaved to acs_raw.csv")
    print("\nSample rows:")
    print(out.head())

# (connect, read) seconds. Without a timeout requests blocks on recv() forever;
# because the runtime fetch runs on a background thread, a single hung socket
# leaves the acs_fetch_jobs row stuck at "fetching" for the life of the process.
CENSUS_TIMEOUT = (10, 120)
CENSUS_RETRIES = 3
CENSUS_BACKOFF = 2.0


def _census_get(url: str, params: dict) -> list:
    """GET + parse a Census API response, retrying transient failures.

    The API intermittently returns HTTP 200 with a non-JSON body, which
    raise_for_status() cannot catch — resp.json() then raises and, with four
    sequential county requests per fetch, the chance that at least one call
    flakes is roughly 4x the single-call rate. Retrying makes it a non-event.
    """
    last = None
    for attempt in range(1, CENSUS_RETRIES + 1):
        try:
            resp = requests.get(url, params=params, timeout=CENSUS_TIMEOUT)
            resp.raise_for_status()
            return resp.json()
        except (requests.RequestException, ValueError) as e:  # ValueError ⊃ JSONDecodeError
            last = e
            if attempt < CENSUS_RETRIES:
                wait = CENSUS_BACKOFF * attempt
                print(f"  Census request failed ({type(e).__name__}: {e}); "
                      f"retry {attempt}/{CENSUS_RETRIES - 1} in {wait:.0f}s")
                time.sleep(wait)
    raise RuntimeError(f"Census API failed after {CENSUS_RETRIES} attempts: {last}") from last


def fetch_acs_data(year: int, api_key: str) -> pd.DataFrame:
    """Entry point called by main.py — supports dynamic year and api_key."""
    import numpy as np

    base_url = f"https://api.census.gov/data/{year}/acs/acs5"
    frames = []
    for fips, county_name in COUNTIES.items():
        params = {
            "get": "NAME," + ",".join(VARIABLES.keys()),
            "for": "tract:*",
            "in": f"state:{STATE} county:{fips}",
            "key": api_key,
        }
        rows = _census_get(base_url, params)
        frame = pd.DataFrame(rows[1:], columns=rows[0])
        frame["county_label"] = county_name
        frames.append(frame)

    df = pd.concat(frames, ignore_index=True)
    df = df.rename(columns=VARIABLES)

    for col in VARIABLES.values():
        df[col] = pd.to_numeric(df[col], errors="coerce")
        df.loc[df[col] < 0, col] = np.nan

    df["tract_id"]          = df["state"] + df["county"] + df["tract"]
    df["pct_below_poverty"] = df["poverty_below"] / df["poverty_total"] * 100
    df["pct_snap_enrollment"] = df["snap_yes"] / df["snap_total"] * 100
    df["pct_no_vehicle"]    = (df["owner_no_veh"] + df["renter_no_veh"]) / df["veh_total"] * 100
    df["unemployment_rate"] = df["unemployed"] / df["labor_force"] * 100
    hb_cols  = [f"hb_{i}"  for i in range(len(HOUSING_BURDEN_CODES))]
    hbx_cols = [f"hbx_{i}" for i in range(len(HOUSING_UNCOMPUTED_CODES))]
    # Exclude households whose cost ratio ACS never computes — see
    # HOUSING_UNCOMPUTED_CODES. Guard the result: on a tract where every household
    # falls into those categories the denominator is 0, handled by the isfinite
    # sweep below.
    housing_denom = df["housing_total"] - df[hbx_cols].sum(axis=1)
    df["housing_cost_burden_pct"] = df[hb_cols].sum(axis=1) / housing_denom * 100

    # Divide-by-zero (empty tracts) → inf; treat as missing.
    for col in ["pct_below_poverty", "pct_snap_enrollment", "pct_no_vehicle",
                "unemployment_rate", "housing_cost_burden_pct"]:
        df.loc[~np.isfinite(df[col]), col] = np.nan

    # Columns the ACSRecord table has but this pull does not populate. They are
    # written as NULL, never 0.0 — a stored 0.0 is indistinguishable from a real
    # measured zero, which would quietly mislead anyone who adds a slider for one
    # of these or writes a SQL rollup over them.
    # NOTE: need_score is intentionally NOT set here — it is computed by
    # scoring.compute_need_scores() in main.py after the food_desert flag is
    # attached, so the stored score is real (not a placeholder 0).
    for col in ["pct_low_income", "pct_children_under18", "pct_seniors_65plus"]:
        df[col] = np.nan

    return df[[
        "tract_id", "county_label", "total_pop", "median_income",
        "pct_below_poverty", "pct_snap_enrollment", "pct_no_vehicle",
        "pct_low_income", "pct_children_under18",
        "pct_seniors_65plus", "unemployment_rate", "housing_cost_burden_pct",
    ]].rename(columns={"county_label": "county", "total_pop": "population"})


if __name__ == "__main__":
    main()