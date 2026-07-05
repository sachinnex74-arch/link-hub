import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState, useMemo, useRef, lazy, Suspense } from "react";
import { Truck, LogOut, ArrowLeft, MapPin, CheckCircle2, AlertOctagon, Camera } from "lucide-react";
import { getVehicles, getLoads, addPOD, addOfflinePOD, addSOS, setAttachment, fileToDataUrl, markLoadDelivered, markConsigneeDelivered } from "@/lib/driverStore";
import { hindiCity } from "@/lib/hindiCities";
import { verifyPinFn, getDriverCredentialsFn } from "@/lib/tms.functions";
import { initSync, isSyncHydrated, uploadAttachment, refreshFromCloud, setDriverCreds, flushPodImagesNow } from "@/lib/supaSync";
import { ensureSupabase } from "@/integrations/supabase/client";
const LoadDetailsDialog = lazy(() => import("@/components/LoadDetailsDialog"));


export const Route = createFileRoute("/driver")({
  // Client-only: reads driver session + loads from localStorage.
  ssr: false,
  head: () => ({
    meta: [
      { title: "Drivers App — Logistics" },
      { name: "description", content: "Driver portal for assigned loads, documents, and ETAs." },
    ],
  }),
  component: DriverApp,
});

const SESSION_KEY = "lov_driver_session";

