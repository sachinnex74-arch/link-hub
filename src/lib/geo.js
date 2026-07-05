// Haversine distance in meters
export function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function distanceKm(lat1, lng1, lat2, lng2) {
  return distanceMeters(lat1, lng1, lat2, lng2) / 1000;
}

// Load/save helpers
const LS = {
  geofences: "tms.geofences",
  positions: "tms.gpsPositions",
  history: "tms.gpsHistory",
  alerts: "tms.geofenceAlerts",
  cursor: "tms.gpsCursor",
};

export const loadJSON = (k, fb) => {
  try {
    const v = localStorage.getItem(k);
    return v ? JSON.parse(v) : fb;
  } catch {
    return fb;
  }
};
export const saveJSON = (k, v) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {}
};

export const KEYS = LS;

// Normalize vehicle number for comparison: strip spaces/dashes/underscores, uppercase.
export function normalizeVnum(v) {
  return String(v || "").replace(/[\s\-_]/g, "").toUpperCase();
}

// Idle detection: returns alerts to raise/resolve
export function evaluateIdle({ positions, history, geofences, alerts, now = Date.now(), idleMs = 60 * 60 * 1000, moveThresholdM = 100 }) {
  const newAlerts = [...alerts];
  const byId = new Map(newAlerts.map((a) => [a.id, a]));

  for (const [vehicleId, pos] of Object.entries(positions)) {
    if (!pos || pos.lat == null || pos.lng == null) continue;
    const hist = (history[vehicleId] || []).filter((p) => now - p.t <= idleMs * 1.5);

    for (const g of geofences) {
      // Per-vehicle geofence: only evaluate against its target vehicle.
      if (g.vehicleNo && normalizeVnum(g.vehicleNo) !== normalizeVnum(vehicleId)) continue;
      const inside = distanceMeters(pos.lat, pos.lng, g.lat, g.lng) <= g.radiusKm * 1000;
      const alertId = `${vehicleId}__${g.id}`;
      const existing = byId.get(alertId);

      if (!inside) {
        if (existing && !existing.resolvedAt) {
          existing.resolvedAt = now;
          existing.resolveReason = "left geofence";
        }
        continue;
      }

      // Inside geofence — check if vehicle moved within idle window
      const cutoff = now - idleMs;
      const recent = hist.filter((p) => p.t >= cutoff);
      let movedRecently = false;
      for (const p of recent) {
        if (distanceMeters(p.lat, p.lng, pos.lat, pos.lng) > moveThresholdM) {
          movedRecently = true;
          break;
        }
      }

      // Use the OLDEST retained history point (within idleMs * 1.5 window) to
      // measure how long the vehicle has been sitting here. Using recent[0]
      // here was a bug: recent is filtered to p.t >= cutoff, so its oldest
      // point can never be older than idleMs and the alert never fired.
      const oldest = hist[0];
      const idleDuration = oldest ? now - oldest.t : 0;

      if (!movedRecently && idleDuration >= idleMs) {
        if (!existing) {
          newAlerts.push({
            id: alertId,
            vehicleId,
            geofenceId: g.id,
            geofenceLabel: g.label,
            startedAt: oldest.t,
            lastSeenAt: now,
            lat: pos.lat,
            lng: pos.lng,
          });
        } else if (!existing.resolvedAt) {
          existing.lastSeenAt = now;
        } else {
          // re-trigger
          newAlerts.push({
            id: `${alertId}__${now}`,
            vehicleId,
            geofenceId: g.id,
            geofenceLabel: g.label,
            startedAt: oldest.t,
            lastSeenAt: now,
            lat: pos.lat,
            lng: pos.lng,
          });
        }
      } else if (movedRecently && existing && !existing.resolvedAt) {
        existing.resolvedAt = now;
        existing.resolveReason = "vehicle moved";
      }
    }
  }
  return newAlerts;
}

export function appendHistory(history, vehicleId, point, maxAgeMs = 3 * 60 * 60 * 1000) {
  const now = Date.now();
  const arr = (history[vehicleId] || []).filter((p) => now - p.t <= maxAgeMs);
  arr.push(point);
  arr.sort((a, b) => a.t - b.t);
  return { ...history, [vehicleId]: arr };
}
