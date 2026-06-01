import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

export default function App() {
  const mapContainer = useRef(null);
  const map = useRef(null);
  const [selected, setSelected] = useState(null);
  const fullBounds = useRef(null);

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
      });

      // Fit the initial view to the actual tract data, then lock bounds to it
      fetch("/tracts_2022.geojson")
        .then((r) => r.json())
        .then((geojson) => {
          const b = new maplibregl.LngLatBounds();
          geojson.features.forEach((f) => {
            const geom = f.geometry;
            if (!geom) return;
            const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
            polys.forEach((poly) =>
              poly.forEach((ring) => ring.forEach((c) => b.extend(c)))
            );
          });
          map.current.fitBounds(b, { padding: 60, duration: 0 });
          fullBounds.current = b;
          // Expand bounds before locking — tight bounds force a high minimum zoom
          const sw = b.getSouthWest();
          const ne = b.getNorthEast();
          map.current.setMaxBounds([
            [sw.lng - 2, sw.lat - 2],
            [ne.lng + 2, ne.lat + 2],
          ]);
        });

      map.current.addLayer({
        id: "tracts-fill",
        type: "fill",
        source: "tracts",
        paint: {
          "fill-color": [
            "step",
            ["coalesce", ["get", "need_score"], -1],
            "#cccccc",
            0,  "#5ec962",
            25, "#21918c",
            50, "#3b528b",
            75, "#440154",
            90, "#2d1160",
          ],
          "fill-opacity": 0.7,
        },
      });

      map.current.addLayer({
        id: "tracts-outline",
        type: "line",
        source: "tracts",
        paint: { "line-color": "#ffffff", "line-width": 0.3 },
      });

      // Highlight layer for the selected tract
      map.current.addLayer({
        id: "tracts-selected",
        type: "line",
        source: "tracts",
        paint: { "line-color": "#000000", "line-width": 2.5 },
        filter: ["==", "GEOID", ""],
      });

      // Click a tract -> show its stats
      map.current.on("click", "tracts-fill", (e) => {
        const feature = e.features[0];
        const props = feature.properties;
        setSelected(props);
        map.current.setFilter("tracts-selected", ["==", "GEOID", props.GEOID]);

        // Compute the tract's bounding box and fly to it
        const bounds = new maplibregl.LngLatBounds();
        const geom = feature.geometry;
        const rings =
          geom.type === "Polygon" ? geom.coordinates : geom.coordinates.flat();
        rings.forEach((ring) =>
          ring.forEach((coord) => bounds.extend(coord))
        );

        map.current.fitBounds(bounds, {
          padding: { top: 80, bottom: 80, left: 80, right: 360 },
          maxZoom: 13,
          duration: 800,
        });
      });

      // Cursor feedback
      map.current.on("mouseenter", "tracts-fill", () => {
        map.current.getCanvas().style.cursor = "pointer";
      });
      map.current.on("mouseleave", "tracts-fill", () => {
        map.current.getCanvas().style.cursor = "";
      });
    });
  }, []);

  const fmt = (v, suffix = "") =>
    v === null || v === undefined || v === "" ? "—" : `${Number(v).toFixed(1)}${suffix}`;

  
  return (
    <>
      <div ref={mapContainer} style={{ position: "absolute", inset: 0 }} />

      {/* Zoom buttons — below the reset button, left side avoids the right panel */}
      <div
        style={{
          position: "absolute", top: 60, left: 16,
          display: "flex", flexDirection: "column", gap: 2,
          zIndex: 10,
        }}
      >
        {["+", "−"].map((label, i) => (
          <button
            key={label}
            onClick={() => i === 0 ? map.current.zoomIn() : map.current.zoomOut()}
            style={{
              width: 30, height: 30, fontSize: 18, lineHeight: 1,
              background: "#fff", border: "none", borderRadius: i === 0 ? "6px 6px 0 0" : "0 0 6px 6px",
              boxShadow: "0 1px 4px rgba(0,0,0,0.2)", cursor: "pointer", fontFamily: "system-ui, sans-serif",
            }}
          >{label}</button>
        ))}
      </div>

      {/* Legend */}
      <div
        style={{
          position: "absolute", bottom: 24, left: 24,
          background: "rgba(255,255,255,0.95)", padding: "12px 16px",
          borderRadius: 8, boxShadow: "0 1px 4px rgba(0,0,0,0.2)",
          fontFamily: "system-ui, sans-serif", fontSize: 12,
        }}
      >
        <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 13 }}>
          Need score
        </div>
        {[
          ["#2d1160", "Highest need", "90–100"],
          ["#440154", "Very high",   "75–90"],
          ["#3b528b", "High",        "50–75"],
          ["#21918c", "Moderate",    "25–50"],
          ["#5ec962", "Low need",    "0–25"],
        ].map(([color, label, range]) => (
          <div key={label} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <div style={{ width: 16, height: 16, background: color, borderRadius: 3, flexShrink: 0 }} />
            <span style={{ flex: 1 }}>{label}</span>
            <span style={{ color: "#999" }}>{range}</span>
          </div>
        ))}
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 10 }}>
          <div style={{ width: 14, height: 14, background: "#cccccc" }} />
          <span style={{ color: "#666" }}>No data</span>
        </div>
      </div>

      {/* Recenter button */}
      <button
        onClick={() => {
          if (fullBounds.current) {
            map.current.fitBounds(fullBounds.current, { padding: 60, duration: 800 });
          }
          setSelected(null);
          map.current.setFilter("tracts-selected", ["==", "GEOID", ""]);
        }}
        style={{
          position: "absolute", top: 16, left: 16,
          background: "#fff", border: "none", borderRadius: 8,
          padding: "8px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer",
          boxShadow: "0 1px 4px rgba(0,0,0,0.2)", fontFamily: "system-ui, sans-serif",
        }}
      >
        ↺ Reset view
      </button>

      {selected && (
        <div
          style={{
            position: "absolute", top: 0, right: 0, bottom: 0, width: 320,
            background: "#fff", boxShadow: "-2px 0 8px rgba(0,0,0,0.15)",
            padding: "20px 24px", overflowY: "auto", fontFamily: "system-ui, sans-serif",
          }}
        >
          <button
            onClick={() => {
              setSelected(null);
              map.current.setFilter("tracts-selected", ["==", "GEOID", ""]);
            }}
            style={{ float: "right", border: "none", background: "none", fontSize: 20, cursor: "pointer" }}
          >×</button>

          <h2 style={{ margin: "0 0 4px", fontSize: 18 }}>
            Need score: {fmt(selected.need_score)}
          </h2>
          <p style={{ margin: "0 0 20px", color: "#666", fontSize: 13 }}>
            {selected.county_name} County · Tract {selected.GEOID}
          </p>

          <Stat label="Population" value={fmt(selected.total_pop)} note="ACS 2022" />
          <Stat label="Below poverty" value={fmt(selected.poverty_rate, "%")} note="vs ~13% nationally" />
          <Stat label="Receiving SNAP" value={fmt(selected.snap_rate, "%")} note="of households" />
          <Stat label="No vehicle" value={fmt(selected.no_vehicle_rate, "%")} note="of households" />
          <Stat
            label="Food desert"
            value={
              selected.food_desert === 1 || selected.food_desert === "1"
                ? "Yes"
                : selected.food_desert === 0 || selected.food_desert === "0"
                ? "No"
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
    </>
  );
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