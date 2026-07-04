import pandas as pd

# ---------------------------------------------------------------------------
# 1. Load USDA food-access flags (2010 tract IDs)
# ---------------------------------------------------------------------------
usda = pd.read_excel(
    "geo/FoodAccessResearchAtlasData2019.xlsx",
    sheet_name="Food Access Research Atlas",
    usecols=["CensusTract", "LILATracts_1And10"],
)
# CensusTract is numeric and lost leading zeros -> pad to 11-char string
usda["GEOID_2010"] = usda["CensusTract"].astype(str).str.zfill(11)
usda = usda.rename(columns={"LILATracts_1And10": "food_desert"})
usda = usda[["GEOID_2010", "food_desert"]]

# ---------------------------------------------------------------------------
# 2. Load the 2020<->2010 tract crosswalk (pipe-delimited)
# ---------------------------------------------------------------------------
xw = pd.read_csv(
    "geo/tab20_tract20_tract10_st12.txt",
    sep="|",
    dtype=str,
)
# Keep the keys and the land-overlap amount
xw = xw[["GEOID_TRACT_20", "GEOID_TRACT_10", "AREALAND_PART"]].copy()
xw["AREALAND_PART"] = pd.to_numeric(xw["AREALAND_PART"], errors="coerce").fillna(0)

# ---------------------------------------------------------------------------
# 3. For each 2020 tract, pick the 2010 tract that contributes the MOST land.
#    This handles splits (child inherits parent) and merges (takes dominant
#    source) correctly, and avoids tiny boundary slivers wrongly transferring
#    a flag.
# ---------------------------------------------------------------------------
xw = xw.sort_values("AREALAND_PART", ascending=False)
dominant = xw.drop_duplicates(subset="GEOID_TRACT_20", keep="first")

# ---------------------------------------------------------------------------
# 4. Attach the dominant 2010 source's food-desert flag to each 2020 tract
# ---------------------------------------------------------------------------
dominant = dominant.merge(
    usda, left_on="GEOID_TRACT_10", right_on="GEOID_2010", how="left"
)
# Map: 2020 GEOID -> food_desert flag
flag_by_2020 = dominant[["GEOID_TRACT_20", "food_desert"]].rename(
    columns={"GEOID_TRACT_20": "GEOID"}
)

# ---------------------------------------------------------------------------
# 5. Join onto our scored ACS data (2020 tracts)
# ---------------------------------------------------------------------------
scores = pd.read_csv("acs_raw.csv")
scores["GEOID"] = scores["GEOID"].astype(str).str.zfill(11)
flag_by_2020["GEOID"] = flag_by_2020["GEOID"].astype(str).str.zfill(11)

# Drop any old food_desert column before re-adding (so re-runs are clean)
scores = scores.drop(columns=[c for c in ["food_desert"] if c in scores.columns])

merged = scores.merge(flag_by_2020, on="GEOID", how="left")

# ---------------------------------------------------------------------------
# 6. Report
# ---------------------------------------------------------------------------
matched = merged["food_desert"].notna().sum()
print(f"Tracts: {len(merged)}")
print(f"Matched a USDA flag (via crosswalk): {matched}")
print(f"Unmatched: {merged['food_desert'].isna().sum()}")
print(f"Flagged as food desert: {(merged['food_desert'] == 1).sum()}")

merged.to_csv("acs_raw.csv", index=False)
print("\nSaved (food_desert via crosswalk) to acs_raw.csv")