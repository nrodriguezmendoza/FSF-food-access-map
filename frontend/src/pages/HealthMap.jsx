import { useEffect, useRef, useState, useCallback } from "react";
import TrendChart from "./TrendChart";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

const API = import.meta.env.VITE_API_URL ?? (import.meta.env.DEV ? "http://127.0.0.1:8000" : "");

const ACS_YEARS = [
  { value: 2024, label: "2020–2024 (Jan 2026) — Latest" },
  { value: 2023, label: "2019–2023 (Dec 2024)"          },
  { value: 2022, label: "2018–2022 (Dec 2023)"          },
  { value: 2021, label: "2017–2021 (Dec 2022)"          },
];

const ACC_LEGEND = [
  { color: "#FFD700", label: "Excellent",  range: "65–100" },
  { color: "#185FA5", label: "Good",       range: "50–65"  },
  { color: "#5ec962", label: "Moderate",   range: "38–50"  },
  { color: "#F4C0D1", label: "Low",        range: "30–38"  },
  { color: "#7F77DD", label: "Minimal",    range: "0–30"   },
];

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

// ── Gap-analysis & weighted-scoring helpers (ported from the pre-refactor App.jsx) ──

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

// Average of outer ring coordinates — used as a cheap tract centroid
function polyCentroid(feature) {
  const geom = feature.geometry;
  const ring =
    geom.type === "Polygon" ? geom.coordinates[0] : geom.coordinates[0][0];
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

// Min-max normalize the raw ACS fields the weight sliders operate on.
// median_income is inverted — lower income means higher need.
function normalizeTracts(geojson) {
  const fields = ["poverty_rate", "snap_rate", "no_vehicle_rate", "median_income"];
  const invert = new Set(["median_income"]);
  const stats = {};
  fields.forEach((f) => {
    const vals = geojson.features
      .map((x) => x.properties[f])
      .filter((v) => v != null && !Number.isNaN(Number(v)))
      .map(Number);
    if (vals.length) stats[f] = { min: Math.min(...vals), max: Math.max(...vals) };
  });
  geojson.features.forEach((f) => {
    const p = f.properties;
    fields.forEach((field) => {
      const v = p[field];
      const s = stats[field];
      if (v == null || !s || s.max === s.min) { p[field + "_norm"] = null; return; }
      let norm = (Number(v) - s.min) / (s.max - s.min);
      if (invert.has(field)) norm = 1 - norm;
      p[field + "_norm"] = norm;
    });
    p.food_desert_norm =
      p.food_desert === 1 || p.food_desert === "1" ? 1
      : p.food_desert === 0 || p.food_desert === "0" ? 0
      : null;
  });
  return geojson;
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

export default function HealthMap() {
  const mapContainer = useRef(null);
  const map          = useRef(null);
  const fullBounds   = useRef(null);
  const pollRef      = useRef(null);

  // ── Gap analysis / weighted-scoring refs — hold latest data so sliders
  //    can recompute instantly without refetching from the backend.
  const geojsonRef      = useRef(null);
  const agenciesRef     = useRef(null);
  const tractCentroids  = useRef({});
  const scoresRef       = useRef({}); // GEOID -> current weighted need score
  const weightsRef      = useRef(DEFAULT_WEIGHTS);
  const radiusRef       = useRef(2);

  // ── Layer
  const [activeLayer,    setActiveLayer]    = useState("need");

  // ── ACS
  const [acsYear,        setAcsYear]        = useState(2024);
  const [acsStatus,      setAcsStatus]      = useState({});

  // ── FSF — available years loaded from backend
  const [fsfAvailYears,  setFsfAvailYears]  = useState([]);   // [{year, rows, filename}]
  const [fsfYear,        setFsfYear]        = useState(null); // null = no selection yet

  // ── Upload panel
  const [uploadOpen,     setUploadOpen]     = useState(false);
  const [showTrend,      setShowTrend]      = useState(false);
  const [activeTab,      setActiveTab]      = useState("upload");
  const [uploadYear,     setUploadYear]     = useState("");
  const [fsfFile,        setFsfFile]        = useState(null);
  const [fsfUploading,   setFsfUploading]   = useState(false);
  const [fsfMsg,         setFsfMsg]         = useState("");

  // ── History
  const [fsfHistory,     setFsfHistory]     = useState([]);
  const [selectedIds,    setSelectedIds]    = useState(new Set());
  const [deleting,       setDeleting]       = useState(false);

  // ── Tract click
  const [selected,       setSelected]       = useState(null);

  // ── Toast
  const [toast,          setToast]          = useState("");

  // ── Weight sliders (Need score view only)
  const [weights,        setWeights]        = useState(DEFAULT_WEIGHTS);
  const [showSettings,   setShowSettings]   = useState(false);
  const [breaks,         setBreaks]         = useState(null);

  // ── Coverage gap analysis (Need score view only)
  const [radius,         setRadius]         = useState(2);
  const [gapTracts,      setGapTracts]      = useState([]);

  useEffect(() => { weightsRef.current = weights; }, [weights]);
  useEffect(() => { radiusRef.current = radius; }, [radius]);

  const showToast = (msg, duration = 3000) => {
    setToast(msg);
    setTimeout(() => setToast(""), duration);
  };

  // ── Fetch FSF available years ──────────────────────────────────────────────
  const fetchFsfAvailYears = useCallback(async () => {
    try {
      const res  = await fetch(`${API}/api/fsf/available-years`);
      const data = await res.json();
      setFsfAvailYears(data);
      return data;
    } catch { setFsfAvailYears([]); return []; }
  }, []);

  // ── Fetch FSF upload history ───────────────────────────────────────────────
  const fetchFsfHistory = useCallback(async () => {
    try {
      const res  = await fetch(`${API}/api/fsf/upload-history`);
      const data = await res.json();
      setFsfHistory(data);
    } catch { setFsfHistory([]); }
  }, []);

  useEffect(() => {
    const init = async () => {
      // Fetch available years
      try {
        const res  = await fetch(`${API}/api/fsf/available-years`);
        const data = await res.json();
        setFsfAvailYears(data);
        // Auto-select latest year for the map display only —
        // leave the upload dropdown on its placeholder until the user picks.
        if (data && data.length > 0) {
          const latest = data.sort((a, b) => b.year - a.year)[0].year;
          setFsfYear(latest);
        }
      } catch { setFsfAvailYears([]); }
      // Fetch history
      try {
        const res  = await fetch(`${API}/api/fsf/upload-history`);
        const data = await res.json();
        setFsfHistory(data);
      } catch { setFsfHistory([]); }
      // Fetch agencies (for coverage-gap analysis)
      try {
        const res  = await fetch("/agencies.geojson");
        const data = await res.json();
        agenciesRef.current = data;
      } catch { agenciesRef.current = { type: "FeatureCollection", features: [] }; }
    };
    init();
  }, []);

  // ── Apply weight sliders — recompute every tract's score, update the
  //    choropleth (Jenks breaks) and feature-state, without refetching. ───────
  const applyWeights = useCallback((w, geojson) => {
    if (!map.current || !map.current.getLayer("tracts-fill") || !geojson) return;
    const validScores = [];
    const scores = {};
    geojson.features.forEach((f) => {
      const p = f.properties;
      const score = computeScore(p, w);
      map.current.setFeatureState({ source: "tracts", id: p.GEOID }, { computed_score: score });
      scores[p.GEOID] = score;
      if (score !== null) validScores.push(score);
    });
    scoresRef.current = scores;

    const q = jenksBreaks(validScores, 5);
    setBreaks(q);

    map.current.setPaintProperty("tracts-fill", "fill-color", [
      "step", ["coalesce", ["feature-state", "computed_score"], -1],
      "#cccccc",
      0,    "#5ec962",
      q[0], "#21918c",
      q[1], "#3b528b",
      q[2], "#440154",
      q[3], "#2d1160",
    ]);
  }, []);

  // ── Recompute coverage gaps — called whenever radius changes or fresh
  //    weighted scores are applied. Uses the current client-side score. ──────
  const recomputeGap = useCallback((geojson, agencies, r) => {
    if (!geojson || !agencies || !map.current) return;

    const agencyPoints = agencies.features.map((f) => ({
      lng: f.geometry.coordinates[0],
      lat: f.geometry.coordinates[1],
    }));

    const gaps = [];
    geojson.features.forEach((f) => {
      const props = f.properties;
      const score = scoresRef.current[props.GEOID];
      if (score === null || score === undefined) return;

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
  }, []);

  // ── Load ACS tracts ────────────────────────────────────────────────────────
  const loadAcsData = useCallback(async (year) => {
    if (!map.current) return;
    const source = map.current.getSource("tracts");
    if (!source) return;
    try {
      const res = await fetch(`${API}/api/acs/tracts?acs_year=${year}`);
      if (!res.ok) return;
      const apiData = await res.json();
      const lookup = {};
      apiData.forEach(t => { lookup[t.tract_id] = t; });

      const geojson = await (await fetch("/tracts_2022.geojson")).json();
      geojson.features.forEach(f => {
        const m = lookup[f.properties.GEOID];
        if (m) {
          f.properties.need_score           = m.need_score; // kept for reference only
          f.properties.median_income        = m.median_income;
          f.properties.total_pop            = m.population;
          f.properties.county_name          = m.county;
          f.properties.poverty_rate         = m.pct_below_poverty        != null ? +Number(m.pct_below_poverty).toFixed(1)        : null;
          f.properties.snap_rate            = m.pct_snap_enrollment      != null ? +Number(m.pct_snap_enrollment).toFixed(1)      : null;
          f.properties.no_vehicle_rate      = m.pct_no_vehicle           != null ? +Number(m.pct_no_vehicle).toFixed(1)           : null;
          f.properties.food_desert          = m.food_desert;
          f.properties.supermarket_dist_mi  = m.supermarket_dist_mi;
          f.properties.unemployment_rate    = m.unemployment_rate        != null ? +Number(m.unemployment_rate).toFixed(1)        : null;
          f.properties.housing_cost_burden  = m.housing_cost_burden_pct  != null ? +Number(m.housing_cost_burden_pct).toFixed(1) : null;
        } else {
          f.properties.need_score = null;
        }
      });

      normalizeTracts(geojson);
      geojsonRef.current = geojson;
      source.setData(geojson);

      // Defer until MapLibre finishes rebuilding tiles from the new source data.
      // setData processes asynchronously in a web worker; applying feature states
      // before the tiles exist causes them to be silently dropped.
      map.current.once("idle", () => {
        if (!map.current) return;
        applyWeights(weightsRef.current, geojson);
        map.current.setPaintProperty("tracts-fill", "fill-opacity", [
          "case", ["boolean", ["feature-state", "covered"], false], 0.35, 0.72,
        ]);
        recomputeGap(geojson, agenciesRef.current, radiusRef.current);
      });
    } catch (e) { console.error("ACS load error", e); }
  }, [applyWeights, recomputeGap]);

  // ── Load FSF data ──────────────────────────────────────────────────────────
  const loadFsfData = useCallback(async (year) => {
    if (!map.current || !year) return;
    const source = map.current.getSource("tracts");
    if (!source) return;
    try {
      const res = await fetch(`${API}/api/fsf/distributions?dist_year=${year}`);
      if (!res.ok) return;
      const apiData = await res.json();

      // Normalize county names for matching
      const normalizeCounty = (name) => {
        if (!name) return "";
        const n = name.toLowerCase().trim();
        if (n.includes("miami") || n.includes("dade"))   return "miami-dade";
        if (n.includes("broward"))                        return "broward";
        if (n.includes("palm"))                           return "palm beach";
        return "";
      };

      // Aggregate by county — sum totals, average impact_score
      const countyAgg = {};
      apiData.forEach(d => {
        const key = normalizeCounty(d.county);
        if (!key) return;
        if (!countyAgg[key]) {
          countyAgg[key] = {
            households_served:  0,
            individuals_served: 0,
            meals_served:       0,
            impact_score_sum:      0,
            count:              0,
            dist_year:          d.dist_year,
          };
        }
        countyAgg[key].households_served  += d.households_served  || 0;
        countyAgg[key].individuals_served += d.individuals_served || 0;
        countyAgg[key].meals_served       += d.meals_served       || 0;
        countyAgg[key].impact_score_sum      += d.impact_score || 0;
        countyAgg[key].count              += 1;
      });

      // Recalculate impact_score from aggregated totals (same formula as backend)
      const ZIP_POP = {
        "33054":28000,"33055":32000,"33056":34000,"33127":19000,"33128":15000,
        "33130":21000,"33132":14000,"33135":24000,"33136":18000,"33142":27000,
        "33147":31000,"33150":22000,"33161":29000,"33162":31000,"33169":38000,
        "33125":22000,"33126":31000,"33133":18000,"33134":20000,"33138":19000,
        "33149":12000,"33155":29000,"33165":33000,"33166":28000,"33174":26000,
        "33175":35000,"33177":38000,"33178":41000,"33179":32000,"33180":28000,
        "33311":35000,"33312":42000,"33313":39000,"33314":28000,"33315":18000,
        "33316":12000,"33317":44000,"33319":37000,"33322":46000,"33324":41000,
        "33325":38000,"33328":43000,"33060":38000,"33062":29000,"33063":44000,
        "33064":36000,"33065":42000,"33068":38000,"33069":31000,"33071":40000,
        "33073":35000,"33076":28000,"33309":32000,"33334":29000,"33351":36000,
        "33388":18000,"33441":31000,"33442":28000,"33444":22000,"33445":24000,
        "33409":28000,"33430":18000,"33435":24000,"33460":21000,"33461":32000,
        "33462":27000,"33463":35000,"33467":41000,"33472":29000,"33484":31000,
        "33401":28000,"33403":18000,"33404":22000,"33405":19000,"33406":31000,
        "33407":24000,"33408":21000,"33410":38000,"33411":42000,"33412":19000,
        "33413":36000,"33414":31000,"33415":38000,"33417":29000,"33418":44000,
        "33426":24000,"33428":31000,"33431":28000,"33432":32000,"33433":36000,
        "33040":24000,"33050":11000,"33001":8000,"33036":9000,"33037":14000,
        "33042":7000,"33043":6000,"33044":5000,"33045":4000,"33051":6000,
      };
      const DEFAULT_POP = 25000;

      // Also accumulate pop per ZIP for accurate avg
      const countyPop = {};
      apiData.forEach(d => {
        const key = normalizeCounty(d.county);
        if (!key) return;
        const pop = ZIP_POP[String(d.zip_code).padStart(5,"0")] || DEFAULT_POP;
        countyPop[key] = (countyPop[key] || 0) + pop;
      });

      Object.keys(countyAgg).forEach(k => {
        const c = countyAgg[k];
        const avgInd   = c.individuals_served / Math.max(c.count, 1);
        const avgMeals = c.meals_served       / Math.max(c.count, 1);
        const avgPop   = (countyPop[k] || DEFAULT_POP * c.count) / Math.max(c.count, 1);
        const popPct    = Math.min((avgInd / avgPop) / 0.05, 1.0) * 60;
        const mealsSc   = Math.min((avgMeals / Math.max(avgInd, 1)) / 5.0, 1.0) * 40;
        c.impact_score = Math.round((popPct + mealsSc) * 10) / 10;
      });

      // Map GEOID county FIPS → normalized county name
      // Miami-Dade = 086, Broward = 011, Palm Beach = 099, Monroe = 087
      const fipsToCounty = {
        "12086": "miami-dade",
        "12011": "broward",
        "12099": "palm beach",
        };

      const geojson = await (await fetch("/tracts_2022.geojson")).json();
      geojson.features.forEach(f => {
        const geoid      = f.properties.GEOID || "";
        const fipsPrefix = geoid.slice(0, 5);
        const countyKey  = fipsToCounty[fipsPrefix];
        const match      = countyKey ? countyAgg[countyKey] : null;

        if (match) {
          f.properties.impact_score          = match.impact_score;
          f.properties.households_served  = match.households_served;
          f.properties.individuals_served = match.individuals_served;
          f.properties.meals_served       = match.meals_served;
          f.properties.dist_year          = match.dist_year;
        } else {
          f.properties.impact_score          = null;
          f.properties.households_served  = null;
          f.properties.individuals_served = null;
          f.properties.meals_served       = null;
        }
      });

      source.setData(geojson);
      geojsonRef.current = geojson;

      map.current.setPaintProperty("tracts-fill", "fill-color", [
        "step", ["coalesce", ["get", "impact_score"], -1],
        "#cccccc", 0, "#7F77DD", 30, "#F4C0D1", 38, "#5ec962", 50, "#185FA5", 65, "#FFD700",
      ]);
      // Coverage-gap overlay is Need-score-specific; keep the impact layer
      // at full opacity regardless of "covered" feature-state.
      map.current.setPaintProperty("tracts-fill", "fill-opacity", 0.72);
    } catch (e) { console.error("FSF load error", e); }
  }, []);

  // ── Trigger ACS fetch ──────────────────────────────────────────────────────
  const triggerAcsFetch = useCallback(async (year) => {
    setAcsStatus(prev => ({ ...prev, [year]: { status: "fetching", message: `Fetching ACS ${year}...` } }));
    showToast(`Fetching ACS ${year} from Census Bureau...`, 8000);
    try {
      const res  = await fetch(`${API}/api/acs/fetch?acs_year=${year}`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setAcsStatus(prev => ({ ...prev, [year]: { status: "error", message: data.detail } }));
        showToast(`❌ ${data.detail}`);
        return;
      }
      if (data.cached) {
        setAcsStatus(prev => ({ ...prev, [year]: { status: "done", message: `ACS ${year} loaded`, tracts: data.tracts || 0 } }));
        await loadAcsData(year);
        showToast(`✅ ACS ${year} data loaded`);
        return;
      }
      pollRef.current = setInterval(async () => {
        try {
          const sr   = await fetch(`${API}/api/acs/fetch-status?acs_year=${year}`);
          const stat = await sr.json();
          setAcsStatus(prev => ({ ...prev, [year]: stat }));
          if (stat.status === "done") {
            clearInterval(pollRef.current);
            await loadAcsData(year);
            showToast(`✅ ACS ${year} — ${stat.tracts || "Data"} loaded successfully`);
          } else if (stat.status === "error") {
            clearInterval(pollRef.current);
            showToast(`❌ ${stat.message}`);
          }
        } catch { clearInterval(pollRef.current); }
      }, 2000);
    } catch (e) {
      setAcsStatus(prev => ({ ...prev, [year]: { status: "error", message: e.message } }));
      showToast("❌ Could not reach backend");
    }
  }, [loadAcsData]);

  // ── ACS year change ────────────────────────────────────────────────────────
  const handleAcsYearChange = useCallback(async (year) => {
    setAcsYear(year);
    setSelected(null);
    if (map.current) map.current.setFilter("tracts-selected", ["==", "GEOID", ""]);
    if (acsStatus[year]?.status === "done") {
      await loadAcsData(year);
      showToast(`Switched to ACS ${year}`);
    } else if (acsStatus[year]?.status !== "fetching") {
      await triggerAcsFetch(year);
    }
  }, [acsStatus, loadAcsData, triggerAcsFetch]);

  // ── FSF year change from combo ─────────────────────────────────────────────
  const handleFsfYearChange = useCallback(async (year) => {
    if (!year) return;
    setFsfYear(year);
    setSelected(null);
    if (map.current) map.current.setFilter("tracts-selected", ["==", "GEOID", ""]);
    await loadFsfData(year);
    showToast(`Loaded FSF distribution data for ${year}`);
  }, [loadFsfData]);

  // ── Layer switch ───────────────────────────────────────────────────────────
  const handleLayerSwitch = useCallback((layer) => {
    setActiveLayer(layer);
    setSelected(null);
    setUploadOpen(false);
    if (map.current) {
      map.current.setFilter("tracts-selected", ["==", "GEOID", ""]);
      const vis = layer === "need" ? "visible" : "none";
      ["agencies-points", "coverage-fill", "coverage-outline"].forEach((id) => {
        if (map.current.getLayer(id)) {
          map.current.setLayoutProperty(id, "visibility", vis);
        }
      });
    }
    if (layer === "need") {
      loadAcsData(acsYear);
    } else {
      if (fsfYear) {
        loadFsfData(fsfYear);
      } else if (fsfAvailYears.length > 0) {
        const latest = [...fsfAvailYears].sort((a,b) => b.year - a.year)[0].year;
        setFsfYear(latest);
        loadFsfData(latest);
      } else {
        const source = map.current?.getSource("tracts");
        if (source && map.current) {
          map.current.setPaintProperty("tracts-fill", "fill-color", "#cccccc");
        }
      }
    }
  }, [acsYear, fsfYear, loadAcsData, loadFsfData]);

  // ── FSF Upload ─────────────────────────────────────────────────────────────
  const handleFsfUpload = async () => {
    if (!fsfFile || !uploadYear) return;
    setFsfUploading(true);
    setFsfMsg("");
    const formData = new FormData();
    formData.append("file", fsfFile);
    try {
      const res  = await fetch(`${API}/api/fsf/upload?dist_year=${uploadYear}`, {
        method: "POST", body: formData,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Upload failed");

      setFsfFile(null);
      setUploadYear("");
      await fetchFsfAvailYears();
      await fetchFsfHistory();

      // Auto-select the uploaded year in combo and load map
      setFsfYear(data.year);
      setActiveLayer("impact");
      await loadFsfData(data.year);
      setUploadOpen(false);
      showToast(`✅ ${data.rows_imported} rows imported for ${data.year}`);
    } catch (err) {
      setFsfMsg(`❌ ${err.message || "Upload failed. Please try again."}`);
    }
    setFsfUploading(false);
  };

  // ── Delete FSF batches ─────────────────────────────────────────────────────
  const handleDeleteSelected = async () => {
    if (selectedIds.size === 0) return;
    const count = selectedIds.size;
    setDeleting(true);

    // Find which years are being deleted
    const deletedYears = new Set(
      fsfHistory.filter(b => selectedIds.has(b.id)).map(b => b.dist_year)
    );

    for (const id of selectedIds) {
      try { await fetch(`${API}/api/fsf/upload-history/${id}`, { method: "DELETE" }); }
      catch { /* continue */ }
    }
    setSelectedIds(new Set());
    const remainingYears = await fetchFsfAvailYears();
    await fetchFsfHistory();

    // If the currently active year was deleted, fall back to the new latest
    // available year (same logic as initial load) instead of leaving the
    // map and dropdown out of sync with a null selection.
    if (fsfYear && deletedYears.has(fsfYear)) {
      if (remainingYears && remainingYears.length > 0) {
        const latest = [...remainingYears].sort((a, b) => b.year - a.year)[0].year;
        setFsfYear(latest);
        if (activeLayer === "impact") await loadFsfData(latest);
      } else {
        setFsfYear(null);
        if (activeLayer === "impact" && map.current) {
          map.current.setPaintProperty("tracts-fill", "fill-color", "#cccccc");
        }
      }
    }

    setDeleting(false);
    showToast(`${count} file(s) deleted`);
  };

  const toggleSelectId = (id) => {
    const next = new Set(selectedIds);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelectedIds(next);
  };

  const toggleSelectAll = (checked) => {
    setSelectedIds(checked ? new Set(fsfHistory.map(b => b.id)) : new Set());
  };

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  // ── Radius slider change — recompute gaps without refetching ───────────────
  const handleRadiusChange = (r) => {
    setRadius(r);
    recomputeGap(geojsonRef.current, agenciesRef.current, r);
  };

  // ── Weight slider change — rebalance others proportionally (unchanged
  //    logic from the original App.jsx), then recompute score + gaps live ────
  const handleWeightChange = (key, newVal) => {
    const others = Object.keys(weights).filter((x) => x !== key);
    const remaining = 100 - newVal;
    const oldOthersTotal = others.reduce((s, x) => s + weights[x], 0);
    const next = {};
    Object.keys(weights).forEach((x) => {
      next[x] = x === key
        ? newVal
        : oldOthersTotal > 0
          ? (weights[x] / oldOthersTotal) * remaining
          : remaining / others.length;
    });
    setWeights(next);
    applyWeights(next, geojsonRef.current);
    recomputeGap(geojsonRef.current, agenciesRef.current, radiusRef.current);
  };

  const handleResetWeights = () => {
    setWeights(DEFAULT_WEIGHTS);
    applyWeights(DEFAULT_WEIGHTS, geojsonRef.current);
    recomputeGap(geojsonRef.current, agenciesRef.current, radiusRef.current);
  };

  // ── Fly to a tract selected from the gap-list sidebar ───────────────────────
  const flyToTract = (geoid) => {
    if (!map.current || !geojsonRef.current) return;
    const feature = geojsonRef.current.features.find(f => f.properties.GEOID === geoid);
    if (!feature) return;
    setSelected(feature.properties);
    map.current.setFilter("tracts-selected", ["==", "GEOID", geoid]);
    const bounds = new maplibregl.LngLatBounds();
    const geom = feature.geometry;
    const rings = geom.type === "Polygon" ? geom.coordinates : geom.coordinates.flat();
    rings.forEach(ring => ring.forEach(c => bounds.extend(c)));
    map.current.fitBounds(bounds, {
      padding: { top: 80, bottom: 80, left: 80, right: 320 },
      maxZoom: 13, duration: 800,
    });
  };

  // ── Init map ───────────────────────────────────────────────────────────────
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
    });

    map.current.on("load", () => {
      map.current.addSource("tracts", {
        type: "geojson",
        data: "/tracts_2022.geojson",
        promoteId: "GEOID",
      });
      map.current.addSource("coverage", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.current.addSource("agencies", {
        type: "geojson",
        data: "/agencies.geojson",
      });

      fetch("/tracts_2022.geojson").then(r => r.json()).then(geojson => {
        const b = new maplibregl.LngLatBounds();
        geojson.features.forEach(f => {
          if (!f.geometry) return;
          const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
          polys.forEach(poly => poly.forEach(ring => ring.forEach(c => b.extend(c))));
        });
        map.current.fitBounds(b, { padding: 60, duration: 0 });
        fullBounds.current = b;
        const sw = b.getSouthWest(), ne = b.getNorthEast();
        map.current.setMaxBounds([[sw.lng - 2, sw.lat - 2], [ne.lng + 2, ne.lat + 2]]);
      });

      // Coverage circles — drawn under the tract fill
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

      map.current.addLayer({
        id: "tracts-fill", type: "fill", source: "tracts",
        paint: {
          "fill-color": "#cccccc",
          "fill-opacity": 0.72,
        },
      });
      map.current.addLayer({
        id: "tracts-outline", type: "line", source: "tracts",
        paint: { "line-color": "#ffffff", "line-width": 0.3 },
      });
      map.current.addLayer({
        id: "tracts-selected", type: "line", source: "tracts",
        paint: { "line-color": "#000000", "line-width": 2.5 },
        filter: ["==", "GEOID", ""],
      });

      // Agency markers on top — Need score view only (coverage-gap context)
      map.current.addLayer({
        id: "agencies-points",
        type: "circle",
        source: "agencies",
        layout: { visibility: "visible" }, // default layer is "need"
        paint: {
          "circle-radius": 5,
          "circle-color": "#ffffff",
          "circle-stroke-color": "#1A3A6E",
          "circle-stroke-width": 2,
        },
      });

      map.current.on("click", "tracts-fill", e => {
        const props = e.features[0].properties;
        setSelected(props);
        map.current.setFilter("tracts-selected", ["==", "GEOID", props.GEOID]);
        const bounds = new maplibregl.LngLatBounds();
        const geom   = e.features[0].geometry;
        const rings  = geom.type === "Polygon" ? geom.coordinates : geom.coordinates.flat();
        rings.forEach(ring => ring.forEach(c => bounds.extend(c)));
        map.current.fitBounds(bounds, {
          padding: { top: 80, bottom: 80, left: 80, right: 320 },
          maxZoom: 13, duration: 800,
        });
      });
      map.current.on("mouseenter", "tracts-fill", () => { map.current.getCanvas().style.cursor = "pointer"; });
      map.current.on("mouseleave", "tracts-fill", () => { map.current.getCanvas().style.cursor = ""; });

      // Auto-fetch ACS 2024 on load
      triggerAcsFetch(2024);
    });
  }, [loadAcsData, triggerAcsFetch]);

  const fmt = (v, suffix = "") =>
    v === null || v === undefined || v === "" ? "—" : `${Number(v).toFixed(1)}${suffix}`;

  const legendTitle = activeLayer === "need" ? "Need score" : "Impact score";
  const legendSrc   = activeLayer === "need"
    ? `ACS ${ACS_YEARS.find(y => y.value === acsYear)?.label || acsYear}`
    : fsfYear ? `FSF Distribution ${fsfYear}` : "No year selected";

  const currentAcsStatus = acsStatus[acsYear];
  const isFetching = currentAcsStatus?.status === "fetching";
  const showGapSidebar = activeLayer === "need";

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div style={{ position: "relative", height: "100vh", width: "100vw", overflow: "hidden", fontFamily: "system-ui, sans-serif" }}>

      {/* Toast */}
      {toast && (
        <div style={{
          position: "fixed", top: 108, left: "50%", transform: "translateX(-50%)",
          background: "#085041", color: "#fff", padding: "8px 20px",
          borderRadius: 20, fontSize: 13, fontWeight: 500, zIndex: 100,
          boxShadow: "0 2px 8px rgba(0,0,0,0.2)", whiteSpace: "nowrap",
        }}>{toast}</div>
      )}

      {/* Header — spans full width, over both the sidebar and the map */}
      <div style={{
        position: "absolute", top: 0, left: 0, right: 0, height: 50,
        background: "#1a3a2a", display: "flex", alignItems: "center",
        justifyContent: "space-between", padding: "0 20px", zIndex: 20,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 20, filter: "sepia(1) saturate(10) hue-rotate(-30deg)" }}>🌿</span>
          <span style={{ color: "#fff", fontWeight: 600, fontSize: 14 }}>
            Feeding South Florida — Health Equity Intelligence
          </span>
        </div>
        <a href="/" style={{
          color: "#9FE1CB", border: "1px solid #9FE1CB", borderRadius: 6,
          padding: "4px 12px", fontSize: 12, textDecoration: "none",
        }}>← Home</a>
      </div>

      {/* Control Bar — also spans full width */}
      <div style={{
        position: "absolute", top: 50, left: 0, right: 0, height: 46,
        background: "#1a3a2a", borderTop: "1px solid rgba(255,255,255,0.08)",
        display: "flex", alignItems: "center", gap: 14, padding: "0 20px", zIndex: 20,
      }}>
        {/* Layer toggle */}
        <div style={{ display: "flex", background: "rgba(255,255,255,0.1)", borderRadius: 6, padding: 3, gap: 2 }}>
          {[["need", "Need score"], ["impact", "Impact score"]].map(([key, label]) => (
            <button key={key} onClick={() => handleLayerSwitch(key)} style={{
              padding: "4px 14px", borderRadius: 4, fontSize: 12, cursor: "pointer",
              border: "none", fontWeight: 500, transition: "all 0.15s",
              background: activeLayer === key ? (key === "need" ? "#440154" : "#185FA5") : "transparent",
              color: activeLayer === key ? "#fff" : "rgba(255,255,255,0.6)",
            }}>{label}</button>
          ))}
        </div>

        <div style={{ width: 1, height: 20, background: "rgba(255,255,255,0.15)" }} />

        {/* Need score controls */}
        {activeLayer === "need" && (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ color: "#9FE1CB", fontSize: 11, whiteSpace: "nowrap" }}>ACS Year:</span>
            <select value={acsYear} onChange={e => handleAcsYearChange(Number(e.target.value))}
              disabled={isFetching}
              style={{
                background: "#0f2a1c", color: "#fff",
                border: "1px solid rgba(255,255,255,0.2)",
                borderRadius: 6, padding: "4px 8px", fontSize: 11,
                cursor: isFetching ? "not-allowed" : "pointer", minWidth: 220,
              }}>
              {ACS_YEARS.map(y => <option key={y.value} value={y.value}>{y.label}</option>)}
            </select>
            {currentAcsStatus && (
              <span style={{
                fontSize: 11, padding: "3px 10px", borderRadius: 20, whiteSpace: "nowrap",
                background: isFetching ? "rgba(255,200,0,0.2)"
                  : currentAcsStatus.status === "done"  ? "rgba(29,158,117,0.25)"
                  : currentAcsStatus.status === "error" ? "rgba(226,75,74,0.25)" : "transparent",
                color: isFetching ? "#FAC775"
                  : currentAcsStatus.status === "done"  ? "#9FE1CB"
                  : currentAcsStatus.status === "error" ? "#F09595" : "#fff",
              }}>
                {isFetching ? "⏳ Fetching from Census Bureau..."
                  : currentAcsStatus.status === "done"  ? `✓ ${currentAcsStatus.tracts ? currentAcsStatus.tracts + " tracts loaded" : "Data loaded"}`
                  : currentAcsStatus.status === "error" ? `✗ ${currentAcsStatus.message}` : ""}
              </span>
            )}
          </div>
        )}

        {/* Weights button — pinned to far right in Need score view */}
        {activeLayer === "need" && (
          <div style={{ marginLeft: "auto" }}>
            <button onClick={() => setShowSettings(true)} style={{
              background: "transparent", color: "#9FE1CB",
              border: "1px solid #9FE1CB", borderRadius: 6,
              padding: "5px 12px", fontSize: 12,
              cursor: "pointer", fontWeight: 500, whiteSpace: "nowrap",
            }}>⚙ Weights</button>
          </div>
        )}

        {/* Impact score — year selector (left side) */}
        {activeLayer === "impact" && (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ color: "#9FE1CB", fontSize: 11, whiteSpace: "nowrap" }}>FSF Year:</span>
            <select
              value={fsfYear || ""}
              onChange={e => handleFsfYearChange(e.target.value ? Number(e.target.value) : null)}
              style={{
                background: "#0f2a1c", color: fsfYear ? "#fff" : "rgba(255,255,255,0.4)",
                border: "1px solid rgba(255,255,255,0.2)",
                borderRadius: 6, padding: "4px 8px", fontSize: 11,
                cursor: "pointer", minWidth: 200,
              }}>
              {fsfAvailYears.map(y => (
                <option key={y.year} value={y.year}>{y.year}</option>
              ))}
            </select>
          </div>
        )}

        {/* Upload CSV + Trend Chart buttons — pinned to far right */}
        {activeLayer === "impact" && (
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            {fsfAvailYears.length >= 2 && (
              <button onClick={() => setShowTrend(true)} style={{
                background: "transparent", color: "#9FE1CB",
                border: "1px solid #9FE1CB", borderRadius: 6,
                padding: "5px 12px", fontSize: 12,
                cursor: "pointer", fontWeight: 500, whiteSpace: "nowrap",
              }}>📈 Trend chart</button>
            )}
            {!uploadOpen && (
              <button onClick={() => { setUploadOpen(true); setSelected(null); setUploadYear(""); }} style={{
                background: "#1D9E75", color: "#fff", border: "none",
                borderRadius: 6, padding: "6px 14px", fontSize: 12,
                cursor: "pointer", fontWeight: 500, whiteSpace: "nowrap",
              }}>⬆ Upload CSV / Browse History</button>
            )}
          </div>
        )}
      </div>

      {/* ── Row below the header: gap sidebar + map pane ── */}
      <div style={{ position: "absolute", top: 96, left: 0, right: 0, bottom: 0, display: "flex" }}>

      {/* ── Left: Coverage-gap sidebar (Need score view only) ── */}
      {showGapSidebar && (
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
                onChange={(e) => handleRadiusChange(Number(e.target.value))}
                style={{ flex: 1 }}
              />
              <span style={{ fontSize: 12, fontWeight: 600, minWidth: 36, textAlign: "right" }}>
                {radius} mi
              </span>
            </div>
          </div>

          <div style={{ flex: 1, overflowY: "auto" }}>
            {gapTracts.length === 0 ? (
              <div style={{ padding: 16, color: "#999", fontSize: 13 }}>
                {isFetching ? "Loading…" : "No gaps found at this radius."}
              </div>
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
      )}

      {/* ── Right: map + panels ── */}
      <div style={{ flex: 1, position: "relative" }}>

        {/* Map */}
        <div ref={mapContainer} style={{ position: "absolute", inset: 0 }} />

        {/* Zoom */}
        <div style={{ position: "absolute", top: 60, left: 16, display: "flex", flexDirection: "column", gap: 2, zIndex: 10 }}>
          {["+", "−"].map((label, i) => (
            <button key={label} onClick={() => i === 0 ? map.current.zoomIn() : map.current.zoomOut()} style={{
              width: 30, height: 30, fontSize: 18, lineHeight: 1, background: "#fff",
              border: "none", borderRadius: i === 0 ? "6px 6px 0 0" : "0 0 6px 6px",
              boxShadow: "0 1px 4px rgba(0,0,0,0.2)", cursor: "pointer",
            }}>{label}</button>
          ))}
        </div>

        {/* Reset */}
        <button onClick={() => {
          if (fullBounds.current) map.current.fitBounds(fullBounds.current, { padding: 60, duration: 800 });
          setSelected(null);
          map.current.setFilter("tracts-selected", ["==", "GEOID", ""]);
        }} style={{
          position: "absolute", top: 16, left: 16, zIndex: 10,
          background: "#fff", border: "none", borderRadius: 8,
          padding: "7px 13px", fontSize: 12, fontWeight: 600,
          cursor: "pointer", boxShadow: "0 1px 4px rgba(0,0,0,0.2)",
        }}>↺ Reset view</button>

        {/* Legend */}
        <div style={{
          position: "absolute", bottom: 24, left: 24, zIndex: 10,
          background: "rgba(255,255,255,0.97)", padding: "12px 15px",
          borderRadius: 8, boxShadow: "0 1px 4px rgba(0,0,0,0.15)", fontSize: 12,
        }}>
          <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 13 }}>{legendTitle}</div>
          {activeLayer === "need" ? (
            breaks === null ? (
              <div style={{ color: "#aaa" }}>Loading…</div>
            ) : [
              ["#2d1160", "Highest need", `${Math.round(breaks[3])}–100`],
              ["#440154", "Very high",   `${Math.round(breaks[2])}–${Math.round(breaks[3])}`],
              ["#3b528b", "High",        `${Math.round(breaks[1])}–${Math.round(breaks[2])}`],
              ["#21918c", "Moderate",    `${Math.round(breaks[0])}–${Math.round(breaks[1])}`],
              ["#5ec962", "Low need",    `0–${Math.round(breaks[0])}`],
            ].map(([color, label, range]) => (
              <div key={label} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                <div style={{ width: 15, height: 15, background: color, borderRadius: 3, flexShrink: 0 }} />
                <span style={{ flex: 1, color: "#444" }}>{label}</span>
                <span style={{ color: "#999", fontSize: 11 }}>{range}</span>
              </div>
            ))
          ) : (
            ACC_LEGEND.map(({ color, label, range }) => (
              <div key={label} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                <div style={{ width: 15, height: 15, background: color, borderRadius: 3, flexShrink: 0 }} />
                <span style={{ flex: 1, color: "#444" }}>{label}</span>
                <span style={{ color: "#999", fontSize: 11 }}>{range}</span>
              </div>
            ))
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 8 }}>
            <div style={{ width: 13, height: 13, background: "#cccccc" }} />
            <span style={{ color: "#888", fontSize: 11 }}>No data</span>
          </div>
          {showGapSidebar && (
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
              <div style={{
                width: 13, height: 13, borderRadius: 2,
                background: "rgba(59,130,246,0.18)", border: "1.5px solid #1d4ed8",
              }} />
              <span style={{ color: "#888", fontSize: 11 }}>Partner radius</span>
            </div>
          )}
          <div style={{ borderTop: "0.5px solid #eee", marginTop: 8, paddingTop: 6, fontSize: 10, color: "#aaa" }}>
            {legendSrc}
          </div>
        </div>

        {/* ── Upload Panel ── */}
        {uploadOpen && activeLayer === "impact" && (
          <div style={{
            position: "absolute", top: 0, right: 0, bottom: 0, width: 320,
            background: "#fff", boxShadow: "-2px 0 8px rgba(0,0,0,0.12)",
            zIndex: 15, display: "flex", flexDirection: "column",
          }}>
            <div style={{ padding: "14px 16px 10px", borderBottom: "0.5px solid #f0f0f0" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: "#1a1a1a" }}>FSF Distribution Data</div>
                <button onClick={() => setUploadOpen(false)}
                  style={{ border: "none", background: "none", fontSize: 20, cursor: "pointer", color: "#888", lineHeight: 1 }}>×</button>
              </div>
              <div style={{ fontSize: 11, color: "#888", marginTop: 3, lineHeight: 1.5 }}>
                Upload annual distribution CSV to visualize impact score.
              </div>
            </div>

            {/* Tabs */}
            <div style={{ display: "flex", borderBottom: "0.5px solid #e8e8e8" }}>
              {[["upload","Upload"],["history","History"],["fields","Fields"]].map(([key, label]) => (
                <button key={key} onClick={() => setActiveTab(key)} style={{
                  flex: 1, padding: "9px 0", textAlign: "center", fontSize: 12,
                  cursor: "pointer", background: "#fff", border: "none",
                  borderBottom: activeTab === key ? "2px solid #1D9E75" : "2px solid transparent",
                  color: activeTab === key ? "#1D9E75" : "#888",
                  fontWeight: activeTab === key ? 600 : 400,
                }}>{label}</button>
              ))}
            </div>

            {/* Upload tab */}
            {activeTab === "upload" && (
              <div style={{ flex: 1, overflowY: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
                <div>
                  <div style={{ fontSize: 11, color: "#888", marginBottom: 5, fontWeight: 500 }}>Distribution year</div>
                  <select value={uploadYear} onChange={e => { setUploadYear(e.target.value); setFsfMsg(""); }}
                    style={{ width: "100%", background: "#fff", border: "0.5px solid #ccc", borderRadius: 8, padding: "8px 10px", fontSize: 13, cursor: "pointer" }}>
                    <option value="">Select year to upload...</option>
                    {[2025, 2024, 2023, 2022, 2021].map(y => (
                      <option key={y} value={y}>
                        {y}{fsfAvailYears.find(a => a.year === y) ? " — Replace existing data" : " — Upload new"}
                      </option>
                    ))}
                  </select>
                </div>

                {uploadYear && (
                  <div>
                    <div style={{ fontSize: 11, color: "#888", marginBottom: 5, fontWeight: 500 }}>CSV file</div>
                    <label style={{
                      display: "block", border: "2px dashed #1D9E75",
                      borderRadius: 8, padding: "18px 12px", textAlign: "center",
                      cursor: "pointer", background: "#f8fffe",
                    }}>
                      <div style={{ fontSize: 26, color: "#1D9E75", marginBottom: 6 }}>📂</div>
                      <div style={{ fontSize: 13, color: fsfFile ? "#085041" : "#1D9E75", fontWeight: 500 }}>
                        {fsfFile ? fsfFile.name : "Click to select CSV file"}
                      </div>
                      <div style={{ fontSize: 11, color: "#aaa", marginTop: 3 }}>
                        e.g. fsf_distribution_{uploadYear}.csv
                      </div>
                      <input type="file" accept=".csv" style={{ display: "none" }}
                        onChange={e => { setFsfFile(e.target.files[0]); setFsfMsg(""); }} />
                    </label>
                    {fsfFile && !fsfFile.name.includes(String(uploadYear)) && (
                      <div style={{
                        marginTop: 6, fontSize: 11, color: "#a36b00",
                        background: "#fff6e0", border: "0.5px solid #ffe1a0",
                        borderRadius: 6, padding: "6px 10px",
                      }}>
                        ⚠ This file name doesn't mention {uploadYear} — double-check it's the right file before submitting.
                      </div>
                    )}
                  </div>
                )}

                <button onClick={handleFsfUpload} disabled={!fsfFile || !uploadYear || fsfUploading} style={{
                  width: "100%", padding: "10px",
                  background: fsfFile && uploadYear && !fsfUploading ? "#1D9E75" : "#ccc",
                  color: "#fff", border: "none", borderRadius: 8,
                  fontSize: 13, fontWeight: 600,
                  cursor: fsfFile && uploadYear && !fsfUploading ? "pointer" : "not-allowed",
                }}>
                  {fsfUploading ? "Uploading…" : "Submit"}
                </button>

                {fsfMsg && (
                  <div style={{
                    padding: "10px 14px", borderRadius: 6,
                    background: fsfMsg.includes("✅") ? "#E1F5EE" : "#FCECEA",
                    color: fsfMsg.includes("✅") ? "#0F6E56" : "#a32d2d",
                    fontSize: 13,
                  }}>{fsfMsg}</div>
                )}
              </div>
            )}

            {/* History tab — grouped by year */}
            {activeTab === "history" && (
              <div style={{ flex: 1, overflowY: "auto", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span style={{ fontSize: 12, color: "#888" }}>{fsfHistory.length} file{fsfHistory.length !== 1 ? "s" : ""} uploaded</span>
                  <button
                    onClick={handleDeleteSelected}
                    disabled={selectedIds.size === 0 || deleting}
                    style={{
                      padding: "5px 12px", fontSize: 12, fontWeight: 500,
                      background: selectedIds.size > 0 ? "#FCEBEB" : "#f5f5f5",
                      color: selectedIds.size > 0 ? "#A32D2D" : "#bbb",
                      border: selectedIds.size > 0 ? "0.5px solid #f5b8b8" : "0.5px solid #e8e8e8",
                      borderRadius: 6, cursor: selectedIds.size > 0 ? "pointer" : "not-allowed",
                    }}>
                    🗑 Delete{selectedIds.size > 0 ? ` (${selectedIds.size})` : ""}
                  </button>
                </div>

                {fsfHistory.length === 0 ? (
                  <p style={{ fontSize: 12, color: "#999", textAlign: "center", marginTop: 20 }}>No uploads yet.</p>
                ) : (
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                    <thead>
                      <tr>
                        <th style={{ width: 28, padding: "6px", textAlign: "left", fontSize: 10, fontWeight: 600, color: "#888", borderBottom: "0.5px solid #e8e8e8", background: "#fafafa" }}>
                          <input type="checkbox"
                            checked={selectedIds.size === fsfHistory.length && fsfHistory.length > 0}
                            onChange={e => toggleSelectAll(e.target.checked)}
                            style={{ accentColor: "#1D9E75", cursor: "pointer" }} />
                        </th>
                        {["Year","File","Rows","Status"].map(h => (
                          <th key={h} style={{ padding: "6px", textAlign: "left", fontSize: 10, fontWeight: 600, color: "#888", letterSpacing: "0.05em", borderBottom: "0.5px solid #e8e8e8", background: "#fafafa" }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {fsfHistory.map(b => (
                        <tr key={b.id} style={{ background: selectedIds.has(b.id) ? "#E1F5EE" : "transparent" }}>
                          <td style={{ padding: "7px 6px", borderBottom: "0.5px solid #f5f5f5" }}>
                            <input type="checkbox" checked={selectedIds.has(b.id)}
                              onChange={() => toggleSelectId(b.id)}
                              style={{ accentColor: "#1D9E75", cursor: "pointer" }} />
                          </td>
                          <td style={{ padding: "7px 6px", borderBottom: "0.5px solid #f5f5f5", fontWeight: 600, color: "#1D9E75" }}>{b.dist_year}</td>
                          <td style={{ padding: "7px 6px", borderBottom: "0.5px solid #f5f5f5", fontSize: 11, maxWidth: 80, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.filename}</td>
                          <td style={{ padding: "7px 6px", borderBottom: "0.5px solid #f5f5f5" }}>{b.row_count?.toLocaleString()}</td>
                          <td style={{ padding: "7px 6px", borderBottom: "0.5px solid #f5f5f5" }}>
                            <span style={{
                              fontSize: 10, padding: "2px 7px", borderRadius: 10, fontWeight: 500,
                              background: b.status === "active" ? "#1D9E75" : "#e0e0e0",
                              color: b.status === "active" ? "#fff" : "#777",
                            }}>{b.status === "active" ? "ACTIVE" : "ARCHIVED"}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}

            {/* Fields tab */}
            {activeTab === "fields" && (
              <div style={{ flex: 1, overflowY: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ fontSize: 10, fontWeight: 600, color: "#888", letterSpacing: "0.06em", marginBottom: 4 }}>REQUIRED CSV COLUMNS</div>
                {[
                  ["zip_code",           "Where food was distributed", true],
                  ["county",             "One of 4 counties",          true],
                  ["households_served",  "Per ZIP per month",          true],
                  ["individuals_served", "Per ZIP per month",          true],
                  ["meals_served",       "No. of meals served",        true],
                  ["month",              "Monthly breakdown",          false],
                ].map(([col, note, req]) => (
                  <div key={col} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: "0.5px solid #f5f5f5" }}>
                    <span style={{ fontSize: 11, color: "#185FA5", background: "#E6F1FB", padding: "2px 7px", borderRadius: 4, fontFamily: "monospace", flexShrink: 0 }}>{col}</span>
                    <span style={{ fontSize: 11, color: "#666", flex: 1 }}>{note}</span>
                    <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 4, flexShrink: 0, background: req ? "#FCEBEB" : "#E1F5EE", color: req ? "#A32D2D" : "#0F6E56" }}>
                      {req ? "required" : "optional"}
                    </span>
                  </div>
                ))}
                <div style={{ background: "#f8f8f8", borderRadius: 6, padding: 10, fontSize: 11, color: "#666", lineHeight: 1.7, marginTop: 4 }}>
                  County must be exactly one of:<br />
                  <strong>Miami-Dade · Broward · Palm Beach</strong>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Trend Chart Modal ── */}
        {showTrend && <TrendChart onClose={() => setShowTrend(false)} />}

        {/* ── Tract Sidebar ── */}
        {selected && !uploadOpen && (
          <div style={{
            position: "absolute", top: 0, right: 0, bottom: 0, width: 300,
            background: "#fff", boxShadow: "-2px 0 8px rgba(0,0,0,0.12)",
            padding: "18px 20px", overflowY: "auto", zIndex: 15,
          }}>
            <button onClick={() => { setSelected(null); map.current.setFilter("tracts-selected", ["==", "GEOID", ""]); }}
              style={{ float: "right", border: "none", background: "none", fontSize: 20, cursor: "pointer", color: "#888" }}>×</button>

            {activeLayer === "need" ? (
              <>
                <h2 style={{ margin: "0 0 3px", fontSize: 17, fontWeight: 600 }}>
                  Need score: {fmt(computeScore(selected, weights))}
                </h2>
                <p style={{ margin: "0 0 18px", color: "#888", fontSize: 12 }}>
                  {selected.county_name} County · Tract {selected.GEOID}
                </p>
                <Stat label="Population"          value={selected.total_pop ? Number(selected.total_pop).toLocaleString() : "—"} note={`ACS ${acsYear}`} />
                <Stat label="Below poverty"       value={fmt(selected.poverty_rate, "%")}       note="vs ~13% nationally" />
                <Stat label="Receiving SNAP"      value={fmt(selected.snap_rate, "%")}           note="of households" />
                <Stat label="No vehicle"          value={fmt(selected.no_vehicle_rate, "%")}     note="of households" />
                <Stat label="Unemployment"        value={fmt(selected.unemployment_rate, "%")}   note="of labor force" />
                <Stat label="Housing cost burden" value={fmt(selected.housing_cost_burden, "%")} note="spending >30% on housing" />
                <Stat label="Food desert"
                  value={selected.food_desert === 1 || selected.food_desert === "1" ? "Yes" : selected.food_desert === 0 || selected.food_desert === "0" ? "No" : "—"}
                  note="USDA 2019" />
                <Stat label="Nearest supermarket"
                  value={selected.supermarket_dist_mi ? `${Number(selected.supermarket_dist_mi).toFixed(1)} mi` : "—"}
                  note="distance to nearest store" />
                <Stat label="Median income"
                  value={selected.median_income ? `$${Math.round(selected.median_income).toLocaleString()}` : "—"}
                  note="household, per year" />
              </>
            ) : (
              <>
                <h2 style={{ margin: "0 0 3px", fontSize: 17, fontWeight: 600, color: "#185FA5" }}>
                  Impact score: {fmt(selected.impact_score)}
                </h2>
                <p style={{ margin: "0 0 18px", color: "#888", fontSize: 12 }}>
                  {selected.county_name} County · FSF {fsfYear}
                </p>
                <Stat label="Meals served"        value={selected.meals_served       ? Number(selected.meals_served).toLocaleString()       : "—"} note="total meals (annual)" />
                <Stat label="Individuals served"  value={selected.individuals_served ? Number(selected.individuals_served).toLocaleString() : "—"} note="people reached" />
                <Stat label="Households served"   value={selected.households_served  ? Number(selected.households_served).toLocaleString()  : "—"} note="family units" />
              </>
            )}
          </div>
        )}

        {/* ── Weight sliders modal (Need score view only) ── */}
        {showSettings && (
          <div style={{
            position: "absolute", inset: 0, background: "rgba(0,0,0,0.35)",
            display: "flex", alignItems: "center", justifyContent: "center", zIndex: 25,
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
                    onChange={(e) => handleWeightChange(k, Number(e.target.value))}
                    style={{ width: "100%" }}
                  />
                </div>
              ))}
              <div style={{ display: "flex", gap: 10, marginTop: 24 }}>
                <button onClick={handleResetWeights} style={{
                  flex: 1, padding: "10px", borderRadius: 8,
                  border: "1px solid #ccc", background: "#fff", cursor: "pointer", fontSize: 14,
                }}>Reset to defaults</button>
                <button onClick={() => setShowSettings(false)} style={{
                  flex: 1, padding: "10px", borderRadius: 8, border: "none",
                  background: "#1A3A6E", color: "#fff", cursor: "pointer", fontSize: 14, fontWeight: 600,
                }}>Close</button>
              </div>
            </div>
          </div>
        )}
      </div>
      </div>
    </div>
  );
}

function Stat({ label, value, note }) {
  return (
    <div style={{ marginBottom: 15 }}>
      <div style={{ fontSize: 12, color: "#888" }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 600 }}>{value}</div>
      <div style={{ fontSize: 11, color: "#bbb" }}>{note}</div>
    </div>
  );
}
