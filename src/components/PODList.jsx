import { useEffect, useMemo, useState } from "react";
import { getPODs, updatePOD, deletePOD, getSOS, getVehicles, getLoads, getAttachments } from "@/lib/driverStore";
import { Check, X, Trash2, Download, AlertTriangle, Search, RotateCcw, FileDown, RefreshCw, Eye, Info, Loader2 } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { listPODsByRange } from "@/lib/tms.functions";
import { PrettyDate } from "./PrettyDatePicker";

// Window of recent data kept in localStorage (matches pullAll/pullDelta).
const RECENT_WINDOW_DAYS = 90;
function recentCutoffYmd() {
  const d = new Date();
  d.setDate(d.getDate() - RECENT_WINDOW_DAYS);
  return d.toISOString().slice(0, 10);
}

const fmt = (d) => {
  if (!d) return "—";
  try { return new Date(d).toLocaleString("en-IN",{dateStyle:"medium",timeStyle:"short"}); }
  catch { return d; }
};

const ymdLocal = (d) => {
  const dt = new Date(d);
  if (isNaN(dt)) return "";
  const y = dt.getFullYear();
  const m = String(dt.getMonth()+1).padStart(2,"0");
  const day = String(dt.getDate()).padStart(2,"0");
  return `${y}-${m}-${day}`;
};

const PRESETS = [
  { key:"today",   label:"Today" },
  { key:"7d",      label:"Last 7 days" },
  { key:"30d",     label:"Last 30 days" },
  { key:"month",   label:"This month" },
];

function presetRange(key) {
  const now = new Date();
  const today = ymdLocal(now);
  if (key === "today") return { from: today, to: today };
  if (key === "7d") { const d = new Date(now); d.setDate(d.getDate()-6); return { from: ymdLocal(d), to: today }; }
  if (key === "30d") { const d = new Date(now); d.setDate(d.getDate()-29); return { from: ymdLocal(d), to: today }; }
  if (key === "month") { const d = new Date(now.getFullYear(), now.getMonth(), 1); return { from: ymdLocal(d), to: today }; }
  return { from: "", to: "" };
}

