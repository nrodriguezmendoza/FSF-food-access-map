import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

export default function App() {
  const mapContainer = useRef(null);
  const map = useRef(null);
  const [selected, setSelected] = useState(null);

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
    });

    map.current.on("load", () => {
      map.current.addSource("tracts", {
        type: "geojson",
        data: "/tracts_2022.geojson",
      });

      map.current.addLayer({
        id: "tracts-fill",
        type: "fill",
        source: "tracts",
        paint: {
          "fill-color": [
            "interpolate", ["linear"],
            ["coalesce", ["get", "need_score"], -1],
            -1,  "#cccccc",   // no data
            0,   "#fde725",   // yellow  — low need
            25,  "#5ec962",   // green
            50,  "#21918c",   // teal
            75,  "#3b528b",   // blue
            100, "#440154",   // purple  — high need
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
        const props = e.features[0].properties;
        setSelected(props);
        map.current.setFilter("tracts-selected", ["==", "GEOID", props.GEOID]);
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
        <div style={{ display: "flex", alignItems: "center", gap: 0 }}>
        {[
          ["#fde725", "0"],
          ["#5ec962", "25"],
          ["#21918c", "50"],
          ["#3b528b", "75"],
          ["#440154", "100"],
        ].map(([color]) => (
          <div key={color} style={{ width: 32, height: 14, background: color }} />
        ))}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
          <span>Lower need</span>
          <span>Higher need</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 10 }}>
          <div style={{ width: 14, height: 14, background: "#cccccc" }} />
          <span style={{ color: "#666" }}>No data</span>
        </div>
      </div>

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