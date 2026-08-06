"""
compute_index.py — OFFLINE / LEGACY. Not used at runtime.

Part of the one-time pipeline that builds the tract GeoJSON:
    fetch_acs.py → acs_raw.csv → compute_index.py → acs_with_index.csv
                 → build_geojson.py → tracts_2022.geojson

The need_score and *_norm columns it computes are a STATIC FALLBACK only. They
get baked into the GeoJSON, but HealthMap.jsx calls normalizeTracts() on every
load and overwrites all of them with scores recomputed from live API data across
all 7 indicators. Nothing reads the baked values.

Its 4-indicator weighting below is therefore historical and intentionally does
NOT match the live weighting in scoring.py / HealthMap.jsx. The authoritative
need-score definition is scoring.NEED_INDICATORS.

Run from backend/ only when regenerating the tract geometry.
"""

import pandas as pd

import food_desert


def main() -> None:
    # Read the clean raw data produced by fetch_acs.py
    df = pd.read_csv("acs_raw.csv")

    # Attach the committed USDA food-desert flag (GEOID → 0/1). build_geojson.py
    # bakes this column into the tract GeoJSON, so it has to be joined on here.
    # It is deliberately NOT added to INDICATORS below — see the module docstring.
    df["GEOID"] = df["GEOID"].astype(str).str.zfill(11)
    df["food_desert"] = df["GEOID"].map(food_desert.load_flags())

    # Binary flag, so its percentile-rank normalization is just the flag itself —
    # the same value HealthMap.jsx derives client-side for food_desert_norm.
    df["food_desert_norm"] = df["food_desert"]

    # --- Filter out non-residential / institutional tracts ---
    # Census tracts numbered 9800-9999 are special-purpose (parks, airports,
    # water, prisons) with little or no household population. Drop very-low-pop
    # tracts too — they produce unstable rates and aren't siting candidates.
    # Same thresholds as scoring.eligible_tract_mask() and isEligibleTract()
    # in HealthMap.jsx.
    df["tract_code"] = df["GEOID"].astype(str).str[-6:]
    df = df[df["tract_code"].astype(int) < 980000]
    df = df[df["total_pop"] >= 100]

    # --- Normalize each indicator to a 0-1 percentile rank across all tracts ---
    # rank(pct=True) handles NaNs by leaving them NaN (tract simply doesn't score
    # on that indicator). ascending=False inverts income so low income = high need.
    for col, cfg in INDICATORS.items():
        ascending = not cfg["invert"]  # invert -> rank descending
        df[col + "_norm"] = df[col].rank(pct=True, ascending=ascending)

    # --- Weighted sum -> need_score on 0-100 ---
    # Compute as a weighted average over the indicators that ARE present for each
    # tract, so a missing indicator doesn't unfairly drag the score to zero.
    norm_cols = [c + "_norm" for c in INDICATORS]
    weights = pd.Series({c + "_norm": INDICATORS[c]["weight"] for c in INDICATORS})

    weighted = df[norm_cols].mul(weights, axis=1).sum(axis=1)
    present_weight = df[norm_cols].notna().mul(weights, axis=1).sum(axis=1)
    df["need_score"] = (weighted / present_weight) * 100

    # Require at least 3 of the 4 indicators present, or the score isn't trustworthy.
    present_count = df[norm_cols].notna().sum(axis=1)
    df.loc[present_count < 3, "need_score"] = pd.NA

    # --- Inspect the result ---
    print("need_score summary:")
    print(df["need_score"].describe().round(1))

    print("\nTop 10 highest-need tracts:")
    cols = ["GEOID", "county_name", "poverty_rate", "snap_rate",
            "no_vehicle_rate", "median_income", "need_score"]
    print(df.sort_values("need_score", ascending=False)[cols].head(10).round(1).to_string(index=False))

    print("\nLowest 5 (least need) — sanity check these look affluent:")
    print(df.sort_values("need_score")[cols].head(5).round(1).to_string(index=False))

    df.to_csv("acs_with_index.csv", index=False)
    print("\nSaved to acs_with_index.csv")


# Indicator -> weight. Weights sum to 1.0.
# 'invert=True' means HIGH values mean LESS need (only median_income).
INDICATORS = {
    "poverty_rate":     {"weight": 0.40, "invert": False},
    "snap_rate":        {"weight": 0.20, "invert": False},
    "no_vehicle_rate":  {"weight": 0.20, "invert": False},
    "median_income":    {"weight": 0.20, "invert": True},
}


if __name__ == "__main__":
    main()