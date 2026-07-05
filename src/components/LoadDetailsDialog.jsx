import { Component, useEffect, useRef, useState } from "react";
import { MapContainer, TileLayer, Marker, Popup } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";
import { X, Upload, FileText, Receipt, ClipboardCheck, Trash2, Download, Clock } from "lucide-react";
import { getAttachments, setAttachment, removeAttachment, fileToDataUrl, addPOD, getPODs } from "@/lib/driverStore";
import { uploadAttachment } from "@/lib/supaSync";
import { getLoadAuditTrailFn } from "@/lib/tms.functions";
import { getLoadHalts } from "@/lib/gps.functions";

function fmtDur(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
function fmtTime(ms) {
  try { return new Date(ms).toLocaleString([], { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }); }
  catch { return "—"; }
}

// Trip halts — stops of 2h+ during THIS load's trip (load-scoped), incl. an ongoing one.
function TripHalts({ vnum, loadId }) {
  const [halts, setHalts] = useState(null);
  useEffect(() => {
    let alive = true;
    if (!vnum || !loadId) { setHalts([]); return; }
    getLoadHalts({ data: { vehicleNumber: vnum, loadId } })
      .then((r) => { if (alive) setHalts(r?.halts || []); })
      .catch(() => { if (alive) setHalts([]); });
    return () => { alive = false; };
  }, [vnum, loadId]);

  if (halts === null) return <div style={{fontSize:".72rem",color:"#9ca3af"}}>Loading stops…</div>;
  if (!halts.length) return <div style={{fontSize:".72rem",color:"#9ca3af"}}>No stops of 2h+ recorded for this trip.</div>;

  return (
    <div style={{display:"flex",flexDirection:"column",gap:".5rem"}}>
      {halts.map((h, i) => {
        const tier = h.durationSeconds >= 12*3600 ? {bg:"#fef2f2",fg:"#991b1b",label:"Long"}
                   : h.durationSeconds >= 5*3600  ? {bg:"#fff7ed",fg:"#9a3412",label:"Flag"}
                   : {bg:"#f8fafc",fg:"#334155",label:"Stop"};
        return (
          <div key={i} style={{display:"flex",alignItems:"center",gap:".6rem",padding:".55rem .7rem",background:tier.bg,borderRadius:8,border:"1px solid rgba(0,0,0,0.05)"}}>
            <span style={{fontSize:".62rem",fontWeight:700,color:tier.fg,textTransform:"uppercase",letterSpacing:.5,minWidth:42}}>{h.ongoing ? "Now" : tier.label}</span>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontSize:".8rem",fontWeight:600,color:"#0f172a"}}>{fmtDur(h.durationSeconds)}{h.ongoing ? " (ongoing)" : ""} · {h.address || "—"}</div>
              <div style={{fontSize:".68rem",color:"#64748b"}}>{fmtTime(h.startedAt)}{h.endedAt ? ` → ${fmtTime(h.endedAt)}` : " → now"}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ActivityTab({ loadId, vehicleId }) {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    getLoadAuditTrailFn({ data: { loadId, vehicleId: vehicleId || null } })
      .then(r => setEntries(r.entries || []))
      .catch(() => setEntries([]))
      .finally(() => setLoading(false));
  }, [loadId]);

  const actionLabel = (action) => {
    const map = {
      "load.create":        { label: "Created",         bg: "#dbeafe", fg: "#1e3a8a" },
      "load.assign":        { label: "Assigned",        bg: "#fef3c7", fg: "#92400e" },
      "load.unassign":      { label: "Unassigned",      bg: "#fde68a", fg: "#78350f" },
      "load.status_change": { label: "Status changed",  bg: "#e0e7ff", fg: "#3730a3" },
      "load.delivered":     { label: "Delivered",       bg: "#dcfce7", fg: "#166534" },
      "load.delete":        { label: "Deleted",         bg: "#fee2e2", fg: "#991b1b" },
      "vehicle.status_change": { label: "Vehicle status",  bg: "#f0f9ff", fg: "#0369a1" },
      "vehicle.driver_change": { label: "Driver changed",  bg: "#faf5ff", fg: "#7e22ce" },
    };
    return map[action] || { label: action, bg: "#e2e8f0", fg: "#334155" };
  };

  const detailText = (e) => {
    const d = e.details || {};
    switch (e.action) {
      case "load.assign":        return `→ ${d.vnum || d.vehicleId || "—"}`;
      case "load.unassign":      return `from ${d.vnum || d.vehicleId || "—"}`;
      case "load.status_change": return `${d.from || "—"} → ${d.to || "—"}`;
      case "load.delivered":     return d.vnum ? `vehicle ${d.vnum}` : "";
      case "load.create":        return [d.origin, d.dest].filter(Boolean).join(" → ");
      case "vehicle.status_change": return `${d.from || "—"} → ${d.to || "—"}`;
      case "vehicle.driver_change": return `Driver: ${d.from || "—"} → ${d.to || "—"}`;
      default: return "";
    }
  };

  if (loading) return <div style={{padding:"1rem",color:"#9ca3af",fontSize:".82rem"}}>Loading activity…</div>;
  if (!entries.length) return <div style={{padding:"1rem",color:"#9ca3af",fontSize:".82rem"}}>No activity recorded for this load yet.</div>;

  return (
    <div style={{display:"flex",flexDirection:"column",gap:0}}>
      {entries.map((e, i) => {
        const chip = actionLabel(e.action);
        const isLast = i === entries.length - 1;
        return (
          <div key={e.id} style={{display:"flex",gap:"0.75rem",paddingBottom: isLast ? 0 : "0.75rem",position:"relative"}}>
            {!isLast && <div style={{position:"absolute",left:14,top:28,bottom:0,width:1,background:"#e5e7eb"}}/>}
            <div style={{width:28,height:28,borderRadius:"50%",background:chip.bg,border:`1px solid ${chip.fg}30`,flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center",zIndex:1}}>
              <Clock size={13} color={chip.fg}/>
            </div>
            <div style={{flex:1,paddingTop:4}}>
              <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                <span style={{display:"inline-block",padding:"2px 8px",borderRadius:999,fontSize:11,fontWeight:600,background:chip.bg,color:chip.fg}}>{chip.label}</span>
                {detailText(e) && <span style={{fontSize:".78rem",color:"#374151"}}>{detailText(e)}</span>}
              </div>
              <div style={{fontSize:".72rem",color:"#9ca3af",marginTop:3}}>
                {new Date(e.at).toLocaleString("en-IN",{dateStyle:"medium",timeStyle:"short"})}
                {e.email && <span style={{marginLeft:6,color:"#64748b"}}>· {e.email}</span>}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// @ts-ignore
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
});

// Reliable Leaflet inside a modal: invalidateSize after mount + on resize,
// re-center when coords change. Without this, the map renders blank because
// Leaflet measured a 0-sized / animating container on first mount.
function VehicleMap({ lat, lng, vnum, address }) {
  const mapRef = useRef(null);
  const wrapRef = useRef(null);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const kick = () => {
      try {
        map.invalidateSize();
        map.eachLayer(l => { if (l instanceof L.TileLayer) { try { l.redraw(); } catch {} } });
      } catch {}
    };
    kick();
    const r = requestAnimationFrame(kick);
    const t1 = setTimeout(kick, 150);
    const t2 = setTimeout(kick, 400);
    const t3 = setTimeout(kick, 900);
    let ro;
    if (wrapRef.current && typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(kick);
      ro.observe(wrapRef.current);
    }
    window.addEventListener("resize", kick);
    window.addEventListener("orientationchange", kick);
    return () => {
      cancelAnimationFrame(r);
      clearTimeout(t1); clearTimeout(t2); clearTimeout(t3);
      if (ro) ro.disconnect();
      window.removeEventListener("resize", kick);
      window.removeEventListener("orientationchange", kick);
    };
  }, []);

  // Recenter when lat/lng change (dialog reused for a different load).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || lat == null || lng == null) return;
    try { map.setView([lat, lng], map.getZoom() || 11); map.invalidateSize(); } catch {}
  }, [lat, lng]);

  return (
    <div ref={wrapRef} style={{width:"100%",height:"100%",overflow:"hidden"}}>
      <MapContainer
        center={[lat, lng]}
        zoom={11}
        style={{width:"100%",height:"100%"}}
        scrollWheelZoom
        ref={mapRef}
        whenReady={() => {
          const map = mapRef.current;
          if (!map) return;
          try {
            map.invalidateSize();
            map.eachLayer(l => { if (l instanceof L.TileLayer) { try { l.redraw(); } catch {} } });
          } catch {}
        }}
      >
        <TileLayer
          attribution='&copy; OpenStreetMap'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          keepBuffer={4}
        />
        <Marker position={[lat, lng]}>
          <Popup>{vnum || "Vehicle"}<br/>{address || `${lat.toFixed(4)}, ${lng.toFixed(4)}`}</Popup>
        </Marker>
      </MapContainer>
    </div>
  );
}

const fmt = (d) => {
  if (!d) return "—";
  try { const x = new Date(d); if (isNaN(x.getTime())) return d; return x.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }); }
  catch { return d; }
};

const palettes = {
  blue:   { bg: "#eff6ff", bd: "#bfdbfe", fg: "#1d4ed8", lbl: "#1e3a8a" },
  amber:  { bg: "#fffbeb", bd: "#fde68a", fg: "#b45309", lbl: "#78350f" },
  violet: { bg: "#f5f3ff", bd: "#ddd6fe", fg: "#6d28d9", lbl: "#4c1d95" },
  teal:   { bg: "#ecfeff", bd: "#a5f3fc", fg: "#0e7490", lbl: "#155e75" },
};

function DateBox({ label, value, palette }) {
  return (
    <div style={{background:palette.bg,border:`1px solid ${palette.bd}`,borderRadius:10,padding:"1rem 1.1rem",minHeight:96,display:"flex",flexDirection:"column",justifyContent:"space-between"}}>
      <div style={{fontSize:".66rem",fontWeight:800,letterSpacing:1.5,color:palette.lbl,textTransform:"uppercase",fontFamily:"var(--font-head,monospace)"}}>{label}</div>
      <div style={{fontFamily:"var(--font-mono,monospace)",fontSize:"1.05rem",fontWeight:700,color:palette.fg,marginTop:".4rem",wordBreak:"break-word"}}>{value || "—"}</div>
    </div>
  );
}

// Isolates the Leaflet map: if it fails to render (e.g. a map library element
// resolves to undefined in a given build), the dialog still shows everything
// else (POD photos, documents) instead of crashing the whole page.
class MapBoundary extends Component {
  constructor(p) { super(p); this.state = { failed: false }; }
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() {}
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

function UploadCard({ icon: Icon, label, current, onPick, onRemove, readOnly, preview }) {
  const ref = useRef(null);
  const isPdf = preview && /\.pdf(\?|$)/i.test(preview.name || preview.url || "");
  // Images are no longer stored as base64 in localStorage — only the Storage
  // `path` is kept. Resolve a signed URL on demand for the View/Download link.
  const [fileUrl, setFileUrl] = useState(current?.dataUrl || null);
  useEffect(() => {
    let cancelled = false;
    const local = current?.dataUrl || null;
    if (local) { setFileUrl(local); return; }
    const path = current?.path || null;
    if (!path) { setFileUrl(null); return; }
    (async () => {
      try {
        const { resolveSignedUrl } = await import("@/lib/supaSync");
        const u = await resolveSignedUrl(path);
        if (!cancelled) setFileUrl(u || null);
      } catch { if (!cancelled) setFileUrl(null); }
    })();
    return () => { cancelled = true; };
  }, [current?.path, current?.dataUrl]);
  return (
    <div style={{border:"1px solid #e5e7eb",borderRadius:10,padding:".85rem",background:"#fff",display:"flex",flexDirection:"column",gap:".5rem"}}>
      <div style={{display:"flex",alignItems:"center",gap:".5rem"}}>
        <Icon size={16} color="#2563eb" />
        <div style={{fontWeight:700,fontSize:".82rem",color:"#1f2937"}}>{label}</div>
      </div>
      {preview && !isPdf && (
        <a href={preview.url} target="_blank" rel="noreferrer" title="View POD photo" style={{lineHeight:0}}>
          <img src={preview.url} alt={label} style={{width:"100%",maxHeight:170,objectFit:"cover",borderRadius:8,border:"1px solid #d1d5db",display:"block"}} />
        </a>
      )}
      {current ? (
        <div style={{display:"flex",flexDirection:"column",gap:".4rem"}}>
          <div style={{fontSize:".72rem",color:"#374151",wordBreak:"break-all"}}>📎 {current.name}</div>
          <div style={{fontSize:".66rem",color:"#6b7280"}}>Uploaded {fmt(current.uploadedAt)}</div>
          <div style={{display:"flex",gap:".4rem",flexWrap:"wrap"}}>
            {fileUrl ? (
              <a href={fileUrl} target="_blank" rel="noreferrer" download={current.name} style={{display:"inline-flex",alignItems:"center",gap:4,background:"#eff6ff",border:"1px solid #bfdbfe",color:"#1d4ed8",padding:"4px 8px",borderRadius:5,fontSize:".7rem",fontWeight:700,textDecoration:"none"}}><Download size={12}/> View / Download</a>
            ) : (
              <span style={{display:"inline-flex",alignItems:"center",gap:4,color:"#9ca3af",padding:"4px 8px",fontSize:".7rem",fontWeight:700}}>Loading…</span>
            )}
            {!readOnly && (
              <button onClick={onRemove} style={{display:"inline-flex",alignItems:"center",gap:4,background:"#fef2f2",border:"1px solid #fecaca",color:"#b91c1c",padding:"4px 8px",borderRadius:5,fontSize:".7rem",fontWeight:700,cursor:"pointer"}}><Trash2 size={12}/> Remove</button>
            )}
            {!readOnly && (
              <button onClick={()=>ref.current?.click()} style={{display:"inline-flex",alignItems:"center",gap:4,background:"#f3f4f6",border:"1px solid #d1d5db",color:"#1f2937",padding:"4px 8px",borderRadius:5,fontSize:".7rem",fontWeight:700,cursor:"pointer"}}><Upload size={12}/> Replace</button>
            )}
          </div>
        </div>
      ) : preview ? (
        <div style={{display:"flex",gap:".4rem",flexWrap:"wrap"}}>
          <a href={preview.url} target="_blank" rel="noreferrer" style={{display:"inline-flex",alignItems:"center",gap:4,background:"#eff6ff",border:"1px solid #bfdbfe",color:"#1d4ed8",padding:"4px 8px",borderRadius:5,fontSize:".7rem",fontWeight:700,textDecoration:"none"}}>{isPdf ? <><FileText size={12}/> View POD PDF</> : <><Download size={12}/> View full image</>}</a>
          {!readOnly && (
            <button onClick={()=>ref.current?.click()} style={{display:"inline-flex",alignItems:"center",gap:4,background:"#f3f4f6",border:"1px solid #d1d5db",color:"#1f2937",padding:"4px 8px",borderRadius:5,fontSize:".7rem",fontWeight:700,cursor:"pointer"}}><Upload size={12}/> Replace</button>
          )}
        </div>
      ) : readOnly ? (
        <div style={{fontSize:".75rem",color:"#9ca3af",fontStyle:"italic"}}>No file uploaded</div>
      ) : (
        <button onClick={()=>ref.current?.click()} style={{display:"inline-flex",alignItems:"center",justifyContent:"center",gap:6,background:"#2563eb",border:"none",color:"#fff",padding:"8px 12px",borderRadius:6,fontSize:".78rem",fontWeight:700,cursor:"pointer"}}><Upload size={14}/> Upload</button>
      )}
      <input ref={ref} type="file" accept="image/*,application/pdf" style={{display:"none"}} onChange={(e)=>{ const f=e.target.files?.[0]; if(f) Promise.resolve(onPick(f)).catch(err => alert("Upload failed: " + (err?.message || err))); e.target.value=""; }} />
    </div>
  );
}

export default function LoadDetailsDialog({ load, vehicle, gps, eta, targetDelivery, etaComputed, onClose, readOnly = false }) {
  const [attach, setAttach] = useState(() => getAttachments(load.id));

  useEffect(() => { setAttach(getAttachments(load.id)); }, [load.id]);

  // Latest synced POD record per consignee index for THIS load (incl. to-city).
  // Per-consignee PODs are uploaded on the driver's device, so they arrive here
  // as synced pod_records tagged with consigneeIndex + a storage path.
  const consigneePods = (() => {
    const out = {};
    for (const p of (getPODs() || [])) {
      if (p?.loadId !== load.id) continue;
      if (p?.consigneeIndex == null) continue;
      const i = p.consigneeIndex;
      const prev = out[i];
      if (!prev || new Date(p.at || 0) > new Date(prev.at || 0)) out[i] = p;
    }
    return out;
  })();
  // Latest synced "main" POD (single-consignee / plain loads — no consigneeIndex).
  const mainPodRec = (() => {
    let best = null;
    for (const p of (getPODs() || [])) {
      if (p?.loadId !== load.id) continue;
      if (p?.consigneeIndex != null) continue;
      if (!best || new Date(p.at || 0) > new Date(best.at || 0)) best = p;
    }
    return best;
  })();
  const cPodKey = Object.entries(consigneePods)
    .map(([i, p]) => `${i}:${p.path || (p.dataUrl ? "d" : "")}`).join(",")
    + `|main:${mainPodRec?.path || (mainPodRec?.dataUrl ? "d" : "")}`;

  const [cPodUrls, setCPodUrls] = useState({}); // consigneeIndex (or "main") -> viewable image url
  // The dialog instance is reused across loads, so reset resolved URLs when the
  // load changes — otherwise a previous load's photo can linger in this one.
  useEffect(() => { setCPodUrls({}); }, [load.id]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const entries = Object.entries(consigneePods);
      if (mainPodRec) entries.push(["main", mainPodRec]);
      if (!entries.length) return;
      const updates = {};
      const needSigned = [];
      for (const [i, p] of entries) {
        const localKey = i === "main" ? "pod" : `pod_c${i}`;
        const local = p?.dataUrl || getAttachments(load.id)?.[localKey]?.dataUrl || null;
        if (local) updates[i] = { url: local, name: p?.name || "" };
        else if (p?.path) needSigned.push([i, p.path, p?.name || ""]);
      }
      if (needSigned.length) {
        try {
          const { resolveSignedUrl } = await import("@/lib/supaSync");
          for (const [i, path, name] of needSigned) {
            try { const url = await resolveSignedUrl(path); if (url) updates[i] = { url, name }; } catch {}
          }
        } catch {}
      }
      if (!cancelled && Object.keys(updates).length) setCPodUrls(prev => ({ ...prev, ...updates }));
    })();
    return () => { cancelled = true; };
  }, [load.id, cPodKey]);

  const pickFile = async (kind, file) => {
    const data = await fileToDataUrl(file);
    const uploaded = await uploadAttachment(load.id, kind, file);
    const path = uploaded?.path || null;
    if (!path) throw new Error("File upload did not return a cloud storage path. Please try again.");
    setAttachment(load.id, kind, { ...data, path });
    if (kind === "pod") {
      addPOD({
        vnum: vehicle?.vnum,
        driver: vehicle?.driver,
        mobile: vehicle?.mobile,
        customer: load.customer || vehicle?.customer || "—",
        loadId: load.id,
        lid: load.lid || null,
        origin: load.origin || null,
        dest: load.dest || null,
        dataUrl: data.dataUrl,
        path,
        name: data.name,
        at: data.uploadedAt || new Date().toISOString(),
        status: "OK",
      });
    }
    setAttach(getAttachments(load.id));
  };
  const remove = (kind) => { removeAttachment(load.id, kind); setAttach(getAttachments(load.id)); };

  const lat = gps?.lat;
  const lng = gps?.lng;
  const hasCoord = lat != null && lng != null;

  return (
    <div onClick={onClose} style={{position:"fixed",inset:0,background:"rgba(15,23,42,0.55)",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",padding:"1rem",overflowY:"auto"}}>
      <div onClick={e=>e.stopPropagation()} style={{background:"#fff",borderRadius:12,maxWidth:1100,width:"100%",maxHeight:"94vh",overflowY:"auto",boxShadow:"0 30px 80px rgba(0,0,0,0.35)"}}>
        {/* Header */}
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"1rem 1.4rem",borderBottom:"1px solid #e5e7eb",background:"linear-gradient(90deg,#1e3a8a,#2563eb)",borderRadius:"12px 12px 0 0",position:"sticky",top:0,zIndex:1}}>
          <div>
            <div style={{fontSize:".7rem",letterSpacing:2,fontWeight:700,color:"rgba(255,255,255,0.8)",textTransform:"uppercase"}}>Load Details</div>
            <div style={{fontSize:"1.1rem",fontWeight:800,color:"#fff",fontFamily:"var(--font-mono,monospace)"}}>{load.lid}</div>
          </div>
          <button onClick={onClose} style={{background:"rgba(255,255,255,0.15)",border:"1px solid rgba(255,255,255,0.3)",color:"#fff",padding:"6px",borderRadius:6,cursor:"pointer",display:"flex"}}><X size={18}/></button>
        </div>

        <div style={{padding:"1.2rem 1.4rem",display:"flex",flexDirection:"column",gap:"1.2rem"}}>
          {/* 4 big date boxes */}
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))",gap:".8rem"}}>
            <DateBox label="Pickup Date"   value={fmt(load.pickup)}                  palette={palettes.blue} />
            <DateBox label="LR Date"       value={fmt(load.lrDate || vehicle?.lrDate)} palette={palettes.amber} />
            <DateBox label="Targeted Delivery" value={fmt(targetDelivery || load.delivery)} palette={palettes.violet} />
            <DateBox label="ETA"           value={fmt(etaComputed || eta || vehicle?.eta)}           palette={palettes.teal} />
          </div>

          {/* Two columns: details + map */}
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(260px,1fr))",gap:"1rem"}}>
            {/* Details */}
            <div style={{border:"1px solid #e5e7eb",borderRadius:10,padding:"1rem",background:"#f9fafb"}}>
              <div style={{fontSize:".72rem",fontWeight:800,letterSpacing:1.5,color:"#1f2937",textTransform:"uppercase",marginBottom:".7rem"}}>Load Information</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:".55rem .8rem",fontSize:".78rem"}}>
                <Field k="Customer" v={load.customer} />
                <Field k="Branch" v={load.branch} />
                <Field k="Origin" v={load.origin} full />
                <Field k="Destination" v={load.dest} full />
                <Field k="Commodity" v={load.commodity} />
                <Field k="Weight" v={load.weight} />
                <Field k="Volume" v={load.volume} />
                <Field k="Priority" v={load.priority} />
                <Field k="Vehicle Type Required" v={load.vtypeReq} full />
                <Field k="Vehicle Assigned" v={vehicle?.vnum} />
                <Field k="Driver" v={vehicle?.driver} />
                <Field k="Driver Mobile" v={vehicle?.mobile} />
                {load.notes && <Field k="Notes" v={load.notes} full />}
              </div>
            </div>

            {/* Map */}
            <div style={{border:"1px solid #e5e7eb",borderRadius:10,overflow:"hidden",background:"#f9fafb",display:"flex",flexDirection:"column"}}>
              <div style={{padding:".7rem 1rem",fontSize:".72rem",fontWeight:800,letterSpacing:1.5,color:"#1f2937",textTransform:"uppercase",borderBottom:"1px solid #e5e7eb",background:"#fff"}}>Vehicle Location {gps?.address && <span style={{fontWeight:500,textTransform:"none",letterSpacing:0,color:"#6b7280",marginLeft:6}}>· {gps.address}</span>}</div>
              <div style={{height:"clamp(220px, 38vh, 320px)"}}>
                <MapBoundary fallback={<div style={{height:"100%",display:"flex",alignItems:"center",justifyContent:"center",color:"#9ca3af",fontSize:".82rem",padding:"1rem",textAlign:"center"}}>Map unavailable</div>}>
                {hasCoord ? (
                  <VehicleMap
                    key={`${lat},${lng}`}
                    lat={lat}
                    lng={lng}
                    vnum={vehicle?.vnum}
                    address={gps?.address}
                  />
                ) : (
                  <div style={{height:"100%",display:"flex",alignItems:"center",justifyContent:"center",color:"#9ca3af",fontSize:".82rem",padding:"1rem",textAlign:"center"}}>No live GPS location available for this vehicle</div>
                )}
                </MapBoundary>
              </div>
            </div>
          </div>


          {/* Consignee deliveries */}
          {(() => {
            if ((load.consignees||[]).length < 1) return null;
            const cdArr = Array.isArray(load.consigneeDeliveries) ? load.consigneeDeliveries : [];
            const cds = [...load.consignees, load.dest].filter(Boolean).map((city,idx)=>({ city, delivered: !!cdArr[idx]?.delivered || !!consigneePods[idx], deliveredAt: cdArr[idx]?.deliveredAt }));
            const done = cds.filter(x=>x.delivered).length;
            return (
              <div>
                <div style={{fontSize:".72rem",fontWeight:800,letterSpacing:1.5,color:"#1f2937",textTransform:"uppercase",marginBottom:".6rem"}}>Consignee Deliveries ({done}/{cds.length})</div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(200px,1fr))",gap:".5rem"}}>
                  {cds.map((cd,i)=>{
                    const pod = consigneePods[i] ? cPodUrls[i] : undefined;
                    const isPdf = pod && /\.pdf(\?|$)/i.test(pod.name || pod.url || "");
                    return (
                    <div key={i} style={{display:"flex",alignItems:"center",gap:8,border:"1px solid",borderColor: cd.delivered ? "#86efac" : "#e5e7eb",background: cd.delivered ? "#f0fdf4" : "#f9fafb",borderRadius:8,padding:".55rem .7rem"}}>
                      <span style={{width:18,height:18,borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",background: cd.delivered ? "#16a34a" : "#d1d5db",color:"#fff",fontSize:".7rem",fontWeight:900,flexShrink:0}}>{cd.delivered ? "✓" : (i+1)}</span>
                      <div style={{minWidth:0,flex:1}}>
                        <div style={{fontSize:".82rem",fontWeight:700,color:"#1f2937",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{cd.city || `Consignee ${i+1}`}</div>
                        <div style={{fontSize:".66rem",fontWeight:700,color: cd.delivered ? "#15803d" : "#9ca3af"}}>{cd.delivered ? "Delivered" : "Pending"}{cd.delivered && cd.deliveredAt ? ` · ${fmt(cd.deliveredAt)}` : ""}</div>
                      </div>
                      {pod && (isPdf ? (
                        <a href={pod.url} target="_blank" rel="noreferrer" style={{flexShrink:0,display:"inline-flex",alignItems:"center",gap:4,background:"#eff6ff",border:"1px solid #bfdbfe",color:"#1d4ed8",padding:"4px 8px",borderRadius:6,fontSize:".68rem",fontWeight:700,textDecoration:"none"}}><FileText size={12}/> POD</a>
                      ) : (
                        <a href={pod.url} target="_blank" rel="noreferrer" title="View POD photo" style={{flexShrink:0,lineHeight:0}}>
                          <img src={pod.url} alt="POD" style={{width:44,height:44,objectFit:"cover",borderRadius:6,border:"1px solid #d1d5db",display:"block"}} />
                        </a>
                      ))}
                    </div>
                  );})}
                </div>
              </div>
            );
          })()}

          {/* Documents */}
          <div>
            <div style={{fontSize:".72rem",fontWeight:800,letterSpacing:1.5,color:"#1f2937",textTransform:"uppercase",marginBottom:".6rem"}}>Documents</div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(220px,1fr))",gap:".7rem"}}>
              <UploadCard icon={FileText} label="LR (Lorry Receipt)" current={attach.lr} onPick={(f)=>pickFile("lr",f)} onRemove={()=>remove("lr")} readOnly={readOnly} />
              <UploadCard icon={Receipt}  label="Consignee Invoice"  current={attach.invoice} onPick={(f)=>pickFile("invoice",f)} onRemove={()=>remove("invoice")} readOnly={readOnly} />
              <UploadCard icon={ClipboardCheck} label="POD (Proof of Delivery)" current={attach.pod} preview={mainPodRec ? cPodUrls.main : undefined} onPick={(f)=>pickFile("pod",f)} onRemove={()=>remove("pod")} readOnly={readOnly} />
            </div>
            <div style={{fontSize:".66rem",color:"#9ca3af",marginTop:".5rem"}}>Files are stored locally in this browser. Images and PDFs supported.</div>
          </div>

          {/* Trip halts (2h+ stops during this trip) */}
          <div style={{marginBottom:"1.25rem"}}>
            <div style={{fontSize:".72rem",fontWeight:800,letterSpacing:1.5,color:"#1f2937",textTransform:"uppercase",marginBottom:".75rem"}}>Trip stops (2h+)</div>
            <TripHalts vnum={vehicle?.vnum || load?.vnum || null} loadId={load.id} />
          </div>

          {/* Activity trail */}
          <div>
            <div style={{fontSize:".72rem",fontWeight:800,letterSpacing:1.5,color:"#1f2937",textTransform:"uppercase",marginBottom:".75rem"}}>Activity trail</div>
            <ActivityTab loadId={load.id} vehicleId={load.vehicleId || null} />
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ k, v, full }) {
  return (
    <div style={{gridColumn: full ? "1 / -1" : "auto"}}>
      <div style={{fontSize:".62rem",fontWeight:700,letterSpacing:1.2,color:"#6b7280",textTransform:"uppercase"}}>{k}</div>
      <div style={{fontSize:".82rem",color:"#1f2937",fontWeight:500,marginTop:2,wordBreak:"break-word"}}>{v || <span style={{color:"#cbd5e1"}}>—</span>}</div>
    </div>
  );
}
