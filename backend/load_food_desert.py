"""One-time: populate ACSRecord.food_desert in Supabase from the USDA 2019
Food Access Research Atlas, mapped 2010→2020 tracts via the Census crosswalk.

The USDA LILA flag is a static per-tract attribute, so every ACS year/batch
gets the same flag for a given GEOID.
"""
import os
import pandas as pd
from dotenv import load_dotenv
from sqlalchemy import create_engine, text, bindparam

load_dotenv()
DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL or DATABASE_URL.startswith("sqlite"):
    raise SystemExit("DATABASE_URL must point to Supabase")

# ── 1. USDA food-access flags (keyed by 2010 tract IDs) ────────────────────────
print("Reading USDA atlas...")
usda = pd.read_excel(
    "geo/FoodAccessResearchAtlasData2019.xlsx",
    sheet_name="Food Access Research Atlas",
    usecols=["CensusTract", "LILATracts_1And10"],
)
usda["GEOID_2010"] = usda["CensusTract"].astype(str).str.zfill(11)
usda = usda.rename(columns={"LILATracts_1And10": "food_desert"})[["GEOID_2010", "food_desert"]]

# ── 2. 2020↔2010 crosswalk; pick the dominant (most land) 2010 source ──────────
print("Reading crosswalk...")
xw = pd.read_csv("geo/tab20_tract20_tract10_st12.txt", sep="|", dtype=str)
xw = xw[["GEOID_TRACT_20", "GEOID_TRACT_10", "AREALAND_PART"]].copy()
xw["AREALAND_PART"] = pd.to_numeric(xw["AREALAND_PART"], errors="coerce").fillna(0)
xw = xw.sort_values("AREALAND_PART", ascending=False)
dominant = xw.drop_duplicates(subset="GEOID_TRACT_20", keep="first")

# ── 3. Attach flag to each 2020 tract ──────────────────────────────────────────
dominant = dominant.merge(usda, left_on="GEOID_TRACT_10", right_on="GEOID_2010", how="left")
flag_by_2020 = dominant[["GEOID_TRACT_20", "food_desert"]].dropna()

# GEOID -> 0/1  (coerce to int; skip NaN)
flag_map = {
    str(row.GEOID_TRACT_20).zfill(11): int(row.food_desert)
    for row in flag_by_2020.itertuples()
}
n_deserts = sum(1 for v in flag_map.values() if v == 1)
print(f"Built flag map: {len(flag_map)} tracts, {n_deserts} flagged as food deserts")

# ── 4. Update Supabase in one pass per distinct value ──────────────────────────
engine = create_engine(DATABASE_URL, pool_pre_ping=True)
desert_ids = [g for g, v in flag_map.items() if v == 1]

with engine.begin() as conn:
    # Reset all to 0, then flag the deserts.
    conn.execute(text("UPDATE acs_records SET food_desert = 0"))
    if desert_ids:
        # chunk to keep the IN() list reasonable
        chunk = 1000
        stmt = text("UPDATE acs_records SET food_desert = 1 WHERE tract_id IN :ids") \
            .bindparams(bindparam("ids", expanding=True))
        for i in range(0, len(desert_ids), chunk):
            conn.execute(stmt, {"ids": desert_ids[i:i + chunk]})

# ── 5. Verify ──────────────────────────────────────────────────────────────────
with engine.connect() as conn:
    total = conn.execute(text("SELECT COUNT(*) FROM acs_records")).scalar()
    flagged = conn.execute(text("SELECT COUNT(*) FROM acs_records WHERE food_desert = 1")).scalar()
print(f"Done. {flagged}/{total} ACS records now flagged as food desert.")