export default function PODList() {
  const [pods, setPods] = useState([]);
  const [sos, setSos] = useState([]);
  const [tmsVehicles, setTmsVehicles] = useState([]);
  const [tmsLoads, setTmsLoads] = useState([]);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [customer, setCustomer] = useState("");
  const [vehicle, setVehicle] = useState("");
  const [driver, setDriver] = useState("");
  const [status, setStatusFilter] = useState(""); // "", OK, NOT
  const [q, setQ] = useState("");
  const [sort, setSort] = useState("new"); // new | old | vehicle | customer
  const [preview, setPreview] = useState(null);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  // On-demand: nothing is fetched for a POD until the user taps "View POD".
  // Then we use a local copy if present, else mint a full-size signed URL once.
  useEffect(() => {
    let cancelled = false;
    setPreviewUrl(null);
    setPreviewLoading(false);
    if (!preview) return;
    const localFull = (typeof preview.dataUrl === "string" && preview.dataUrl.startsWith("data:")) ? preview.dataUrl : null;
    if (localFull) { setPreviewUrl(localFull); return; }
    if (!preview.path) { setPreviewUrl(preview.dataUrl || null); return; }
    setPreviewLoading(true);
    (async () => {
      try {
        const { resolveSignedUrl } = await import("@/lib/supaSync");
        const url = await resolveSignedUrl(preview.path); // no width = full size
        if (!cancelled) setPreviewUrl(url || preview.dataUrl || null);
      } catch { if (!cancelled) setPreviewUrl(preview.dataUrl || null); }
      finally { if (!cancelled) setPreviewLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [preview]);

  const [syncing, setSyncing] = useState(false);

  const refresh = () => {
    const loads = getLoads() || [];
    const vehicles = getVehicles() || [];
    const savedPods = getPODs() || [];
    const savedByLoad = new Set(savedPods.map(p => p?.loadId).filter(Boolean).map(String));
    const attachmentPods = loads
      .map(l => ({ load: l, pod: getAttachments(l.id)?.pod }))
      .filter(({ load, pod }) => load?.id && pod && !savedByLoad.has(String(load.id)))
      .map(({ load, pod }) => {
        const veh = vehicles.find(v => v?.id === load.vehicleId || (load.vnum && String(v?.vnum).toUpperCase() === String(load.vnum).toUpperCase()));
        return {
          id: `attach_pod_${load.id}`,
          vnum: veh?.vnum || load.vnum || null,
          driver: veh?.driver || load.driver || null,
          mobile: veh?.mobile || load.mobile || null,
          loadId: load.id,
          lid: load.lid || null,
          customer: load.customer || veh?.customer || "—",
          origin: load.origin || null,
          dest: load.dest || null,
          dataUrl: pod.dataUrl,
          path: pod.path || null,
          name: pod.name,
          at: pod.uploadedAt || load.deliveredAt || new Date().toISOString(),
          status: "OK",
        };
      });
    const visiblePods = savedPods.filter(p => p?.dataUrl || p?.path || p?.loadId || p?.lid || p?.vnum || p?.driver || p?.customer || p?.at);
    // Backfill a missing `path`/`dataUrl` on saved POD rows from the per-load
    // attachment store (single `pod` or per-consignee `pod_c{index}`), so the
    // "View POD" button appears for any record that has a stored file somewhere,
    // regardless of whether its load is still assigned to a vehicle.
    const withPaths = visiblePods.map(p => {
      if (p.path || !p.loadId) return p;
      const at = getAttachments(p.loadId) || {};
      const kind = (p.consigneeIndex != null) ? `pod_c${p.consigneeIndex}` : "pod";
      const src = at?.[kind] || at?.pod || null;
      if (src && (src.path || src.dataUrl)) {
        return { ...p, path: p.path || src.path || null, dataUrl: p.dataUrl || src.dataUrl || null };
      }
      return p;
    });
    setPods([...attachmentPods, ...withPaths]);

    setSos(getSOS());
    setTmsVehicles(vehicles);
    setTmsLoads(loads);
  };

  // Manual refresh: force a cloud pull (bypassing the throttle) and re-read the
  // latest POD records locally. Photos themselves load on demand via "View POD".
  const resyncPhotos = async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      const m = await import("@/lib/supaSync");
      await m.refreshFromCloud?.(0).catch(() => {});
      refresh();
    } finally {
      setTimeout(() => setSyncing(false), 600);
    }
  };
  useEffect(() => {
    refresh();
    const onSync = () => refresh();
    const cloudRefresh = () => {
      import("@/lib/supaSync").then(m => m.refreshFromCloud?.().catch(() => {}));
    };
    const onVisible = () => { if (document.visibilityState === "visible") cloudRefresh(); };
    window.addEventListener("tms:sync", onSync);
    document.addEventListener("visibilitychange", onVisible);
    const tLocal = setInterval(refresh, 3000);
    const tCloud = setInterval(cloudRefresh, 15000);
    // Kick off an immediate cloud refresh on mount so a freshly-opened POD
    // page always starts from the latest server snapshot.
    cloudRefresh();
    return () => {
      window.removeEventListener("tms:sync", onSync);
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(tLocal);
      clearInterval(tCloud);
    };
  }, []);

  // Hybrid range: when From date is older than the recent window, fetch the
  // exact From/To range from the server. Result replaces the visible list.
  const cutoff = recentCutoffYmd();
  const needsServerFetch = !!(from && to && from < cutoff);
  const fetchRange = useServerFn(listPODsByRange);
  const rangeQuery = useQuery({
    queryKey: ["podRange", from, to],
    queryFn: () => fetchRange({ data: { from, to } }),
    enabled: needsServerFetch,
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  });

  // Enrich each POD with its load + vehicle so vehicle #, driver, customer,
  // and load # are populated even when the POD record was saved without them.
  const enrichedPods = useMemo(() => {
    if (needsServerFetch) {
      // Server already enriched these from the loads table; just normalize.
      return (rangeQuery.data?.pods ?? []).map(p => ({ ...p, dataUrl: p.dataUrl || null }));
    }
    const byId = new Map();
    const byLid = new Map();
    for (const l of tmsLoads) {
      if (l?.id) byId.set(String(l.id), l);
      if (l?.lid) byLid.set(String(l.lid).toUpperCase(), l);
    }
    const vById = new Map();
    const vByVnum = new Map();
    for (const v of tmsVehicles) {
      if (v?.id) vById.set(String(v.id), v);
      if (v?.vnum) vByVnum.set(String(v.vnum).toUpperCase(), v);
    }
    // Clip cached PODs to the 90-day window so the banner is truthful.
    const clipped = pods.filter(p => !p.at || ymdLocal(p.at) >= cutoff);
    return clipped.map(p => {
      const ld = (p.loadId && byId.get(String(p.loadId)))
        || (p.lid && byLid.get(String(p.lid).toUpperCase()))
        || null;
      const veh = (ld?.vehicleId && vById.get(String(ld.vehicleId)))
        || (p.vnum && vByVnum.get(String(p.vnum).toUpperCase()))
        || (ld?.vnum && vByVnum.get(String(ld.vnum).toUpperCase()))
        || null;
      // A local copy (POD record's own dataUrl, or the per-load attachment store)
      // is used for instant preview when present. Otherwise the photo is fetched
      // on demand from `path` when the user taps "View POD".
      const localAttach = p.loadId ? (getAttachments(p.loadId) || {}) : {};
      const attachKind = (p.consigneeIndex != null) ? `pod_c${p.consigneeIndex}` : "pod";
      const localDataUrl = p.dataUrl || localAttach?.[attachKind]?.dataUrl || localAttach?.pod?.dataUrl || null;
      const dataUrl = localDataUrl || null;
      return {
        ...p,
        dataUrl,
        lid: ld?.lid || p.lid || null,
        loadId: p.loadId || ld?.id || null,
        customer: p.customer || ld?.customer || "—",
        origin: p.origin || ld?.origin || null,
        dest: p.dest || ld?.dest || null,
        vnum: p.vnum || veh?.vnum || ld?.vnum || null,
        driver: p.driver || veh?.driver || ld?.driver || null,
        mobile: p.mobile || veh?.mobile || ld?.mobile || null,
      };
    });
  }, [pods, tmsLoads, tmsVehicles, needsServerFetch, rangeQuery.data]);


  const customers = useMemo(() => {
    const s = new Set();
    tmsLoads.forEach(l => l?.customer && s.add(l.customer));
    tmsVehicles.forEach(v => v?.customer && s.add(v.customer));
    pods.forEach(p => p?.customer && s.add(p.customer));
    return Array.from(s).sort();
  }, [pods, tmsLoads, tmsVehicles]);
  const vehicles = useMemo(() => {
    const s = new Set();
    tmsVehicles.forEach(v => v?.vnum && s.add(String(v.vnum).toUpperCase()));
    pods.forEach(p => p?.vnum && s.add(String(p.vnum).toUpperCase()));
    return Array.from(s).sort();
  }, [pods, tmsVehicles]);
  const drivers = useMemo(() => {
    const s = new Set();
    tmsVehicles.forEach(v => v?.driver && s.add(v.driver));
    pods.forEach(p => p?.driver && s.add(p.driver));
    return Array.from(s).sort();
  }, [pods, tmsVehicles]);

  const filtered = useMemo(() => {
    const qn = q.trim().toLowerCase();
    let rows = enrichedPods.filter(p => {
      const ymd = ymdLocal(p.at);
      if (from && ymd && ymd < from) return false;
      if (to && ymd && ymd > to) return false;
      if (customer && !(p.customer||"").toLowerCase().includes(customer.toLowerCase())) return false;
      if (vehicle && !(p.vnum||"").toUpperCase().includes(vehicle.toUpperCase())) return false;
      if (driver && !(p.driver||"").toLowerCase().includes(driver.toLowerCase())) return false;
      if (status && (p.status||"") !== status) return false;
      if (qn) {
        const hay = [p.vnum,p.driver,p.mobile,p.customer,p.lid,p.notes].filter(Boolean).join(" ").toLowerCase();
        if (!hay.includes(qn)) return false;
      }
      return true;
    });
    rows.sort((a,b) => {
      if (sort === "old") return new Date(a.at) - new Date(b.at);
      if (sort === "vehicle") return (a.vnum||"").localeCompare(b.vnum||"");
      if (sort === "customer") return (a.customer||"").localeCompare(b.customer||"");
      return new Date(b.at) - new Date(a.at);
    });
    return rows;
  }, [enrichedPods, from, to, customer, vehicle, driver, status, q, sort]);

  const [podPage, setPodPage] = useState(1);
  const PAGE_SIZE = 50;
  useEffect(() => { setPodPage(1); }, [from, to, customer, vehicle, driver, status, q, sort]);
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const curPage = Math.min(Math.max(1, podPage), totalPages);
  const startIdx = (curPage - 1) * PAGE_SIZE;
  const pageRows = filtered.slice(startIdx, startIdx + PAGE_SIZE);
  const pageNumbers = (() => {
    if (totalPages <= 7) return Array.from({length: totalPages}, (_,i)=>i+1);
    const out = new Set([1, totalPages, curPage, curPage-1, curPage+1]);
    const arr = [...out].filter(n=>n>=1&&n<=totalPages).sort((a,b)=>a-b);
    const withGaps = [];
    arr.forEach((n,i)=>{ if (i>0 && n - arr[i-1] > 1) withGaps.push("…"); withGaps.push(n); });
    return withGaps;
  })();

  const stats = useMemo(() => ({
    total: filtered.length,
    ok: filtered.filter(p=>p.status==="OK").length,
    not: filtered.filter(p=>p.status==="NOT").length,
    pending: filtered.filter(p=>!p.status || (p.status!=="OK" && p.status!=="NOT")).length,
  }), [filtered]);

  const activeFilters = [from, to, customer, vehicle, driver, status, q].filter(Boolean).length;

  const applyPreset = (key) => { const r = presetRange(key); setFrom(r.from); setTo(r.to); };
  const resetAll = () => { setFrom(""); setTo(""); setCustomer(""); setVehicle(""); setDriver(""); setStatusFilter(""); setQ(""); setSort("new"); };

  const setStatus = (id, s) => { updatePOD(id, { status: s }); refresh(); };
  const remove = (id) => { if (confirm("Delete this POD record?")) { deletePOD(id); refresh(); } };

  const exportCSV = () => {
    const head = ["Time","Vehicle","Driver","Mobile","Customer","Load","Status","Notes"];
    const esc = (v) => `"${String(v??"").replace(/"/g,'""')}"`;
    const rows = filtered.map(p => [fmt(p.at),p.vnum,p.driver,p.mobile,p.customer,p.lid,p.status,p.notes].map(esc).join(","));
    const csv = [head.join(","), ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `pod-records-${ymdLocal(new Date())}.csv`; a.click();
    setTimeout(()=>URL.revokeObjectURL(url), 500);
  };

  return (
    <div style={{padding:"1rem 1.4rem",display:"flex",flexDirection:"column",gap:"1rem"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:".7rem"}}>
        <div>
          <div style={{fontFamily:"var(--font-head)",fontSize:"1.2rem",fontWeight:800,color:"#0f172a",letterSpacing:.5}}>📸 POD Records <span style={{color:"#6b7280",fontWeight:500,fontSize:".8rem"}}>{filtered.length} of {pods.length}</span></div>
          <div style={{fontSize:".75rem",color:"#6b7280",marginTop:2}}>Proof of Delivery photos uploaded by drivers via the Drivers App.</div>
        </div>
        <div style={{display:"flex",gap:".5rem"}}>
          <button onClick={resyncPhotos} disabled={syncing} title="Re-fetch all POD photos from the cloud" style={{background:"#fff",color:syncing?"#9ca3af":"#0f172a",border:"1px solid #e5e7eb",padding:".5rem .8rem",borderRadius:6,fontSize:".78rem",fontWeight:700,cursor:syncing?"wait":"pointer",display:"inline-flex",alignItems:"center",gap:5}}>
            <RefreshCw size={14} style={syncing?{animation:"spin 0.8s linear infinite"}:undefined}/> {syncing?"Syncing…":"Re-sync photos"}
          </button>
          <button onClick={exportCSV} disabled={!filtered.length} style={{background:filtered.length?"#0f172a":"#e5e7eb",color:filtered.length?"#fff":"#9ca3af",border:"none",padding:".5rem .8rem",borderRadius:6,fontSize:".78rem",fontWeight:700,cursor:filtered.length?"pointer":"not-allowed",display:"inline-flex",alignItems:"center",gap:5}}><FileDown size={14}/> Export CSV</button>
        </div>
      </div>

      {/* 90-day window banner */}
      <div style={{display:"flex",alignItems:"center",gap:8,background:needsServerFetch?"#eff6ff":"#f8fafc",border:`1px solid ${needsServerFetch?"#bfdbfe":"#e2e8f0"}`,color:needsServerFetch?"#1d4ed8":"#475569",padding:".55rem .8rem",borderRadius:8,fontSize:".78rem",fontWeight:600}}>
        {needsServerFetch
          ? (rangeQuery.isFetching
              ? <><Loader2 size={14} style={{animation:"spin 0.8s linear infinite"}}/> Loading older POD records from server for {from} → {to}…</>
              : rangeQuery.isError
                ? <><Info size={14}/> Couldn't load older records: {String(rangeQuery.error?.message || "failed")}</>
                : <><Info size={14}/> Showing server-fetched POD records for {from} → {to}. Clear the From date to return to the last {RECENT_WINDOW_DAYS} days.</>)
          : <><Info size={14}/> Showing the last {RECENT_WINDOW_DAYS} days. To view older POD records, pick a From/To range below.</>
        }
      </div>



      {/* Summary tiles */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(150px,1fr))",gap:".6rem"}}>
        <Tile label="Total" value={stats.total} color="#0f172a"/>
        <Tile label="OK" value={stats.ok} color="#16a34a"/>
        <Tile label="Not OK" value={stats.not} color="#dc2626"/>
        <Tile label="Unreviewed" value={stats.pending} color="#d97706"/>
      </div>

      {sos.length > 0 && (
        <div style={{background:"#fef2f2",border:"1px solid #fecaca",borderRadius:8,padding:".7rem 1rem"}}>
          <div style={{display:"flex",alignItems:"center",gap:6,color:"#b91c1c",fontWeight:800,fontSize:".85rem"}}>
            <AlertTriangle size={16}/> SOS Alerts ({sos.length})
          </div>
          <div style={{display:"flex",flexWrap:"wrap",gap:".5rem",marginTop:".5rem"}}>
            {sos.slice(0,6).map(s => (
              <div key={s.id} style={{background:"#fff",border:"1px solid #fecaca",borderRadius:6,padding:".4rem .65rem",fontSize:".72rem"}}>
                <b style={{color:"#b91c1c"}}>{s.vnum}</b> · {s.driver || "—"} · {s.mobile || "—"} · {fmt(s.at)}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Filters */}
      <div style={{background:"#f9fafb",border:"1px solid #e5e7eb",borderRadius:8,padding:".8rem",display:"flex",flexDirection:"column",gap:".7rem"}}>
        {/* Search + presets row */}
        <div style={{display:"flex",gap:".5rem",alignItems:"center",flexWrap:"wrap"}}>
          <div style={{position:"relative",flex:"1 1 240px",minWidth:200}}>
            <Search size={14} style={{position:"absolute",left:8,top:"50%",transform:"translateY(-50%)",color:"#9ca3af"}}/>
            <input value={q} onChange={e=>setQ(e.target.value)} placeholder="Search vehicle, driver, mobile, customer, load #…" style={{...inp,paddingLeft:28}}/>
          </div>
          <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
            {PRESETS.map(p => (
              <button key={p.key} onClick={()=>applyPreset(p.key)} style={chipBtn}>{p.label}</button>
            ))}
          </div>
          <button onClick={resetAll} disabled={!activeFilters && sort==="new"} style={{...chipBtn,color:activeFilters?"#b91c1c":"#9ca3af",borderColor:activeFilters?"#fecaca":"#e5e7eb",background:activeFilters?"#fff5f5":"#fff",display:"inline-flex",alignItems:"center",gap:4,cursor:activeFilters?"pointer":"not-allowed"}}>
            <RotateCcw size={12}/> Reset{activeFilters?` (${activeFilters})`:""}
          </button>
        </div>
        {/* Field grid */}
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))",gap:".6rem"}}>
          <Field label="From">
            <PrettyDate value={from} onChange={setFrom} max={to||undefined}/>
          </Field>
          <Field label="To">
            <PrettyDate value={to} onChange={setTo} min={from||undefined}/>
          </Field>
          <Field label="Customer">
            <input type="text" list="pod-customers-list" value={customer} onChange={e=>setCustomer(e.target.value)} placeholder="Type to search…" style={inp}/>
            <datalist id="pod-customers-list">
              {customers.map(c=> <option key={c} value={c}/>) }
            </datalist>
          </Field>
          <Field label="Vehicle #">
            <input type="text" list="pod-vehicles-list" value={vehicle} onChange={e=>setVehicle(e.target.value)} placeholder="Type to search…" style={{...inp, textTransform:"uppercase"}}/>
            <datalist id="pod-vehicles-list">
              {vehicles.map(v=> <option key={v} value={v}/>) }
            </datalist>
          </Field>
          <Field label="Driver">
            <input type="text" list="pod-drivers-list" value={driver} onChange={e=>setDriver(e.target.value)} placeholder="Type to search…" style={inp}/>
            <datalist id="pod-drivers-list">
              {drivers.map(d=> <option key={d} value={d}/>) }
            </datalist>
          </Field>
          <Field label="Status">
            <select value={status} onChange={e=>setStatusFilter(e.target.value)} style={inp}>
              <option value="">All statuses</option>
              <option value="OK">OK</option>
              <option value="NOT">Not OK</option>
            </select>
          </Field>
          <Field label="Sort">
            <select value={sort} onChange={e=>setSort(e.target.value)} style={inp}>
              <option value="new">Newest first</option>
              <option value="old">Oldest first</option>
              <option value="vehicle">Vehicle #</option>
              <option value="customer">Customer</option>
            </select>
          </Field>
        </div>
      </div>

      {/* Table */}
      <div style={{background:"#fff",border:"1px solid #e5e7eb",borderRadius:8,overflow:"auto"}}>
        <table style={{width:"100%",borderCollapse:"collapse",fontSize:".82rem"}}>
          <thead style={{background:"#f3f4f6"}}>
            <tr>
              {["Photo","Vehicle #","Driver","Mobile","Customer","Route","Load #","Time","Status","Actions"].map(h=>(
                <th key={h} style={{padding:".55rem .75rem",textAlign:"left",borderBottom:"1px solid #e5e7eb",fontSize:".7rem",letterSpacing:1,textTransform:"uppercase",color:"#1f2937",fontFamily:"var(--font-head)"}}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={10} style={{padding:"2rem",textAlign:"center",color:"#9ca3af",fontSize:".85rem"}}>
                {pods.length === 0 ? "No POD records yet." : "No POD records match these filters."}
              </td></tr>
            )}
            {pageRows.map(p => (
              <tr key={p.id} style={{borderBottom:"1px solid #f3f4f6"}}>
                <td style={{padding:".5rem .75rem"}}>
                  {(p.path || p.dataUrl) ? (
                    <button onClick={()=>setPreview(p)} title="Load and view this POD"
                      style={{display:"inline-flex",alignItems:"center",gap:5,background:"#eff6ff",border:"1px solid #bfdbfe",color:"#1d4ed8",padding:"5px 10px",borderRadius:6,fontSize:".72rem",fontWeight:700,cursor:"pointer",whiteSpace:"nowrap"}}>
                      <Eye size={13}/> View POD
                    </button>
                  ) : <span style={{color:"#9ca3af"}}>—</span>}
                </td>

                <td style={{padding:".5rem .75rem",fontWeight:700,color:"#1d4ed8"}}>{p.vnum}</td>
                <td style={{padding:".5rem .75rem"}}>{p.driver || "—"}</td>
                <td style={{padding:".5rem .75rem",fontFamily:"var(--font-mono,monospace)"}}>{p.mobile || "—"}</td>
                <td style={{padding:".5rem .75rem"}}>{p.customer || "—"}</td>
                <td style={{padding:".5rem .75rem",fontSize:".76rem",color:"#374151"}}>
                  <span style={{whiteSpace:"nowrap"}}>{p.origin || "—"} <span style={{color:"#9ca3af"}}>→</span> {p.dest || "—"}</span>
                  {p.consigneeIndex != null && p.consigneeCity && (
                    <span style={{display:"block",fontSize:".64rem",color:"#6d28d9",fontWeight:700,marginTop:1}}>Stop: {p.consigneeCity}</span>
                  )}
                </td>
                <td style={{padding:".5rem .75rem",fontFamily:"var(--font-mono,monospace)",fontSize:".76rem"}}>{p.lid || "—"}</td>
                <td style={{padding:".5rem .75rem",fontSize:".74rem",color:"#374151"}}>{fmt(p.at)}</td>
                <td style={{padding:".5rem .75rem"}}>
                  <span style={{background:p.status==="OK"?"#dcfce7":p.status==="NOT"?"#fee2e2":"#fef3c7",color:p.status==="OK"?"#166534":p.status==="NOT"?"#b91c1c":"#92400e",border:`1px solid ${p.status==="OK"?"#86efac":p.status==="NOT"?"#fecaca":"#fde68a"}`,padding:"2px 8px",borderRadius:10,fontSize:".66rem",fontWeight:800,letterSpacing:.8}}>{p.status || "PENDING"}</span>
                </td>
                <td style={{padding:".5rem .75rem"}}>
                  <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
                    <button onClick={()=>setStatus(p.id,"OK")} title="Mark OK" style={iconBtn("#16a34a")}><Check size={13}/></button>
                    <button onClick={()=>setStatus(p.id,"NOT")} title="Mark NOT OK" style={iconBtn("#dc2626")}><X size={13}/></button>
                    {p.dataUrl && <a href={p.dataUrl} download={p.name||`pod-${p.vnum}.jpg`} style={{...iconBtn("#1d4ed8"),textDecoration:"none",display:"inline-flex",alignItems:"center",justifyContent:"center"}}><Download size={13}/></a>}
                    <button onClick={()=>remove(p.id)} title="Delete" style={iconBtn("#6b7280")}><Trash2 size={13}/></button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:".6rem"}}>
          <div style={{fontSize:".78rem",color:"#6b7280",fontWeight:600}}>
            {filtered.length === 0 ? "0 of 0" : `Showing ${startIdx+1}–${Math.min(startIdx+PAGE_SIZE, filtered.length)} of ${filtered.length}`}
          </div>
          <div style={{display:"flex",alignItems:"center",gap:4,flexWrap:"wrap"}}>
            <button onClick={()=>setPodPage(p=>Math.max(1,p-1))} disabled={curPage<=1} style={{background:"#fff",border:"1px solid #e5e7eb",color:curPage<=1?"#cbd5e1":"#0f172a",padding:"5px 10px",borderRadius:6,fontSize:".78rem",fontWeight:700,cursor:curPage<=1?"default":"pointer"}}>‹</button>
            {pageNumbers.map((n,i)=> n === "…" ? (
              <span key={`g${i}`} style={{padding:"0 6px",color:"#9ca3af"}}>…</span>
            ) : (
              <button key={n} onClick={()=>setPodPage(n)} style={{background:n===curPage?"#0f172a":"#fff",color:n===curPage?"#fff":"#0f172a",border:"1px solid #e5e7eb",padding:"5px 11px",borderRadius:6,fontSize:".78rem",fontWeight:700,cursor:"pointer",minWidth:32}}>{n}</button>
            ))}
            <button onClick={()=>setPodPage(p=>Math.min(totalPages,p+1))} disabled={curPage>=totalPages} style={{background:"#fff",border:"1px solid #e5e7eb",color:curPage>=totalPages?"#cbd5e1":"#0f172a",padding:"5px 10px",borderRadius:6,fontSize:".78rem",fontWeight:700,cursor:curPage>=totalPages?"default":"pointer"}}>›</button>
          </div>
        </div>
      )}


      {preview && (
        <div onClick={()=>setPreview(null)} style={{position:"fixed",inset:0,background:"rgba(15,23,42,0.8)",zIndex:300,display:"flex",alignItems:"center",justifyContent:"center",padding:"1rem"}}>
          <div onClick={e=>e.stopPropagation()} style={{background:"#fff",borderRadius:10,maxWidth:900,width:"100%",maxHeight:"94vh",overflow:"auto"}}>
            <div style={{padding:".8rem 1rem",borderBottom:"1px solid #e5e7eb",display:"flex",justifyContent:"space-between",alignItems:"center",gap:".5rem"}}>
              <div style={{fontWeight:800,color:"#0f172a"}}>{preview.vnum} · {preview.customer || "—"} · {fmt(preview.at)}</div>
              <div style={{display:"flex",gap:".4rem",alignItems:"center"}}>
                {previewUrl && <a href={previewUrl} download={preview.name||`pod-${preview.vnum||"file"}.jpg`} style={{display:"inline-flex",alignItems:"center",gap:4,background:"#eff6ff",border:"1px solid #bfdbfe",color:"#1d4ed8",padding:"4px 10px",borderRadius:6,fontWeight:700,fontSize:".78rem",textDecoration:"none"}}><Download size={13}/> Download</a>}
                <button onClick={()=>setPreview(null)} style={{background:"#f3f4f6",border:"1px solid #e5e7eb",padding:"4px 10px",borderRadius:6,cursor:"pointer",fontWeight:700}}>Close</button>
              </div>
            </div>
            {previewLoading ? (
              <div style={{padding:"3rem",textAlign:"center",color:"#6b7280",fontWeight:600}}>Loading POD…</div>
            ) : previewUrl ? (
              <img src={previewUrl} alt="POD" onError={()=>setPreviewUrl(null)} style={{width:"100%",display:"block"}}/>
            ) : (
              <div style={{padding:"3rem",textAlign:"center",color:"#b91c1c",fontWeight:700}}>Photo unavailable</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const inp = {width:"100%",padding:".4rem .55rem",borderRadius:5,border:"1px solid #d1d5db",background:"#fff",fontSize:".8rem",outline:"none"};
const iconBtn = (color) => ({background:"#fff",border:`1px solid ${color}`,color,padding:"4px 6px",borderRadius:5,cursor:"pointer",display:"inline-flex",alignItems:"center"});
const chipBtn = {background:"#fff",border:"1px solid #d1d5db",padding:".35rem .65rem",borderRadius:14,fontSize:".72rem",fontWeight:700,color:"#374151",cursor:"pointer"};

function Field({ label, children }) {
  return (
    <div>
      <div style={{fontSize:".64rem",fontWeight:800,letterSpacing:1.2,color:"#6b7280",textTransform:"uppercase",marginBottom:3}}>{label}</div>
      {children}
    </div>
  );
}

function Tile({ label, value, color }) {
  return (
    <div style={{background:"#fff",border:"1px solid #e5e7eb",borderRadius:8,padding:".7rem .9rem"}}>
      <div style={{fontSize:".64rem",fontWeight:800,letterSpacing:1.2,color:"#6b7280",textTransform:"uppercase"}}>{label}</div>
      <div style={{fontFamily:"var(--font-head)",fontSize:"1.4rem",fontWeight:800,color,marginTop:2}}>{value}</div>
    </div>
  );
}
