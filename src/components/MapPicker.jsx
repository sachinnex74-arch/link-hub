import { useEffect } from "react";
import { MapContainer, TileLayer, Marker, Circle, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

// Use CDN-hosted icons to avoid Vite asset import issues
const iconBase = "https://unpkg.com/leaflet@1.9.4/dist/images";
// @ts-ignore
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: `${iconBase}/marker-icon-2x.png`,
  iconUrl: `${iconBase}/marker-icon.png`,
  shadowUrl: `${iconBase}/marker-shadow.png`,
});

function ClickHandler({ onPick }) {
  useMapEvents({
    click(e) { onPick(e.latlng.lat, e.latlng.lng); },
  });
  return null;
}

function Recenter({ lat, lng }) {
  const map = useMap();
  useEffect(() => {
    if (lat != null && lng != null) map.setView([lat, lng], map.getZoom());
  }, [lat, lng]); // eslint-disable-line
  return null;
}

export default function MapPicker({ lat, lng, radiusKm, onPick, height = 320 }) {
  const center = [lat ?? 22.5, lng ?? 79];
  const zoom = lat != null ? 11 : 5;
  return (
    <div style={{ width: "100%", height, borderRadius: 6, overflow: "hidden", border: "1px solid var(--border)" }}>
      <MapContainer center={center} zoom={zoom} style={{ width: "100%", height: "100%" }} scrollWheelZoom>
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <ClickHandler onPick={onPick} />
        {lat != null && lng != null && (
          <>
            <Recenter lat={lat} lng={lng} />
            <Marker
              position={[lat, lng]}
              draggable
              eventHandlers={{
                dragend: (e) => {
                  const p = e.target.getLatLng();
                  onPick(p.lat, p.lng);
                },
              }}
            />
            <Circle center={[lat, lng]} radius={(radiusKm || 1) * 1000} pathOptions={{ color: "#dc2626", fillColor: "#dc2626", fillOpacity: 0.12 }} />
          </>
        )}
      </MapContainer>
    </div>
  );
}
