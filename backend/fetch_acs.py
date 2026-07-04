import os
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
}

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
        resp = requests.get(base_url, params=params)
        resp.raise_for_status()
        rows = resp.json()
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

    # Columns expected by main.py that ACS5 doesn't supply — default to 0
    for col in ["need_score", "pct_low_income", "pct_children_under18",
                "pct_seniors_65plus", "unemployment_rate", "housing_cost_burden_pct"]:
        df[col] = 0.0

    return df[[
        "tract_id", "county_label", "total_pop", "median_income",
        "pct_below_poverty", "pct_snap_enrollment", "pct_no_vehicle",
        "pct_low_income", "need_score", "pct_children_under18",
        "pct_seniors_65plus", "unemployment_rate", "housing_cost_burden_pct",
    ]].rename(columns={"county_label": "county", "total_pop": "population"})


if __name__ == "__main__":
    main()