function DriverApp() {
  const [mounted, setMounted] = useState(false);
  const [vehicles, setVehicles] = useState<any[]>([]);
  const [loads, setLoads] = useState<any[]>([]);
  const [session, setSession] = useState<any>(null);

  const [syncing, setSyncing] = useState(true);

  // Login state
  const [vQuery, setVQuery] = useState("");
  const [pickedVnum, setPickedVnum] = useState<string | null>(null);
  const [pinEntry, setPinEntry] = useState("");
  const [error, setError] = useState("");
  const [showSug, setShowSug] = useState(false);

  // Logged-in state
  const [openLoadId, setOpenLoadId] = useState<string | null>(null);
  const [podPickFor, setPodPickFor] = useState<string | null>(null); // load id awaiting POD upload
  const [cPodFor, setCPodFor] = useState<{ loadId: string; ci: number } | null>(null); // consignee POD target
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setMounted(true);
    // One-shot sweep: older versions of the driver app cached the full PIN
    // dictionary in localStorage. Wipe any leftover keys so a stolen device
    // can't use them.
    try {
      const stale: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith("lov_veh_pin_")) stale.push(k);
      }
      stale.forEach(k => localStorage.removeItem(k));
    } catch {}
    setVehicles(getVehicles());
    setLoads(getLoads());

    try {
      const s = localStorage.getItem(SESSION_KEY);
      if (s) {
        const parsed = JSON.parse(s);
        setSession(parsed);
        if (parsed?.vnum && parsed?.pin) setDriverCreds({ vnum: parsed.vnum, pin: parsed.pin });
      }
    } catch {}

    // Silent Supabase sign-in before initSync.
    // If a valid session already exists in localStorage ("tms-auth"), Supabase
    // restores it automatically — no network call needed.
    // If not (new device or session cleared), fetch the driver service account
    // credentials from app_settings and sign in silently.
    // initSync() always runs after, regardless of outcome — worst case the
    // driver gets vehicles only (same as before this change).
    const bootstrap = async () => {
      try {
        const sb = await ensureSupabase();
        if (sb) {
          const { data: { session: existing } } = await sb.auth.getSession();
          if (!existing) {
            const creds = await getDriverCredentialsFn();
            if (creds.ok) {
              await sb.auth.signInWithPassword({
                email: creds.email,
                password: creds.password,
              });
            }
          }
        }
      } catch {
        // Sign-in failure is non-fatal — initSync proceeds, driver sees
        // vehicles from cache and can still use PIN auth.
      }
      initSync().then(() => {
        setSyncing(false);
        setVehicles(getVehicles());
        setLoads(getLoads());
      }).catch(() => setSyncing(false));
    };
    bootstrap();
  }, []);

  useEffect(() => {
    if (!mounted) return;
    const refresh = () => { setVehicles(getVehicles()); setLoads(getLoads()); };
    const cloudRefresh = () => { refreshFromCloud().catch(() => {}); };
    const onVisible = () => { if (document.visibilityState === "visible") cloudRefresh(); };
    window.addEventListener("tms:sync", refresh);
    document.addEventListener("visibilitychange", onVisible);
    const tLocal = setInterval(refresh, 3000);
    const tCloud = setInterval(cloudRefresh, 15000);
    return () => {
      window.removeEventListener("tms:sync", refresh);
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(tLocal);
      clearInterval(tCloud);
    };
  }, [mounted]);


  // Open camera/file picker as soon as a POD target is set (hook at top level)
  useEffect(() => {
    if (podPickFor && podPickFor !== "__choose__" && fileRef.current) {
      fileRef.current.click();
    }
  }, [podPickFor]);

  useEffect(() => {
    if (cPodFor && fileRef.current) {
      fileRef.current.click();
    }
  }, [cPodFor]);


  // ----- Autosuggest -----
  const suggestions = useMemo(() => {
    const q = vQuery.trim().toLowerCase();
    if (!q) return vehicles.slice(0, 8);
    return vehicles
      .filter(v => (v.vnum||"").toLowerCase().includes(q) || (v.driver||"").toLowerCase().includes(q))
      .slice(0, 8);
  }, [vehicles, vQuery]);

  const pickVehicle = (v: any) => {
    setPickedVnum(v.vnum);
    setVQuery(v.vnum);
    setShowSug(false);
    setError("");
  };

  const handleLogin = async () => {
    setError("");
    // Enforce: must be a real vehicle from the list
    const match = vehicles.find(v => (v.vnum||"").trim().toUpperCase() === (vQuery.trim().toUpperCase()));
    if (!match) { setError("Pick your vehicle from the suggestions."); return; }
    const vnum = match.vnum;

    // Cloud verification is the ONLY path. No offline PIN cache fallback —
    // PINs are not shipped to the driver app, so a stolen device cannot
    // bruteforce locally.
    let res: any;
    try {
      res = await verifyPinFn({ data: { vnum, pin: pinEntry } });
    } catch (e: any) {
      console.warn("[driver] verifyPinFn failed:", e?.message || e);
      setError("Can't reach server — try again when online.");
      return;
    }
    console.log("[driver] verifyPinFn result:", { vnum, ok: res?.ok, hasPin: res?.hasPin });

    if (!res?.hasPin) {
      setError("No PIN set for this vehicle. Ask your manager (Fleet → PIN).");
      return;
    }
    if (!res?.ok) { setError("Incorrect PIN."); return; }

    const s = { vnum, at: Date.now(), pin: pinEntry };
    localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    setSession(s);
    // Tag sync layer with driver scope so pullAll/pullDelta return only this
    // vehicle's data, then trigger a fresh hydrate.
    setDriverCreds({ vnum, pin: pinEntry });
    refreshFromCloud(0).catch(() => {});
    setPinEntry(""); setPickedVnum(null); setVQuery("");
  };


  const logout = () => {
    localStorage.removeItem(SESSION_KEY);
    setSession(null);
    setDriverCreds(null);
  };

  if (!mounted) return null;

  // ============== LOGGED IN ==============
  if (session) {
    const me = vehicles.find(v => (v.vnum||"").toUpperCase() === (session.vnum||"").toUpperCase());
    const isAssignedToMe = (l: any) =>
      (l?.lstatus !== "DELIVERED") &&
      // Authoritative link only: vehicleId is set on assign and cleared on unassign/
      // vehicle-delete/deliver. The old `l.vnum` fallback lingered after unassign (the
      // stamp isn't cleared), which kept unassigned loads visible — removed.
      (l?.vehicleId === me?.id);
    const myLoads = loads.filter(isAssignedToMe);
    const isMulti = (l:any) => (Array.isArray(l?.consigneeDeliveries) && l.consigneeDeliveries.length>0) || (Array.isArray(l?.consignees) && l.consignees.length>0);
    const multiLoads = myLoads.filter(isMulti);
    const singleLoads = myLoads.filter((l:any)=>!isMulti(l));
    const openLoad = openLoadId ? loads.find(l => l.id === openLoadId) : null;

    const startDeliveredFlow = () => {
      setError("");
      // Re-read the freshest loads so we don't act on a stale snapshot.
      const fresh = getLoads().filter(isAssignedToMe).filter((l:any)=>!isMulti(l));
      if (fresh.length === 0) {
        // No assigned load — still allow POD recording at vehicle level
        setPodPickFor("__no_load__");
      } else if (fresh.length === 1) {
        setPodPickFor(fresh[0].id);
      } else {
        // ask user to pick a load
        setPodPickFor("__choose__");
      }
    };


    const onPodFile = async (f: File) => {
      if (!f || !podPickFor) return;
      setBusy(true);
      try {
        const data = await fileToDataUrl(f);
        const lid = podPickFor !== "__no_load__" && podPickFor !== "__choose__" ? podPickFor : null;
        // Always read from the freshest loads list — state may be stale.
        const ld = lid ? (getLoads().find((l: any) => l.id === lid) || loads.find(l => l.id === lid)) : null;

        // Offline POD durability for single-consignee/plain loads: store the photo locally and
        // defer both the upload AND the delivery (gated on the image landing), so the driver is
        // never blocked in a dead zone and the load is never DELIVERED without its photo.
        // Only applies to load-linked PODs (lid present); the no-load vehicle POD keeps inline.
        if (lid) {
          const podLocalId = await addOfflinePOD(f, {
            loadId: lid, ci: null,
            vnum: me?.vnum, driver: me?.driver, mobile: me?.mobile,
            customer: ld?.customer || me?.customer || "\u2014",
            lid: ld?.lid || null, origin: ld?.origin || null, dest: ld?.dest || null,
          });
          if (podLocalId) {
            markLoadDelivered(lid, { awaitingImage: podLocalId });
            try { flushPodImagesNow(); } catch {}
            alert("\u2705 POD saved. Photo will upload and delivery will sync when online.\nPOD \u0938\u0939\u0947\u091c\u0940 \u0917\u0908\u0964 \u0911\u0928\u0932\u093e\u0907\u0928 \u0939\u094b\u0928\u0947 \u092a\u0930 \u0905\u092a\u0932\u094b\u0921 \u0939\u094b\u0917\u0940\u0964");
            setPodPickFor(null); setBusy(false);
            return;
          }
          // IndexedDB unavailable → inline (fail-closed) path below.
        }

        // 1. Upload the file to Storage + load_attachments (load_id linked).
        //    Await so we can capture the storage path and stamp it on the POD.
        let storagePath: string | null = null;
        if (lid) {
          const uploaded = await uploadAttachment(lid, "pod", f);
          storagePath = uploaded?.path || null;
          if (!storagePath) throw new Error("Photo upload did not return a cloud storage path. Please try again.");
          // Save the local attachment record with the dataUrl AND storage path,
          // so the POD list on this device can recover the photo from either.
          setAttachment(lid, "pod", { ...data, path: storagePath });
        }
        // 2. Record the POD with the load reference.
        addPOD({
          vnum: me?.vnum,
          driver: me?.driver,
          mobile: me?.mobile,
          customer: ld?.customer || me?.customer || "—",
          loadId: lid,
          lid: ld?.lid || null,
          origin: ld?.origin || null,
          dest: ld?.dest || null,
          dataUrl: data.dataUrl,
          path: storagePath,
          name: data.name,
          at: new Date().toISOString(),
          status: "OK",
        });

        // 3. Mark delivered last so the assignment stays valid for the prior writes.
        if (lid) markLoadDelivered(lid);
        alert("✅ POD uploaded. Load marked Delivered.\nडिलीवरी रिकॉर्ड हो गई।");
      } catch (e:any) {
        alert("Upload failed: " + (e?.message || e));
      } finally {
        setPodPickFor(null);
        setBusy(false);
      }
    };

    const startConsigneePod = (loadId: string, ci: number) => {
      setError("");
      setCPodFor({ loadId, ci });
    };

    const onConsigneePodFile = async (f: File) => {
      if (!f || !cPodFor) return;
      const { loadId, ci } = cPodFor;
      setBusy(true);
      try {
        const data = await fileToDataUrl(f);
        const ld: any = getLoads().find((l:any)=>l.id===loadId) || loads.find(l=>l.id===loadId);
        const cds = ld?.consigneeDeliveries?.length ? ld.consigneeDeliveries : (ld?.consignees||[]).map((c:any)=>({city:c}));
        const city = cds?.[ci]?.city || ld?.consignees?.[ci] || `Consignee ${ci+1}`;
        // Stable consignee id for new (cid-based) loads; old loads → null (keep index only).
        const _cids = ld && Array.isArray(ld.consigneeCids) ? ld.consigneeCids : null;
        const consigneeCid = !_cids ? null : (ci < _cids.length ? _cids[ci] : "__dest__");

        // Offline POD durability (flag retired — now unconditional): store the photo locally and
        // defer the upload so the driver is never blocked in a dead zone. The consignee mark is
        // gated until the image actually lands in storage (so never delivered-with-missing-photo).
        // addOfflinePOD returns null only if the device can't do IndexedDB → fall through to the
        // inline (fail-closed) path below. No network-dependent flag read at capture time.
        const podLocalId = await addOfflinePOD(f, {
          loadId, ci, cid: consigneeCid,
          vnum: me?.vnum, driver: me?.driver, mobile: me?.mobile,
          customer: ld?.customer || me?.customer || "\u2014",
          lid: ld?.lid || null, origin: ld?.origin || null, consigneeCity: city,
        });
        if (podLocalId) {
          // optimistic local "delivered (pending photo upload)" + gated consignee op
          await markConsigneeDelivered(loadId, ci, null, { awaitingImage: podLocalId });
          try { flushPodImagesNow(); } catch {}
          alert(`\u2705 ${city} \u2014 POD saved. Photo will upload when online.\n${city} \u0915\u0940 POD \u0938\u0939\u0947\u091c\u0940 \u0917\u0908\u0964 \u0911\u0928\u0932\u093e\u0907\u0928 \u0939\u094b\u0928\u0947 \u092a\u0930 \u092b\u094b\u091f\u094b \u0905\u092a\u0932\u094b\u0921 \u0939\u094b\u0917\u0940\u0964`);
          return;
        }
        // IndexedDB unavailable on this device → inline (fail-closed) upload path below.

        const uploaded = await uploadAttachment(loadId, `pod_c${ci}`, f);
        const storagePath = uploaded?.path || null;
        if (!storagePath) throw new Error("Photo upload did not return a cloud storage path. Please try again.");
        setAttachment(loadId, `pod_c${ci}`, { ...data, path: storagePath });
        addPOD({
          vnum: me?.vnum, driver: me?.driver, mobile: me?.mobile,
          customer: ld?.customer || me?.customer || "\u2014",
          loadId, lid: ld?.lid || null,
          origin: ld?.origin || null, dest: city,
          consigneeCity: city, consigneeIndex: ci, consigneeCid,
          dataUrl: data.dataUrl, path: storagePath, name: data.name,
          at: new Date().toISOString(), status: "OK",
        });
        const res = await markConsigneeDelivered(loadId, ci, storagePath);
        if (res?.allDone) alert(`\u2705 All ${res.total} deliveries done. Load marked Delivered.\n\u0938\u092d\u0940 \u0921\u093f\u0932\u0940\u0935\u0930\u0940 \u092a\u0942\u0930\u0940 \u0939\u094b \u0917\u0908\u0902\u0964`);
        else alert(`\u2705 ${city} delivered (${res?.doneCount||0}/${res?.total||0}).\n${city} \u0915\u0940 \u0921\u093f\u0932\u0940\u0935\u0930\u0940 \u0930\u093f\u0915\u0949\u0930\u094d\u0921 \u0939\u094b \u0917\u0908\u0964`);
      } catch (e:any) {
        alert("Upload failed: " + (e?.message || e));
      } finally {
        setCPodFor(null);
        setBusy(false);
      }
    };

    const triggerSOS = () => {
      if (!confirm("Send SOS alert to control room?\nक्या आप कंट्रोल रूम को SOS भेजना चाहते हैं?")) return;
      addSOS({ vnum: me?.vnum, driver: me?.driver, mobile: me?.mobile });
      alert("🚨 SOS sent. Help is on the way.\nSOS भेज दिया गया। मदद आ रही है।");
    };

    return (
      <div style={{minHeight:"100vh",background:"#f2f4f7",fontFamily:"'Inter','IBM Plex Sans',sans-serif",color:"#111827"}}>
        <style>{`
          @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@500;700&display=swap');
          .drv-load-card { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); border-radius: 14px; padding: 1rem; cursor: pointer; transition: all .15s; text-align: left; width: 100%; }
          .drv-load-card:hover { background: rgba(245,158,11,0.06); border-color: rgba(245,158,11,0.2); }
          .drv-consignee-btn { border-radius: 12px; padding: 0.9rem 1rem; cursor: pointer; display: flex; align-items: center; gap: 10; text-align: left; width: 100%; border: none; transition: all .15s; }
        `}</style>
        <header style={{background:"#ffffff",borderBottom:"1px solid #e4e7ed",padding:".85rem 1.1rem",display:"flex",alignItems:"center",justifyContent:"space-between",boxShadow:"0 1px 4px rgba(0,0,0,0.06)",position:"sticky",top:0,zIndex:10}}>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <div style={{width:36,height:36,borderRadius:9,background:"#111827",border:"none",display:"flex",alignItems:"center",justifyContent:"center",fontSize:"1.1rem"}}>🚛</div>
            <div>
              <div style={{fontSize:".58rem",letterSpacing:2.5,opacity:.6,fontWeight:700,textTransform:"uppercase",fontFamily:"'JetBrains Mono',monospace",color:"#6366f1"}}>Driver App</div>
              <div style={{fontWeight:700,fontSize:".95rem",color:"#111827"}}>{me?.vnum || session.vnum} · {me?.driver || "Driver"}</div>
            </div>
          </div>
          <button onClick={logout} style={{display:"inline-flex",alignItems:"center",gap:5,background:"#f2f4f7",border:"1px solid #e4e7ed",color:"#374151",padding:"6px 12px",borderRadius:8,cursor:"pointer",fontWeight:600,fontSize:".75rem"}}><LogOut size={14}/> Exit</button>
        </header>

        <main style={{maxWidth:600,margin:"0 auto",padding:"1rem"}}>
          {/* Assigned loads */}
          <div style={{fontSize:".58rem",letterSpacing:2,fontWeight:700,color:"rgba(245,158,11,0.85)",textTransform:"uppercase",margin:".9rem .1rem .5rem",fontFamily:"'JetBrains Mono',monospace"}}>Assigned Loads · {myLoads.length}</div>
          {myLoads.length === 0 ? (
            <div style={{background:"rgba(255,255,255,0.03)",border:"1px dashed rgba(255,255,255,0.1)",borderRadius:12,padding:"2rem",textAlign:"center",color:"#6b7280",fontSize:".88rem"}}>No loads assigned right now.</div>
          ) : (
            <div style={{display:"flex",flexDirection:"column",gap:".6rem",marginBottom:"1.2rem"}}>
              {myLoads.map(l => (
                <button key={l.id} onClick={()=>setOpenLoadId(l.id)} className="drv-load-card">
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:".6rem"}}>
                    <div style={{fontWeight:700,color:"#6366f1",fontFamily:"'JetBrains Mono',monospace",fontSize:".9rem"}}>{l.lid}</div>
                    <span style={{fontSize:".62rem",color:"#2563eb",background:"#eff6ff",border:"1px solid #bfdbfe",borderRadius:5,padding:"1px 6px",fontWeight:700,textTransform:"uppercase",letterSpacing:.5}}>Active</span>
                  </div>
                  <div style={{display:"flex",alignItems:"center",gap:".4rem",marginTop:".5rem",fontSize:".9rem",fontWeight:600,color:"#111827"}}>
                    <MapPin size={13} color="#f59e0b"/>
                    <span>{(l.origin||"").split(",")[0] || "—"}</span>
                    <span style={{color:"rgba(245,158,11,0.75)",margin:"0 2px"}}>→</span>
                    <span>{(l.dest||"").split(",")[0] || "—"}</span>
                  </div>
                  <div style={{fontSize:".72rem",color:"#6b7280",marginTop:".35rem"}}>{l.customer || "—"} · {l.commodity || "—"} · {l.weight || "—"}</div>
                  <div style={{marginTop:".5rem",fontSize:".68rem",color:"rgba(245,158,11,0.75)",fontWeight:700}}>Tap for details / LR, Invoice, POD →</div>
                </button>
              ))}
            </div>
          )}

          {/* BIG ACTION BUTTONS */}
          <div style={{display:"flex",flexDirection:"column",gap:".8rem",marginBottom:"1.2rem"}}>
            {(singleLoads.length > 0 || myLoads.length === 0) && (
            <button
              onClick={startDeliveredFlow}
              disabled={busy}
              style={{
                background:"linear-gradient(135deg,#16a34a,#15803d)",
                color:"#fff",border:"none",borderRadius:16,padding:"1.5rem",cursor:busy?"not-allowed":"pointer",
                boxShadow:"0 8px 28px rgba(22,163,74,0.3)",
                display:"flex",flexDirection:"column",alignItems:"center",gap:6,
                opacity: busy ? 0.7 : 1,
                transition:"all .15s",
              }}
            >
              <div style={{display:"flex",alignItems:"center",gap:10}}>
                <CheckCircle2 size={30}/>
                <span style={{fontSize:"1.5rem",fontWeight:800,letterSpacing:1,textTransform:"uppercase"}}>Delivered</span>
              </div>
              <span style={{fontSize:"1rem",fontWeight:600,opacity:.9}}>डिलीवरी हो गया</span>
              <span style={{fontSize:".7rem",opacity:.75,marginTop:2}}>📸 Tap to upload POD photo</span>
            </button>
            )}
          </div>

          {/* Per-consignee delivery cards (multi-consignee loads) */}
          {multiLoads.map(l => {
            const cdArr = (Array.isArray(l.consigneeDeliveries) ? l.consigneeDeliveries : []) as any[];
            const cds = [...(l.consignees||[]), l.dest].filter(Boolean).map((city:any, idx:number) => ({ city, delivered: !!cdArr[idx]?.delivered })) as any[];
            const done = cds.filter((x:any)=>x.delivered).length;
            return (
              <div key={l.id} style={{background:"#ffffff",border:"1px solid #e4e7ed",borderRadius:14,padding:"1rem",marginBottom:"1rem"}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:".5rem"}}>
                  <div style={{fontWeight:700,color:"#6366f1",fontFamily:"'JetBrains Mono',monospace",fontSize:".9rem"}}>{l.lid}</div>
                  <div style={{fontSize:".72rem",fontWeight:800,color: done===cds.length ? "#4ade80" : "#c0ccda"}}>{done}/{cds.length} ✓</div>
                </div>
                <div style={{fontSize:".82rem",color:"#cbd5e1",fontWeight:600,marginTop:4}}>{(l.origin||"").split(",")[0]} → {(l.dest||"").split(",")[0]}</div>
                <div style={{fontSize:".58rem",letterSpacing:1.5,color:"rgba(245,158,11,0.75)",fontWeight:700,textTransform:"uppercase",margin:".75rem 0 .4rem",fontFamily:"'JetBrains Mono',monospace"}}>Deliveries / डिलीवरी</div>
                <div style={{display:"flex",flexDirection:"column",gap:".5rem"}}>
                  {cds.map((cd:any,i:number)=>{
                    const hi = hindiCity(cd.city);
                    return (
                      <button key={i} disabled={cd.delivered || busy} onClick={()=>startConsigneePod(l.id,i)}
                        style={{background: cd.delivered ? "#dcfce7" : "#ffffff", color: cd.delivered ? "#15803d" : "#111827", border:`1px solid ${cd.delivered?"#86efac":"#e4e7ed"}`, borderRadius:12, padding:"0.9rem 1rem", cursor: cd.delivered ? "default" : "pointer", display:"flex", alignItems:"center", gap:10, textAlign:"left", opacity: (busy && !cd.delivered) ? 0.6 : 1, width:"100%", transition:"all .15s"}}>
                        <CheckCircle2 size={22} color={cd.delivered?"#4ade80":"#96a8ba"}/>
                        <span style={{flex:1}}>
                          <span style={{fontSize:".95rem",fontWeight:700,display:"block",lineHeight:1.3}}>{cd.city || `Consignee ${i+1}`}{hi ? `  (${hi})` : ""}</span>
                          <span style={{fontSize:".68rem",fontWeight:600,opacity:.8}}>{cd.delivered ? "✓ Delivered / डिलीवर हो गया" : "📸 Tap for POD photo / पीओडी फोटो लें"}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}

          {/* Load picker shown only when multiple loads & user tapped Delivered */}
          {podPickFor === "__choose__" && (
            <div style={{background:"#fffbeb",border:"1px solid #fde68a",borderRadius:12,padding:"1rem",marginBottom:"1rem"}}>
              <div style={{fontWeight:700,color:"#6366f1",marginBottom:".6rem",fontSize:".88rem"}}>Which load was delivered? / कौन सी लोड डिलीवर हुई?</div>
              <div style={{display:"flex",flexDirection:"column",gap:".4rem"}}>
                {singleLoads.map(l => (
                  <button key={l.id} onClick={()=>setPodPickFor(l.id)} style={{textAlign:"left",background:"#f2f4f7",border:"1px solid #fde68a",borderRadius:8,padding:".6rem .8rem",cursor:"pointer",color:"#111827",fontSize:".85rem"}}>
                    <b style={{color:"#6366f1",fontFamily:"'JetBrains Mono',monospace"}}>{l.lid}</b> · {(l.origin||"").split(",")[0]} → {(l.dest||"").split(",")[0]}
                  </button>
                ))}
                <button onClick={()=>setPodPickFor(null)} style={{background:"transparent",border:"none",color:"rgba(245,158,11,0.75)",fontWeight:600,fontSize:".78rem",cursor:"pointer",marginTop:4,textAlign:"left"}}>Cancel</button>
              </div>
            </div>
          )}

          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            capture="environment"
            style={{display:"none"}}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) { if (cPodFor) onConsigneePodFile(f); else onPodFile(f); } e.target.value = ""; }}
          />

          {/* SOS — bottom */}
          <div style={{marginTop:"1.2rem",marginBottom:"2rem"}}>
            <button
              onClick={triggerSOS}
              style={{
                width:"100%",
                boxSizing:"border-box",
                background:"linear-gradient(135deg,#dc2626,#991b1b)",
                color:"#fff",border:"none",borderRadius:16,padding:"1.3rem",cursor:"pointer",
                boxShadow:"0 8px 28px rgba(220,38,38,0.3)",
                display:"flex",flexDirection:"column",alignItems:"center",gap:4,
                transition:"all .15s",
              }}
            >
              <div style={{display:"flex",alignItems:"center",gap:10}}>
                <AlertOctagon size={28}/>
                <span style={{fontSize:"1.4rem",fontWeight:800,letterSpacing:2,textTransform:"uppercase"}}>SOS</span>
              </div>
              <span style={{fontSize:".9rem",fontWeight:600,opacity:.9}}>आपातकालीन सहायता</span>
            </button>
          </div>
        </main>

        {openLoad && (
          <Suspense fallback={null}>
            <LoadDetailsDialog
              load={openLoad}
              vehicle={me}
              gps={null}
              eta={me?.eta}
              onClose={()=>setOpenLoadId(null)}
            />
          </Suspense>
        )}

      </div>
    );
  }

  // ============== LOGIN ==============
  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@500;700&display=swap');
        .drv-login-root {
          min-height: 100vh;
          background: #f2f4f7;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 1rem;
          font-family: 'Inter', sans-serif;
          position: relative;
          overflow: hidden;
        }
        .drv-login-root::before {
          content: '';
          position: absolute;
          inset: 0;
          background:
            radial-gradient(ellipse 70% 50% at 50% -10%, rgba(245,158,11,0.08) 0%, transparent 60%),
            radial-gradient(ellipse 50% 40% at 90% 110%, rgba(56,189,248,0.05) 0%, transparent 60%);
          pointer-events: none;
        }
        .drv-login-grid {
          position: absolute;
          inset: 0;
          background-image:
            linear-gradient(rgba(255,255,255,0.012) 1px, transparent 1px),
            linear-gradient(90deg, rgba(255,255,255,0.012) 1px, transparent 1px);
          background-size: 48px 48px;
          pointer-events: none;
        }
        .drv-login-card {
          position: relative;
          background: rgba(16,21,36,0.97);
          border: 1px solid rgba(255,255,255,0.08);
          border-radius: 18px;
          max-width: 420px;
          width: 100%;
          padding: 2rem 1.8rem;
          box-shadow: 0 32px 80px rgba(0,0,0,0.7);
        }
        .drv-lbl {
          display: block;
          font-size: 0.6rem;
          font-family: 'JetBrains Mono', monospace;
          font-weight: 700;
          letter-spacing: 1.8px;
          color: rgba(180,194,208,0.85);
          text-transform: uppercase;
          margin-bottom: 6px;
        }
        .drv-inp {
          width: 100%;
          padding: 0.72rem 0.9rem;
          background: rgba(255,255,255,0.04);
          border: 1px solid rgba(255,255,255,0.09);
          border-radius: 9px;
          font-size: 0.95rem;
          color: #e2e8f0;
          font-family: 'JetBrains Mono', monospace;
          letter-spacing: 1px;
          outline: none;
          box-sizing: border-box;
          text-transform: uppercase;
          transition: border-color 0.15s, box-shadow 0.15s;
        }
        .drv-inp:focus {
          border-color: rgba(245,158,11,0.5);
          box-shadow: 0 0 0 3px rgba(245,158,11,0.07);
        }
        .drv-inp::placeholder { color: #6b7280; text-transform: none; }
        .drv-sug { position: absolute; top: 100%; left: 0; right: 0; margin-top: 4px; background: #131d2e; border: 1px solid rgba(255,255,255,0.1); border-radius: 10px; box-shadow: 0 12px 36px rgba(0,0,0,0.5); max-height: 240px; overflow-y: auto; z-index: 10; }
        .drv-sug-btn { width: 100%; text-align: left; background: transparent; border: none; border-bottom: 1px solid rgba(255,255,255,0.05); padding: .55rem .8rem; cursor: pointer; transition: background .1s; }
        .drv-sug-btn:hover { background: #f7f8fa; }
        .drv-sug-btn:last-child { border-bottom: none; }
        .drv-login-btn {
          width: 100%;
          margin-top: 16px;
          padding: 0.8rem;
          border: none;
          border-radius: 9px;
          font-size: 0.82rem;
          font-weight: 700;
          letter-spacing: 1.5px;
          text-transform: uppercase;
          font-family: 'JetBrains Mono', monospace;
          cursor: pointer;
          transition: all 0.2s;
        }
        .drv-login-btn:not(:disabled) {
          background: #111827;
          color: #ffffff;
          box-shadow: 0 2px 8px rgba(0,0,0,0.12);
        }
        .drv-login-btn:not(:disabled):hover { background: #1f2937; }
        .drv-login-btn:disabled { background: #f7f8fa; color: rgba(148,163,184,0.3); cursor: not-allowed; }
      `}</style>
      <div className="drv-login-root">
        <div className="drv-login-grid" />
        <div className="drv-login-card">
          <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:24}}>
            <div style={{width:44,height:44,borderRadius:11,background:"#111827",border:"none",display:"flex",alignItems:"center",justifyContent:"center",fontSize:"1.3rem",flexShrink:0}}>🚛</div>
            <div>
              <div style={{fontSize:".58rem",letterSpacing:2.5,fontWeight:700,color:"rgba(245,158,11,0.85)",textTransform:"uppercase",fontFamily:"'JetBrains Mono',monospace",marginBottom:2}}>Driver App</div>
              <div style={{fontWeight:700,fontSize:"1.1rem",color:"#111827"}}>Sign in with PIN</div>
            </div>
          </div>

          <p style={{fontSize:".78rem",color:"#6b7280",marginBottom:"1.1rem",lineHeight:1.5}}>Type your vehicle number and select from suggestions, then enter your 4-digit PIN.</p>

          {syncing && (
            <div className="drv-syncing" style={{fontSize:".7rem",color:"#2563eb",marginBottom:".8rem",fontWeight:600,display:"flex",alignItems:"center",gap:7,fontFamily:"'JetBrains Mono',monospace"}}>
              <span style={{display:"inline-block",width:10,height:10,border:"2px solid rgba(56,189,248,0.6)",borderTopColor:"transparent",borderRadius:"50%",animation:"spin 0.9s linear infinite"}}></span>
              Syncing from cloud…
            </div>
          )}

          {/* Autosuggest input */}
          <div style={{position:"relative",marginBottom:14}}>
            <label className="drv-lbl">Vehicle Number</label>
            <input
              autoFocus
              value={vQuery}
              onChange={e=>{ setVQuery(e.target.value.toUpperCase()); setPickedVnum(null); setShowSug(true); setError(""); }}
              onFocus={()=>setShowSug(true)}
              onBlur={()=>setTimeout(()=>setShowSug(false),150)}
              placeholder="e.g. HR55AB1234"
              className="drv-inp"
              style={{borderColor: pickedVnum ? "rgba(74,222,128,0.4)" : undefined}}
            />
            {showSug && vQuery && suggestions.length > 0 && !pickedVnum && (
              <div className="drv-sug">
                {suggestions.map(v => (
                  <button key={v.id} type="button" onMouseDown={(e)=>{e.preventDefault(); pickVehicle(v);}} className="drv-sug-btn">
                    <div style={{fontWeight:700,color:"#111827",fontSize:".88rem",fontFamily:"'JetBrains Mono',monospace"}}>{v.vnum}</div>
                    <div style={{fontSize:".7rem",color:"#6b7280"}}>{v.driver || "—"} {v.mobile ? "· "+v.mobile : ""}</div>
                  </button>
                ))}
              </div>
            )}
            {showSug && vQuery && suggestions.length === 0 && (
              <div className="drv-sug" style={{padding:".6rem .9rem",fontSize:".76rem",color:"#6b7280"}}>
                No matches — vehicle must be registered in TMS.
              </div>
            )}
          </div>

          {pickedVnum && (
            <div style={{marginBottom:4}}>
              <label className="drv-lbl">4-Digit PIN</label>
              <input
                autoFocus
                type="password"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={4}
                value={pinEntry}
                onChange={e=>{ setPinEntry(e.target.value.replace(/\D/g,"").slice(0,4)); setError(""); }}
                onKeyDown={e=>{ if(e.key==="Enter") handleLogin(); }}
                placeholder="••••"
                style={{width:"100%",fontSize:"1.8rem",letterSpacing:".7rem",textAlign:"center",padding:".65rem",background:"#ffffff",border:"1px solid #d0d5de",borderRadius:9,fontFamily:"'JetBrains Mono',monospace",outline:"none",color:"#111827",boxSizing:"border-box",transition:"border-color .15s"}}
              />
            </div>
          )}

          {error && <div style={{color:"#dc2626",fontSize:".76rem",marginTop:".5rem",display:"flex",alignItems:"center",gap:5}}>⚠ {error}</div>}

          <button
            onClick={handleLogin}
            disabled={syncing || !pickedVnum || pinEntry.length !== 4}
            className="drv-login-btn"
          >
            {syncing ? "Syncing…" : "Log in →"}
          </button>

          <div style={{marginTop:18,paddingTop:14,borderTop:"1px solid #f0f2f5",textAlign:"center"}}>
            <Link to="/app" style={{fontSize:".7rem",color:"rgba(160,178,196,0.8)",textDecoration:"none",fontFamily:"'JetBrains Mono',monospace",letterSpacing:.5,transition:"color .15s"}}>← Back to TMS dashboard</Link>
          </div>
        </div>
      </div>
    </>
  );
}

function Tile({ k, v }: { k: string; v?: any }) {
  return (
    <div style={{background:"#f9fafb",border:"1px solid #f3f4f6",borderRadius:8,padding:".5rem .7rem"}}>
      <div style={{fontSize:".62rem",fontWeight:700,letterSpacing:1.2,color:"#6b7280",textTransform:"uppercase"}}>{k}</div>
      <div style={{fontSize:".82rem",fontWeight:600,color:"#1f2937",marginTop:2}}>{v || "—"}</div>
    </div>
  );
}
