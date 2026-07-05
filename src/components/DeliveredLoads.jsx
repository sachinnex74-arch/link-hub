import { useMemo, useState, useEffect, lazy, Suspense } from "react";
import * as XLSX from "xlsx";
import { Eye, Download, Search, CheckCircle2, Package, Info, Loader2 } from "lucide-react";
const LoadDetailsDialog = lazy(() => import("./LoadDetailsDialog"));
import { getPODs } from "@/lib/driverStore";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { listDeliveredLoadsByRange } from "@/lib/tms.functions";
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
  try { const x = new Date(d); if (isNaN(x.getTime())) return d; return x.toLocaleString("en-IN",{dateStyle:"medium",timeStyle:"short"}); }
  catch { return d; }
};
const fmtDateOnly = (d) => {
  if (!d) return "—";
  try { return new Date(d).toLocaleDateString("en-IN",{dateStyle:"medium"}); }
  catch { return d; }
};
const ymd = (d) => { try { return new Date(d).toISOString().slice(0,10); } catch { return ""; } };

export default function DeliveredLoads({ loads = [], vehicles = [], gpsMap = {} }) {
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [customer, setCustomer] = useState("");
  const [branch, setBranch] = useState("");
  const [vehicle, setVehicle] = useState("");
  const [search, setSearch] = useState("");
  const [openLoadId, setOpenLoadId] = useState(null);

  // Hybrid range: when From date is older than the recent window, fetch the
  // exact From/To range from the server. Result replaces the visible list.
  const cutoff = recentCutoffYmd();
  const needsServerFetch = !!(dateFrom && dateTo && dateFrom < cutoff);
  const fetchRange = useServerFn(listDeliveredLoadsByRange);
  const rangeQuery = useQuery({
    queryKey: ["deliveredRange", dateFrom, dateTo],
    queryFn: () => fetchRange({ data: { from: dateFrom, to: dateTo } }),
    enabled: needsServerFetch,
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  });

  const delivered = useMemo(() => {
    if (needsServerFetch) return rangeQuery.data?.loads ?? [];
    // Clip cached data to the 90-day window so the banner is truthful.
    return loads.filter(l => {
      if (l.lstatus !== "DELIVERED") return false;
      if (!l.deliveredAt) return true;
      return ymd(l.deliveredAt) >= cutoff;
    });
  }, [needsServerFetch, rangeQuery.data, loads, cutoff]);

  // Enriched rows
  const podsByLoad = useMemo(() => {
    const m = {};
    for (const p of getPODs()) {
      if (!p.loadId) continue;
      if (!m[p.loadId] || new Date(p.at) > new Date(m[p.loadId].at)) m[p.loadId] = p;
    }
    return m;
  }, [delivered.length]); // re-eval when delivered list changes

  const enriched = useMemo(() => delivered.map(l => {
    // Find vehicle either currently linked or via POD record
    const pod = podsByLoad[l.id];
    const veh = vehicles.find(v => v.id === l.vehicleId)
      || vehicles.find(v => (v.vnum||"").toUpperCase() === (pod?.vnum||"").toUpperCase());
    return {
      ...l,
      _vnum: veh?.vnum || pod?.vnum || l.vnumSnapshot || "—",
      _driver: veh?.driver || pod?.driver || l.driverSnapshot || "—",
      _mobile: veh?.mobile || pod?.mobile || l.mobileSnapshot || "—",
      _vehicle: veh,
      _pod: pod,
    };
  }), [delivered, vehicles, podsByLoad]);

  const customers = useMemo(() => Array.from(new Set(enriched.map(l => l.customer).filter(Boolean))).sort(), [enriched]);
  const branches  = useMemo(() => Array.from(new Set(enriched.map(l => l.branch).filter(Boolean))).sort(), [enriched]);
  const vnums     = useMemo(() => Array.from(new Set(enriched.map(l => l._vnum).filter(v => v && v !== "—"))).sort(), [enriched]);

  const filtered = useMemo(() => enriched.filter(l => {
    const d = l.deliveredAt ? ymd(l.deliveredAt) : "";
    if (dateFrom && (!d || d < dateFrom)) return false;
    if (dateTo && (!d || d > dateTo)) return false;
    if (customer && l.customer !== customer) return false;
    if (branch && l.branch !== branch) return false;
    if (vehicle && (l._vnum||"").toUpperCase() !== vehicle.toUpperCase()) return false;
    const q = search.trim().toLowerCase();
    if (q && ![l.lid,l.commodity,l.origin,l.dest,l.customer,l._driver,l._vnum].some(f => f && String(f).toLowerCase().includes(q))) return false;
    return true;
  }).sort((a,b) => new Date(b.deliveredAt||0) - new Date(a.deliveredAt||0)), [enriched, dateFrom, dateTo, customer, branch, vehicle, search]);

  // Summary tiles
  const today = new Date(); today.setHours(0,0,0,0);
  const weekAgo = new Date(today.getTime() - 6*24*3600*1000);
  const deliveredToday = filtered.filter(l => l.deliveredAt && new Date(l.deliveredAt) >= today).length;
  const deliveredWeek = filtered.filter(l => l.deliveredAt && new Date(l.deliveredAt) >= weekAgo).length;
  const totalWeight = filtered.reduce((s,l) => s + (parseFloat(l.weight)||0), 0);

  const reset = () => { setDateFrom(""); setDateTo(""); setCustomer(""); setBranch(""); setVehicle(""); setSearch(""); };

  // Pagination
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 100;
  useEffect(() => { setPage(1); }, [dateFrom, dateTo, customer, branch, vehicle, search]);
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const curPage = Math.min(Math.max(1, page), totalPages);
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

  const exportExcel = () => {
    const rows = filtered.map(l => ({
      "Load #": l.lid,
      "Customer": l.customer || "",
      "Branch": l.branch || "",
      "Origin": l.origin || "",
      "Destination": l.dest || "",
      "Vehicle #": l._vnum,
      "Driver": l._driver,
      "Driver Mobile": l._mobile,
      "Commodity": l.commodity || "",
      "Weight (T)": l.weight || "",
      "Volume": l.volume || "",
      "Priority": l.priority || "",
      "Pickup Date": l.pickup ? fmt(l.pickup) : "",
      "Targeted Delivery": l.delivery ? fmt(l.delivery) : "",
      "LR Date": l.lrDate ? fmtDateOnly(l.lrDate) : "",
      "Delivered On": l.deliveredAt ? fmt(l.deliveredAt) : "",
      "POD Status": l._pod ? l._pod.status : "—",
      "POD Uploaded At": l._pod ? fmt(l._pod.at) : "",
      "Notes": l.notes || "",
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Delivered Loads");
    const stamp = new Date().toISOString().slice(0,10);
    XLSX.writeFile(wb, `delivered-loads-${stamp}.xlsx`);
  };

  const openLoad = openLoadId ? enriched.find(l => l.id === openLoadId) : null;

  return (
    <div style={{padding:"1rem 1.4rem",display:"flex",flexDirection:"column",gap:"1rem"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:".7rem"}}>
        <div>
          <div style={{fontFamily:"var(--font-head)",fontSize:"1.2rem",fontWeight:800,color:"var(--text)",letterSpacing:.5}}>✅ Delivered Loads <span style={{color:"var(--text3)",fontWeight:500,fontSize:".8rem"}}>{filtered.length} of {delivered.length}</span></div>
          <div style={{fontSize:".75rem",color:"var(--text3)",marginTop:2}}>History of completed deliveries. Click a row to see full details and uploaded documents.</div>
        </div>
        <button onClick={exportExcel} disabled={filtered.length===0} style={{display:"inline-flex",alignItems:"center",gap:6,background:filtered.length===0?"var(--surface3)":"var(--accent)",color:filtered.length===0?"var(--text3)":"#000",border:"none",padding:".55rem 1rem",borderRadius:6,fontFamily:"var(--font-head)",fontSize:".82rem",fontWeight:700,letterSpacing:1,textTransform:"uppercase",cursor:filtered.length===0?"not-allowed":"pointer"}}>
          <Download size={14}/> Export Excel
        </button>
      </div>

      {/* 90-day window banner */}
      <div style={{display:"flex",alignItems:"center",gap:8,background:"var(--surface3)",border:`1px solid ${needsServerFetch?"var(--accent)":"var(--border)"}`,color:needsServerFetch?"var(--accent)":"var(--text2)",padding:".55rem .8rem",borderRadius:8,fontSize:".78rem",fontWeight:600}}>
        {needsServerFetch
          ? (rangeQuery.isFetching
              ? <><Loader2 size={14} style={{animation:"spin 0.8s linear infinite"}}/> Loading older records from server for {dateFrom} → {dateTo}…</>
              : rangeQuery.isError
                ? <><Info size={14}/> Couldn't load older records: {String(rangeQuery.error?.message || "failed")}</>
                : <><Info size={14}/> Showing server-fetched records for {dateFrom} → {dateTo}. Clear the From date to return to the last {RECENT_WINDOW_DAYS} days.</>)
          : <><Info size={14}/> Showing the last {RECENT_WINDOW_DAYS} days. To view older records, pick a From/To range below.</>
        }
      </div>



      {/* Summary tiles */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))",gap:".7rem"}}>
        <Tile icon={<CheckCircle2 size={18}/>} label="Total Delivered" value={delivered.length} color="#16a34a" bg="#dcfce7" />
        <Tile icon={<CheckCircle2 size={18}/>} label="Delivered Today" value={deliveredToday} color="#1d4ed8" bg="#dbeafe" />
        <Tile icon={<CheckCircle2 size={18}/>} label="Last 7 Days" value={deliveredWeek} color="#6d28d9" bg="#ede9fe" />
        <Tile icon={<Package size={18}/>} label="Total Weight (T)" value={totalWeight.toFixed(1)} color="#b45309" bg="#fef3c7" />
      </div>

      {/* Filters */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))",gap:".7rem",background:"var(--surface)",border:"1px solid var(--border)",borderRadius:8,padding:".8rem"}}>
        <Field label="Delivered From">
          <PrettyDate value={dateFrom} onChange={setDateFrom}/>
        </Field>
        <Field label="Delivered To">
          <PrettyDate value={dateTo} onChange={setDateTo}/>
        </Field>
        <Field label="Customer">
          <select value={customer} onChange={e=>setCustomer(e.target.value)} style={inp}>
            <option value="">All customers</option>
            {customers.map(c=> <option key={c} value={c}>{c}</option>)}
          </select>
        </Field>
        <Field label="Branch">
          <select value={branch} onChange={e=>setBranch(e.target.value)} style={inp}>
            <option value="">All branches</option>
            {branches.map(b=> <option key={b} value={b}>{b}</option>)}
          </select>
        </Field>
        <Field label="Vehicle #">
          <select value={vehicle} onChange={e=>setVehicle(e.target.value)} style={inp}>
            <option value="">All vehicles</option>
            {vnums.map(v=> <option key={v} value={v}>{v}</option>)}
          </select>
        </Field>
        <Field label="Search">
          <div style={{position:"relative"}}>
            <Search size={13} style={{position:"absolute",left:8,top:"50%",transform:"translateY(-50%)",color:"var(--text3)"}}/>
            <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="LID / route / driver" style={{...inp,paddingLeft:26}}/>
          </div>
        </Field>
        <div style={{display:"flex",alignItems:"end"}}>
          <button onClick={reset} style={{background:"var(--surface2)",border:"1px solid var(--border)",padding:".45rem .8rem",borderRadius:6,fontSize:".78rem",fontWeight:700,cursor:"pointer",color:"var(--text)"}}>Reset</button>
        </div>
      </div>

      {/* Table */}
      <div style={{background:"var(--surface)",border:"1px solid var(--border)",borderRadius:8,overflow:"auto"}}>
        <table style={{width:"100%",borderCollapse:"collapse",fontSize:".82rem"}}>
          <thead style={{background:"var(--surface3)"}}>
            <tr>
              {["Load #","Customer","Origin → Destination","Vehicle #","Driver","Pickup","Delivered On","Branch","Commodity","Weight","POD","Action"].map(h=>(
                <th key={h} style={{padding:".55rem .7rem",textAlign:"left",borderBottom:"1px solid var(--border)",fontSize:".68rem",letterSpacing:1,textTransform:"uppercase",color:"var(--text2)",fontFamily:"var(--font-head)",whiteSpace:"nowrap"}}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={12} style={{padding:"2rem",textAlign:"center",color:"var(--text3)",fontSize:".85rem"}}>No delivered loads match these filters.</td></tr>
            )}
            {pageRows.map(l => (
              <tr key={l.id} style={{borderBottom:"1px solid var(--border)"}}>
                <td style={{padding:".5rem .7rem",fontFamily:"var(--font-mono,monospace)",fontWeight:700,color:"var(--accent)"}}>{l.lid}</td>
                <td style={{padding:".5rem .7rem",color:"var(--text)"}}>{l.customer || "—"}</td>
                <td style={{padding:".5rem .7rem",color:"var(--text)"}}>
                  <div style={{fontSize:".78rem"}}>{(l.origin||"").split(",")[0]} <span style={{color:"var(--accent)"}}>→</span> {(l.dest||"").split(",")[0]}</div>
                </td>
                <td style={{padding:".5rem .7rem",fontFamily:"var(--font-mono,monospace)",fontWeight:700,color:"var(--text)"}}>{l._vnum}</td>
                <td style={{padding:".5rem .7rem",color:"var(--text)"}}>
                  <div>{l._driver}</div>
                  <div style={{fontSize:".68rem",color:"var(--text3)",fontFamily:"var(--font-mono,monospace)"}}>{l._mobile}</div>
                </td>
                <td style={{padding:".5rem .7rem",fontSize:".74rem",color:"var(--text2)"}}>{l.pickup ? fmtDateOnly(l.pickup) : "—"}</td>
                <td style={{padding:".5rem .7rem",fontSize:".74rem",color:"#86efac",fontWeight:600}}>{l.deliveredAt ? fmt(l.deliveredAt) : "—"}</td>
                <td style={{padding:".5rem .7rem",color:"var(--text)"}}>{l.branch || "—"}</td>
                <td style={{padding:".5rem .7rem",color:"var(--text)"}}>{l.commodity || "—"}</td>
                <td style={{padding:".5rem .7rem",color:"var(--text)"}}>{l.weight || "—"}</td>
                <td style={{padding:".5rem .7rem"}}>
                  {l._pod ? (
                    <span style={{background:l._pod.status==="OK"?"#0e1a13":"#1a0d0d",color:l._pod.status==="OK"?"#86efac":"#fca5a5",border:`1px solid ${l._pod.status==="OK"?"#22c55e55":"#fca5a555"}`,padding:"2px 7px",borderRadius:10,fontSize:".64rem",fontWeight:800,letterSpacing:.8}}>{l._pod.status}</span>
                  ) : <span style={{color:"var(--text3)",fontSize:".72rem"}}>none</span>}
                </td>
                <td style={{padding:".5rem .7rem"}}>
                  <button onClick={()=>setOpenLoadId(l.id)} title="View details" style={{background:"var(--surface3)",border:"1px solid var(--border2)",color:"var(--accent)",padding:"4px 8px",borderRadius:5,cursor:"pointer",display:"inline-flex",alignItems:"center",gap:4,fontSize:".7rem",fontWeight:700}}>
                    <Eye size={12}/> View
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:".6rem",marginTop:".7rem"}}>
          <div style={{fontSize:".78rem",color:"var(--text3)",fontWeight:600}}>
            {filtered.length === 0 ? "0 of 0" : `Showing ${startIdx+1}–${Math.min(startIdx+PAGE_SIZE, filtered.length)} of ${filtered.length}`}
          </div>
          <div style={{display:"flex",alignItems:"center",gap:4,flexWrap:"wrap"}}>
            <button onClick={()=>setPage(p=>Math.max(1,p-1))} disabled={curPage<=1} style={{background:"var(--surface2)",border:"1px solid var(--border)",color:curPage<=1?"var(--text3)":"var(--text)",padding:"5px 10px",borderRadius:6,fontSize:".78rem",fontWeight:700,cursor:curPage<=1?"default":"pointer"}}>‹</button>
            {pageNumbers.map((n,i)=> n === "…" ? (
              <span key={`g${i}`} style={{padding:"0 6px",color:"var(--text3)"}}>…</span>
            ) : (
              <button key={n} onClick={()=>setPage(n)} style={{background:n===curPage?"var(--accent)":"var(--surface2)",color:n===curPage?"#000":"var(--text)",border:"1px solid var(--border)",padding:"5px 11px",borderRadius:6,fontSize:".78rem",fontWeight:700,cursor:"pointer",minWidth:32}}>{n}</button>
            ))}
            <button onClick={()=>setPage(p=>Math.min(totalPages,p+1))} disabled={curPage>=totalPages} style={{background:"var(--surface2)",border:"1px solid var(--border)",color:curPage>=totalPages?"var(--text3)":"var(--text)",padding:"5px 10px",borderRadius:6,fontSize:".78rem",fontWeight:700,cursor:curPage>=totalPages?"default":"pointer"}}>›</button>
          </div>
        </div>
      )}

      {openLoad && (
        <Suspense fallback={null}>
          <LoadDetailsDialog
            load={openLoad}
            vehicle={openLoad._vehicle}
            gps={openLoad._vehicle ? gpsMap[openLoad._vehicle.vnum] : null}
            eta={openLoad._vehicle?.eta}
            onClose={()=>setOpenLoadId(null)}
            readOnly
          />
        </Suspense>
      )}

    </div>
  );
}

const inp = {width:"100%",padding:".4rem .55rem",borderRadius:5,border:"1px solid var(--border)",background:"var(--surface2)",color:"var(--text)",fontSize:".8rem",outline:"none"};

function Field({ label, children }) {
  return (
    <div>
      <div style={{fontSize:".62rem",fontWeight:800,letterSpacing:1.2,color:"var(--text3)",textTransform:"uppercase",marginBottom:3}}>{label}</div>
      {children}
    </div>
  );
}

function Tile({ icon, label, value, color, bg }) {
  return (
    <div style={{background:bg,border:`1px solid ${color}33`,borderRadius:10,padding:".8rem 1rem",display:"flex",alignItems:"center",gap:".7rem"}}>
      <div style={{color,background:"var(--surface)",border:`1px solid ${color}55`,borderRadius:8,padding:6,display:"flex"}}>{icon}</div>
      <div>
        <div style={{fontSize:".66rem",fontWeight:800,letterSpacing:1.2,color,textTransform:"uppercase"}}>{label}</div>
        <div style={{fontSize:"1.3rem",fontWeight:800,color,fontFamily:"var(--font-head)"}}>{value}</div>
      </div>
    </div>
  );
}
