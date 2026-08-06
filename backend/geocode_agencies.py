"""
Geocodes agencies.csv using the Census Geocoder (free, no key).

  input : frontend/public/agencies.csv       (Agency Name, Address, Type)
  output: frontend/public/agencies.geojson   (Point features, served to the map)
          backend/agencies_ungeocoded.json   (rows that could not be placed —
                                              a dev artifact, not served)

Why a benchmark chain
─────────────────────
The Census geocoder exposes several reference datasets ("benchmarks") and they do
NOT contain the same addresses. Public_AR_Current is the default and covers most
of them, but a meaningful minority only resolve against Public_AR_Census2020 —
6 of this file's 12 original failures matched there with the exact same address
text. So each address is tried against every benchmark in order before it is
declared a failure.

Failures matter: an agency missing from agencies.geojson is invisible to the
coverage-gap analysis in HealthMap.jsx, which then reports tracts near that
agency as uncovered. That is a false gap, so unplaced rows are written to
agencies_ungeocoded.json rather than only printed — they are a data-quality
backlog to fix in the CSV, not noise to scroll past.

Coordinates are never guessed. A row that matches no benchmark is left out of the
GeoJSON entirely; approximating it (e.g. to a ZIP centroid) would silently invent
an agency location and quietly close a real gap on the map.
"""

import csv
import json
import time
from pathlib import Path

import requests

ROOT = Path(__file__).parent.parent
INPUT = ROOT / "frontend/public/agencies.csv"
OUTPUT = ROOT / "frontend/public/agencies.geojson"
FAILURES = Path(__file__).parent / "agencies_ungeocoded.json"

GEOCODE_URL = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress"

# Tried in order; first match wins. Current is the default/most complete, but
# Census2020 resolves a number of addresses that Current does not.
BENCHMARKS = [
    "Public_AR_Current",
    "Public_AR_Census2020",
    "Public_AR_ACS2025",
    "Public_AR_LUCA",
]

REQUEST_TIMEOUT = 15
THROTTLE_SECONDS = 0.3  # be polite to the Census API


def geocode(address: str) -> dict | None:
    """First match across BENCHMARKS, or None. Returns lat/lng plus provenance."""
    for benchmark in BENCHMARKS:
        try:
            r = requests.get(
                GEOCODE_URL,
                params={"address": address, "benchmark": benchmark, "format": "json"},
                timeout=REQUEST_TIMEOUT,
            )
            r.raise_for_status()
            matches = r.json()["result"]["addressMatches"]
        except Exception as e:  # network, JSON, or schema problem — try the next one
            print(f"    [{benchmark}] error: {e}")
            continue
        finally:
            time.sleep(THROTTLE_SECONDS)

        if matches:
            c = matches[0]["coordinates"]
            return {
                "lat": c["y"],
                "lng": c["x"],
                "benchmark": benchmark,
                "matched_address": matches[0]["matchedAddress"],
            }
    return None


def zip_of(text: str) -> str:
    """Trailing 5-digit ZIP, or "" — used only to flag suspicious matches."""
    tail = text.strip().replace(",", " ").split()
    return tail[-1] if tail and tail[-1].isdigit() and len(tail[-1]) == 5 else ""


def main() -> None:
    with open(INPUT, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))

    print(f"Geocoding {len(rows)} agencies across {len(BENCHMARKS)} benchmarks...")

    features, failed, drifted = [], [], []

    for i, row in enumerate(rows, start=1):
        name = row["Agency Name"].strip()
        address = row["Address"].strip()
        agency_type = row["Type"].strip()

        print(f"[{i}/{len(rows)}] {name}")
        hit = geocode(address)

        if not hit:
            print(f"    FAILED: {address}")
            failed.append({"name": name, "address": address, "type": agency_type})
            continue

        # A match whose ZIP differs from the input usually means the CSV ZIP is
        # wrong (often harmless, the geocoder corrected it) but occasionally means
        # it matched the wrong place. Surfaced for review, not auto-rejected.
        want, got = zip_of(address), zip_of(hit["matched_address"])
        if want and got and want != got:
            drifted.append({"name": name, "input": address, "matched": hit["matched_address"]})

        if hit["benchmark"] != BENCHMARKS[0]:
            print(f"    matched via {hit['benchmark']}: {hit['matched_address']}")

        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [hit["lng"], hit["lat"]]},
            "properties": {
                "name": name,
                "address": address,
                "type": agency_type,
                "geocode_benchmark": hit["benchmark"],
                "matched_address": hit["matched_address"],
            },
        })

    OUTPUT.write_text(json.dumps({"type": "FeatureCollection", "features": features}, indent=2))
    FAILURES.write_text(json.dumps(failed, indent=2))

    print(f"\nWrote {len(features)}/{len(rows)} features to {OUTPUT.name}")

    by_benchmark: dict[str, int] = {}
    for f in features:
        b = f["properties"]["geocode_benchmark"]
        by_benchmark[b] = by_benchmark.get(b, 0) + 1
    for b, n in by_benchmark.items():
        print(f"  {n:>4} via {b}")

    if drifted:
        print(f"\n{len(drifted)} matched to a different ZIP than the CSV — worth a look:")
        for d in drifted:
            print(f"  - {d['name']}\n      csv: {d['input']}\n      got: {d['matched']}")

    if failed:
        print(f"\n{len(failed)} could NOT be geocoded (recorded in {FAILURES.name}).")
        print("These are invisible to coverage-gap analysis and will show as false gaps:")
        for f in failed:
            print(f"  - {f['name']}: {f['address']}")
    else:
        print("\nAll agencies geocoded.")


if __name__ == "__main__":
    main()
