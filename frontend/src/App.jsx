import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

const DEFAULT_WEIGHTS = {
  poverty_rate: 30,
  snap_rate: 20,
  no_vehicle_rate: 15,
  median_income: 15,
  food_desert: 20,
};

const LABELS = {
  poverty_rate: "Poverty rate",
  snap_rate: "SNAP enrollment",
  no_vehicle_rate: "No vehicle access",
  median_income: "Low income",
  food_desert: "Food desert",
};

// Haversine distance in miles between two lat/lng points
function distanceMiles(lat1, lng1, lat2, lng2) {
  const R = 3958.8;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

// Average of outer ring coordinates
function polyCentroid(feature) {
  const geom = feature.geometry;
  const ring =
    geom.type === "Polygon"
      ? geom.coordinates[0]
      : geom.coordinates[0][0];
  let sumLng = 0, sumLat = 0;
  ring.forEach(([lng, lat]) => { sumLng += lng; sumLat += lat; });
  return [sumLng / ring.length, sumLat / ring.length];
}

// Approximate circle polygon for a point at (lng, lat) with radius in miles
function makeCircle(lng, lat, radiusMiles, steps = 48) {
  const R = 3958.8;
  const coords = [];
  for (let i = 0; i <= steps; i++) {
    const bearing = (i / steps) * 2 * Math.PI;
    const dLat = ((radiusMiles / R) * 180) / Math.PI * Math.cos(bearing);
    const dLng =
      (((radiusMiles / R) * 180) / Math.PI / Math.cos((lat * Math.PI) / 180)) *
      Math.sin(bearing);
    coords.push([lng + dLng, lat + dLat]);
  }
  return { type: "Polygon", coordinates: [coords] };
}

function scoreColor(score) {
  if (score >= 80) return "#2d1160";
  if (score >= 60) return "#440154";
  if (score >= 40) return "#3b528b";
  if (score >= 20) return "#21918c";
  return "#5ec962";
}

export default function App() {
  const mapContainer = useRef(null);
  const map = useRef(null);
  const fullBounds = useRef(null);
  const geojsonData = useRef(null);
  const agenciesData = useRef(null);
  const tractCentroids = useRef({});

  const [selected, setSelected] = useState(null);
  const [breaks, setBreaks] = useState(null);
  const [weights, setWeights] = useState(DEFAULT_WEIGHTS);
  const [showSettings, setShowSettings] = useState(false);
  const [radius, setRadius] = useState(2);
  const [gapTracts, setGapTracts] = useState([]);

  // Recompute coverage and gap list — called whenever radius or weights change
  function recomputeGap(geojson, agencies, w, r) {
    if (!geojson || !agencies || !map.current) return;

    const agencyPoints = agencies.features.map((f) => ({
      lng: f.geometry.coordinates[0],
      lat: f.geometry.coordinates[1],
    }));

    const gaps = [];
    geojson.features.forEach((f) => {
      const props = f.properties;
      const score = computeScore(props, w);
      if (score === null) return;

      if (!tractCentroids.current[props.GEOID]) {
        tractCentroids.current[props.GEOID] = polyCentroid(f);
      }
      const [lng, lat] = tractCentroids.current[props.GEOID];

      const covered = agencyPoints.some(
        (a) => distanceMiles(lat, lng, a.lat, a.lng) <= r
      );

      map.current.setFeatureState(
        { source: "tracts", id: props.GEOID },
        { covered }
      );

      if (!covered) gaps.push({ ...props, _score: score });
    });

    gaps.sort((a, b) => b._score - a._score);
    setGapTracts(gaps);

    // Redraw coverage circles
    const coverageSource = map.current.getSource("coverage");
    if (coverageSource) {
      coverageSource.setData({
        type: "FeatureCollection",
        features: agencies.features.map((f) => ({
          type: "Feature",
          geometry: makeCircle(
            f.geometry.coordinates[0],
            f.geometry.coordinates[1],
            r
          ),
          properties: {},
        })),
      });
    }
  }

  useEffect(() => {
    if (map.current) return;

    map.current = new maplibregl.Map({
      container: mapContainer.current,
      style: {
        version: 8,
        sources: {
          osm: {
            type: "raster",
            tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
            tileSize: 256,
            attribution: "© OpenStreetMap contributors",
          },
        },
        layers: [{ id: "osm", type: "raster", source: "osm" }],
      },
      center: [-80.3, 26.3],
      zoom: 8,
      minZoom: 6,
      dragRotate: false,
      maxPitch: 0,
    });

    map.current.on("load", async () => {
      const [tractsResp, agenciesResp] = await Promise.all([
        fetch("/tracts_2022.geojson"),
        fetch("/agencies.geojson"),
      ]);
      const geojson = await tractsResp.json();
      const agencies = await agenciesResp.json();
      geojsonData.current = geojson;
      agenciesData.current = agencies;

      map.current.addSource("tracts", {
        type: "geojson",
        data: geojson,
        promoteId: "GEOID",
      });
      map.current.addSource("coverage", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.current.addSource("agencies", {
        type: "geojson",
        data: agencies,
      });

      // Fit to tract bounds
      const b = new maplibregl.LngLatBounds();
      geojson.features.forEach((f) => {
        const geom = f.geometry;
        if (!geom) return;
        const polys =
          geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
        polys.forEach((poly) =>
          poly.forEach((ring) => ring.forEach((c) => b.extend(c)))
        );
      });
      map.current.fitBounds(b, { padding: 60, duration: 0 });
      fullBounds.current = b;
      const sw = b.getSouthWest();
      const ne = b.getNorthEast();
      map.current.setMaxBounds([
        [sw.lng - 2, sw.lat - 2],
        [ne.lng + 2, ne.lat + 2],
      ]);

      // Coverage circles — drawn under tract fill
      map.current.addLayer({
        id: "coverage-fill",
        type: "fill",
        source: "coverage",
        paint: { "fill-color": "#3b82f6", "fill-opacity": 0.18 },
      });
      map.current.addLayer({
        id: "coverage-outline",
        type: "line",
        source: "coverage",
        paint: { "line-color": "#1d4ed8", "line-width": 1.5, "line-opacity": 0.7 },
      });

      // Tract choropleth — covered tracts dim to 0.2 opacity
      map.current.addLayer({
        id: "tracts-fill",
        type: "fill",
        source: "tracts",
        paint: {
          "fill-color": [
            "step",
            ["coalesce", ["feature-state", "computed_score"], -1],
            "#cccccc",
            0,  "#5ec962",
            20, "#21918c",
            40, "#3b528b",
            60, "#440154",
            80, "#2d1160",
          ],
          "fill-opacity": 0.72,
        },
      });
      map.current.addLayer({
        id: "tracts-outline",
        type: "line",
        source: "tracts",
        paint: { "line-color": "#ffffff", "line-width": 0.3 },
      });
      map.current.addLayer({
        id: "tracts-selected",
        type: "line",
        source: "tracts",
        paint: { "line-color": "#000000", "line-width": 2.5 },
        filter: ["==", "GEOID", ""],
      });

      // Agency markers on top
      map.current.addLayer({
        id: "agencies-points",
        type: "circle",
        source: "agencies",
        paint: {
          "circle-radius": 5,
          "circle-color": "#ffffff",
          "circle-stroke-color": "#1A3A6E",
          "circle-stroke-width": 2,
        },
      });

      map.current.on("click", "tracts-fill", (e) => {
        const feature = e.features[0];
        const props = feature.properties;
        setSelected(props);
        map.current.setFilter("tracts-selected", ["==", "GEOID", props.GEOID]);
        const bounds = new maplibregl.LngLatBounds();
        const geom = feature.geometry;
        const rings =
          geom.type === "Polygon" ? geom.coordinates : geom.coordinates.flat();
        rings.forEach((ring) => ring.forEach((coord) => bounds.extend(coord)));
        map.current.fitBounds(bounds, {
          padding: { top: 80, bottom: 80, left: 80, right: 360 },
          maxZoom: 13,
          duration: 800,
        });
      });

      map.current.on("mouseenter", "tracts-fill", () => {
        map.current.getCanvas().style.cursor = "pointer";
      });
      map.current.on("mouseleave", "tracts-fill", () => {
        map.current.getCanvas().style.cursor = "";
      });

      applyWeights(DEFAULT_WEIGHTS, geojson);
      recomputeGap(geojson, agencies, DEFAULT_WEIGHTS, 2);
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function applyWeights(w, geojson) {
    const data = geojson || geojsonData.current;
    if (!map.current || !map.current.getLayer("tracts-fill") || !data) return;

    const validScores = [];
    data.features.forEach((f) => {
      const p = f.properties;
      const score = computeScore(p, w);
      map.current.setFeatureState(
        { source: "tracts", id: p.GEOID },
        { computed_score: score }
      );
      if (score !== null) validScores.push(score);
    });

    const q = jenksBreaks(validScores, 5);
    setBreaks(q);

    map.current.setPaintProperty("tracts-fill", "fill-color", [
      "step",
      ["coalesce", ["feature-state", "computed_score"], -1],
      "#cccccc",
      0,    "#5ec962",
      q[0], "#21918c",
      q[1], "#3b528b",
      q[2], "#440154",
      q[3], "#2d1160",
    ]);
  }

  function flyToTract(geoid) {
    if (!map.current || !geojsonData.current) return;
    const feature = geojsonData.current.features.find(
      (f) => f.properties.GEOID === geoid
    );
    if (!feature) return;
    setSelected(feature.properties);
    map.current.setFilter("tracts-selected", ["==", "GEOID", geoid]);
    const bounds = new maplibregl.LngLatBounds();
    const geom = feature.geometry;
    const rings =
      geom.type === "Polygon" ? geom.coordinates : geom.coordinates.flat();
    rings.forEach((ring) => ring.forEach((coord) => bounds.extend(coord)));
    map.current.fitBounds(bounds, {
      padding: { top: 80, bottom: 80, left: 80, right: 360 },
      maxZoom: 13,
      duration: 800,
    });
  }

  const fmt = (v, suffix = "") =>
    v === null || v === undefined || v === "" ? "—" : `${Number(v).toFixed(1)}${suffix}`;

  return (
    <div style={{ display: "flex", height: "100vh", overflow: "hidden", fontFamily: "system-ui, sans-serif" }}>

      {/* ── Left: Gap list ── */}
      <div style={{
        width: 300, flexShrink: 0,
        display: "flex", flexDirection: "column",
        background: "#f8f9fa", borderRight: "1px solid #e0e0e0",
      }}>
        <div style={{ padding: "16px 16px 12px", borderBottom: "1px solid #e0e0e0" }}>
          <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 2 }}>
            Coverage gaps
          </div>
          <div style={{ fontSize: 12, color: "#666", marginBottom: 12 }}>
            {gapTracts.length} tracts without a nearby partner
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 12, color: "#555", whiteSpace: "nowrap" }}>Radius</span>
            <input
              type="range" min="0.5" max="5" step="0.5" value={radius}
              onChange={(e) => {
                const r = Number(e.target.value);
                setRadius(r);
                recomputeGap(geojsonData.current, agenciesData.current, weights, r);
              }}
              style={{ flex: 1 }}
            />
            <span style={{ fontSize: 12, fontWeight: 600, minWidth: 36, textAlign: "right" }}>
              {radius} mi
            </span>
          </div>
        </div>

        <div style={{ flex: 1, overflowY: "auto" }}>
          {gapTracts.length === 0 ? (
            <div style={{ padding: 16, color: "#999", fontSize: 13 }}>Loading…</div>
          ) : (
            gapTracts.map((tract, i) => (
              <button
                key={tract.GEOID}
                onClick={() => flyToTract(tract.GEOID)}
                style={{
                  display: "flex", alignItems: "center",
                  width: "100%", padding: "10px 16px",
                  border: "none", borderBottom: "1px solid #ebebeb",
                  background: selected?.GEOID === tract.GEOID ? "#e8eef8" : "transparent",
                  cursor: "pointer", textAlign: "left", gap: 10,
                }}
              >
                <span style={{ fontSize: 11, color: "#aaa", minWidth: 22 }}>#{i + 1}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>
                    {tract.county_name} County
                  </div>
                  <div style={{ fontSize: 11, color: "#888", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    Tract {tract.GEOID}
                  </div>
                </div>
                <div style={{ fontSize: 13, fontWeight: 700, color: scoreColor(tract._score), minWidth: 30, textAlign: "right" }}>
                  {Math.round(tract._score)}
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      {/* ── Right: Map ── */}
      <div style={{ flex: 1, position: "relative" }}>
        <div ref={mapContainer} style={{ position: "absolute", inset: 0 }} />

        {/* Zoom controls */}
        <div style={{ position: "absolute", top: 60, left: 16, display: "flex", flexDirection: "column", gap: 2, zIndex: 10 }}>
          {["+", "−"].map((label, i) => (
            <button
              key={label}
              onClick={() => i === 0 ? map.current.zoomIn() : map.current.zoomOut()}
              style={{
                width: 30, height: 30, fontSize: 18, lineHeight: 1,
                background: "#fff", border: "none",
                borderRadius: i === 0 ? "6px 6px 0 0" : "0 0 6px 6px",
                boxShadow: "0 1px 4px rgba(0,0,0,0.2)", cursor: "pointer",
              }}
            >{label}</button>
          ))}
        </div>

        {/* Legend */}
        <div style={{
          position: "absolute", bottom: 24, left: 24,
          background: "rgba(255,255,255,0.95)", padding: "12px 16px",
          borderRadius: 8, boxShadow: "0 1px 4px rgba(0,0,0,0.2)", fontSize: 12,
        }}>
          <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 13 }}>Need score</div>
          {breaks === null ? (
            <div style={{ color: "#aaa" }}>Loading…</div>
          ) : [
            ["#2d1160", "Highest need", `${Math.round(breaks[3])}–100`],
            ["#440154", "Very high",   `${Math.round(breaks[2])}–${Math.round(breaks[3])}`],
            ["#3b528b", "High",        `${Math.round(breaks[1])}–${Math.round(breaks[2])}`],
            ["#21918c", "Moderate",    `${Math.round(breaks[0])}–${Math.round(breaks[1])}`],
            ["#5ec962", "Low need",    `0–${Math.round(breaks[0])}`],
          ].map(([color, label, range]) => (
            <div key={label} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
              <div style={{ width: 16, height: 16, background: color, borderRadius: 3, flexShrink: 0 }} />
              <span style={{ flex: 1 }}>{label}</span>
              <span style={{ color: "#999" }}>{range}</span>
            </div>
          ))}
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8 }}>
            <div style={{ width: 14, height: 14, background: "#cccccc", borderRadius: 2 }} />
            <span style={{ color: "#666" }}>No data</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
            <div style={{
              width: 14, height: 14, borderRadius: 2,
              background: "rgba(59,130,246,0.18)", border: "1.5px solid #1d4ed8",
            }} />
            <span style={{ color: "#666" }}>Partner radius</span>
          </div>
        </div>

        {/* Toolbar */}
        <button
          onClick={() => {
            if (fullBounds.current)
              map.current.fitBounds(fullBounds.current, { padding: 60, duration: 800 });
            setSelected(null);
            map.current.setFilter("tracts-selected", ["==", "GEOID", ""]);
          }}
          style={{
            position: "absolute", top: 16, left: 16,
            background: "#fff", border: "none", borderRadius: 8,
            padding: "8px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer",
            boxShadow: "0 1px 4px rgba(0,0,0,0.2)",
          }}
        >↺ Reset view</button>

        <button
          onClick={() => setShowSettings(true)}
          style={{
            position: "absolute", top: 16, left: 130,
            background: "#fff", border: "none", borderRadius: 8,
            padding: "8px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer",
            boxShadow: "0 1px 4px rgba(0,0,0,0.2)",
          }}
        >⚙ Weights</button>

        {/* Stats panel */}
        {selected && (
          <div style={{
            position: "absolute", top: 0, right: 0, bottom: 0, width: 320,
            background: "#fff", boxShadow: "-2px 0 8px rgba(0,0,0,0.15)",
            padding: "20px 24px", overflowY: "auto",
          }}>
            <button
              onClick={() => {
                setSelected(null);
                map.current.setFilter("tracts-selected", ["==", "GEOID", ""]);
              }}
              style={{ float: "right", border: "none", background: "none", fontSize: 20, cursor: "pointer" }}
            >×</button>
            <h2 style={{ margin: "0 0 4px", fontSize: 18 }}>
              Need score: {fmt(computeScore(selected, weights))}
            </h2>
            <p style={{ margin: "0 0 20px", color: "#666", fontSize: 13 }}>
              {selected.county_name} County · Tract {selected.GEOID}
            </p>
            <Stat label="Population"    value={fmt(selected.total_pop)}            note="ACS 2022" />
            <Stat label="Below poverty" value={fmt(selected.poverty_rate, "%")}    note="vs ~13% nationally" />
            <Stat label="Receiving SNAP" value={fmt(selected.snap_rate, "%")}      note="of households" />
            <Stat label="No vehicle"    value={fmt(selected.no_vehicle_rate, "%")} note="of households" />
            <Stat
              label="Food desert"
              value={
                selected.food_desert === 1 || selected.food_desert === "1" ? "Yes"
                : selected.food_desert === 0 || selected.food_desert === "0" ? "No"
                : "—"
              }
              note="USDA low-income/low-access (2019)"
            />
            <Stat
              label="Median income"
              value={selected.median_income ? `$${Math.round(selected.median_income).toLocaleString()}` : "—"}
              note="household, per year"
            />
          </div>
        )}

        {/* Weight sliders modal */}
        {showSettings && (
          <div style={{
            position: "absolute", inset: 0, background: "rgba(0,0,0,0.35)",
            display: "flex", alignItems: "center", justifyContent: "center", zIndex: 20,
          }}>
            <div style={{
              background: "#fff", borderRadius: 12, padding: 28, width: 420,
              boxShadow: "0 4px 24px rgba(0,0,0,0.3)",
            }}>
              <h2 style={{ margin: "0 0 4px", fontSize: 18 }}>Adjust indicator weights</h2>
              <p style={{ margin: "0 0 20px", color: "#666", fontSize: 13 }}>
                Weights always total 100. Moving one rebalances the others.
              </p>
              {Object.keys(weights).map((k) => (
                <div key={k} style={{ marginBottom: 16 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, marginBottom: 4 }}>
                    <span>{LABELS[k]}</span>
                    <span style={{ fontWeight: 600 }}>{Math.round(weights[k])}</span>
                  </div>
                  <input
                    type="range" min="0" max="100" value={weights[k]}
                    onChange={(e) => {
                      const newVal = Number(e.target.value);
                      const others = Object.keys(weights).filter((x) => x !== k);
                      const remaining = 100 - newVal;
                      const oldOthersTotal = others.reduce((s, x) => s + weights[x], 0);
                      const next = {};
                      Object.keys(weights).forEach((x) => {
                        next[x] = x === k
                          ? newVal
                          : oldOthersTotal > 0
                            ? (weights[x] / oldOthersTotal) * remaining
                            : remaining / others.length;
                      });
                      setWeights(next);
                      applyWeights(next);
                      recomputeGap(geojsonData.current, agenciesData.current, next, radius);
                    }}
                    style={{ width: "100%" }}
                  />
                </div>
              ))}
              <div style={{ display: "flex", gap: 10, marginTop: 24 }}>
                <button
                  onClick={() => {
                    setWeights(DEFAULT_WEIGHTS);
                    applyWeights(DEFAULT_WEIGHTS);
                    recomputeGap(geojsonData.current, agenciesData.current, DEFAULT_WEIGHTS, radius);
                  }}
                  style={{
                    flex: 1, padding: "10px", borderRadius: 8,
                    border: "1px solid #ccc", background: "#fff", cursor: "pointer", fontSize: 14,
                  }}
                >Reset to defaults</button>
                <button
                  onClick={() => setShowSettings(false)}
                  style={{
                    flex: 1, padding: "10px", borderRadius: 8, border: "none",
                    background: "#1A3A6E", color: "#fff", cursor: "pointer", fontSize: 14, fontWeight: 600,
                  }}
                >Close</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function jenksBreaks(data, k) {
  const sorted = [...data].sort((a, b) => a - b);
  const n = sorted.length;
  if (n <= k) return sorted.slice(0, k - 1);
  const lc = Array.from({ length: n + 1 }, () => new Array(k + 1).fill(1));
  const vc = Array.from({ length: n + 1 }, () => new Array(k + 1).fill(Infinity));
  for (let q = 1; q <= k; q++) vc[1][q] = 0;
  for (let l = 2; l <= n; l++) {
    let s1 = 0, s2 = 0, w = 0;
    for (let m = 1; m <= l; m++) {
      const idx = l - m + 1;
      const v = sorted[idx - 1];
      s1 += v; s2 += v * v; w++;
      const variance = s2 - (s1 * s1) / w;
      const prev = idx - 1;
      if (prev !== 0) {
        for (let q = 2; q <= k; q++) {
          const candidate = variance + vc[prev][q - 1];
          if (vc[l][q] >= candidate) { lc[l][q] = idx; vc[l][q] = candidate; }
        }
      }
    }
    lc[l][1] = 1;
    vc[l][1] = s2 - (s1 * s1) / l;
  }
  const breaks = [];
  let pos = n;
  for (let q = k; q >= 2; q--) {
    breaks.unshift(sorted[lc[pos][q] - 2]);
    pos = lc[pos][q] - 1;
  }
  return breaks;
}

function computeScore(props, w) {
  const keys = Object.keys(w);
  let weighted = 0, present = 0;
  keys.forEach((k) => {
    const norm = props[k + "_norm"];
    if (norm != null && !Number.isNaN(Number(norm))) {
      weighted += Number(norm) * w[k];
      present += w[k];
    }
  });
  const count = keys.filter((k) => {
    const n = props[k + "_norm"];
    return n != null && !Number.isNaN(Number(n));
  }).length;
  return count >= 3 && present > 0 ? (weighted / present) * 100 : null;
}

function Stat({ label, value, note }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 13, color: "#888" }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 600 }}>{value}</div>
      <div style={{ fontSize: 12, color: "#aaa" }}>{note}</div>
    </div>
  );
}
