import React, { useMemo, useState } from "react";
import { PrettyDateTime } from "./PrettyDatePicker";

// Step order — drives "next" CTA on the manage page
const STEPS = [
  { key: "occurrence",   label: "Occurrence",       icon: "🔧" },
  { key: "acknowledged", label: "Acknowledge",      icon: "✅" },
  { key: "vendor",       label: "Maintenance Vendor", icon: "🏭" },
  { key: "technician",   label: "Assign Technician", icon: "🛠️" },
  { key: "repairStart",  label: "Repair Started",   icon: "🔨" },
  { key: "repairDone",   label: "Repair Completed", icon: "🎯" },
  { key: "closed",       label: "Breakdown Closed", icon: "🏁" },
];

const stepIndex = (k) => STEPS.findIndex(s => s.key === k);

function toLocalInput(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fromLocalInput(s) {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
}
function fmtDuration(ms) {
  if (ms == null || isNaN(ms) || ms < 0) return "—";
  const sec = Math.floor(ms / 1000);
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return `${sec}s`;
}
function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-IN", { day:"2-digit", month:"short", hour:"numeric", minute:"2-digit", hour12:true });
}

const FIELDS = {
  occurrence: [
    { name: "details", label: "Occurrence Details", type: "textarea", required: true, ph: "What happened?" },
    { name: "at",      label: "Occurred At",        type: "datetime", required: true },
  ],
  acknowledged: [
    { name: "at",      label: "Acknowledge Time",   type: "datetime", required: true },
  ],
  vendor: [
    { name: "name",    label: "Vendor Name",        type: "text", required: true, ph: "ABC Auto Repair" },
    { name: "at",      label: "Assigned At",        type: "datetime", required: true },
  ],
  technician: [
    { name: "name",       label: "Technician Name", type: "text", required: true, ph: "e.g. Ramesh" },
    { name: "assignedAt", label: "Assigned At",     type: "datetime", required: true },
    { name: "etaArrive",  label: "ETA to Arrive",   type: "datetime" },
  ],
  repairStart: [
    { name: "at",         label: "Repair Started At", type: "datetime", required: true },
    { name: "etaFinish",  label: "ETA to Finish",     type: "datetime" },
  ],
  repairDone: [
    { name: "at",         label: "Repair Completed At", type: "datetime", required: true },
  ],
  closed: [
    { name: "at",         label: "Closed At",        type: "datetime", required: true },
  ],
};

function emptyForStep(key, maint) {
  const existing = maint?.[key] || {};
  const nowIso = new Date().toISOString();
  const base = { notes: existing.notes || "" };
  for (const f of FIELDS[key]) {
    if (f.type === "datetime") base[f.name] = existing[f.name] || nowIso;
    else base[f.name] = existing[f.name] || "";
  }
  return base;
}

function MaintStepModal({ stepKey, initial, onClose, onSave, isLast }) {
  const [form, setForm] = useState(initial);
  const step = STEPS.find(s => s.key === stepKey);
  const fields = FIELDS[stepKey];

  const set = (k, v) => setForm(p => ({ ...p, [k]: v }));

  const handleSave = (advance) => {
    for (const f of fields) {
      if (f.required && !String(form[f.name]||"").trim()) {
        alert(`${f.label} is required.`);
        return;
      }
    }
    onSave(form, advance);
  };

  return (
    <div onClick={onClose} style={{position:"fixed",inset:0,background:"rgba(15,23,42,.55)",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",padding:"1rem"}}>
      <div onClick={e=>e.stopPropagation()} style={{background:"var(--surface)",border:"1px solid var(--border)",borderRadius:10,width:"100%",maxWidth:520,boxShadow:"0 20px 60px rgba(0,0,0,.25)",overflow:"hidden"}}>
        <div style={{padding:"1rem 1.2rem",borderBottom:"1px solid var(--border)",display:"flex",alignItems:"center",gap:10,background:"var(--surface2)"}}>
          <span style={{fontSize:"1.4rem"}}>{step.icon}</span>
          <div style={{fontFamily:"var(--font-head)",fontWeight:800,fontSize:".95rem",letterSpacing:2,textTransform:"uppercase",color:"var(--text)"}}>{step.label}</div>
        </div>
        <div style={{padding:"1rem 1.2rem",display:"flex",flexDirection:"column",gap:".75rem",maxHeight:"65vh",overflowY:"auto"}}>
          {fields.map(f => (
            <div key={f.name}>
              <label style={{display:"block",fontSize:".62rem",fontFamily:"var(--font-head)",fontWeight:700,letterSpacing:2,textTransform:"uppercase",color:"#1f2937",marginBottom:4}}>
                {f.label}{f.required && <span style={{color:"#dc2626"}}> *</span>}
              </label>
              {f.type === "datetime" ? (
                <PrettyDateTime value={toLocalInput(form[f.name])} onChange={(v)=>set(f.name, fromLocalInput(v))}/>
              ) : f.type === "textarea" ? (
                <textarea value={form[f.name]||""} onChange={e=>set(f.name, e.target.value)} placeholder={f.ph||""} rows={3}
                  style={{width:"100%",background:"var(--surface2)",border:"1px solid var(--border)",color:"var(--text)",padding:".5rem .65rem",borderRadius:6,fontFamily:"var(--font-body)",fontSize:".86rem",outline:"none",resize:"vertical"}}/>
              ) : (
                <input type="text" value={form[f.name]||""} onChange={e=>set(f.name, e.target.value)} placeholder={f.ph||""}
                  style={{width:"100%",background:"var(--surface2)",border:"1px solid var(--border)",color:"var(--text)",padding:".5rem .65rem",borderRadius:6,fontFamily:"var(--font-body)",fontSize:".86rem",outline:"none"}}/>
              )}
            </div>
          ))}
          <div>
            <label style={{display:"block",fontSize:".62rem",fontFamily:"var(--font-head)",fontWeight:700,letterSpacing:2,textTransform:"uppercase",color:"#1f2937",marginBottom:4}}>Notes</label>
            <textarea value={form.notes||""} onChange={e=>set("notes", e.target.value)} placeholder="Optional notes…" rows={3}
              style={{width:"100%",background:"var(--surface2)",border:"1px solid var(--border)",color:"var(--text)",padding:".5rem .65rem",borderRadius:6,fontFamily:"var(--font-body)",fontSize:".86rem",outline:"none",resize:"vertical"}}/>
          </div>
        </div>
        <div style={{padding:".8rem 1.2rem",borderTop:"1px solid var(--border)",display:"flex",gap:8,justifyContent:"flex-end",background:"var(--surface2)"}}>
          <button onClick={onClose} style={btn("ghost")}>Close</button>
          <button onClick={()=>handleSave(false)} style={btn("secondary")}>Save</button>
          {!isLast && <button onClick={()=>handleSave(true)} style={btn("primary")}>Save & Next</button>}
        </div>
      </div>
    </div>
  );
}

function btn(kind) {
  const base = {border:"1px solid var(--border)",padding:".5rem .9rem",borderRadius:6,fontFamily:"var(--font-head)",fontWeight:700,fontSize:".78rem",letterSpacing:1,textTransform:"uppercase",cursor:"pointer"};
  if (kind === "primary") return {...base,background:"var(--accent2,#0ea5e9)",color:"#fff",borderColor:"transparent"};
  if (kind === "secondary") return {...base,background:"#1f2937",color:"#fff",borderColor:"transparent"};
  if (kind === "danger") return {...base,background:"#dc2626",color:"#fff",borderColor:"transparent"};
  return {...base,background:"var(--surface)",color:"var(--text)"};
}

function kpiCard(label, value, sub) {
  return (
    <div style={{background:"var(--surface)",border:"1px solid var(--border)",borderRadius:10,padding:".75rem .9rem",minWidth:140,flex:"1 1 140px"}}>
      <div style={{fontSize:".58rem",fontFamily:"var(--font-head)",fontWeight:700,letterSpacing:2,textTransform:"uppercase",color:"#6b7280",marginBottom:4}}>{label}</div>
      <div style={{fontFamily:"var(--font-head)",fontWeight:800,fontSize:"1.15rem",color:"var(--text)"}}>{value}</div>
      {sub && <div style={{fontSize:".68rem",color:"#6b7280",marginTop:2}}>{sub}</div>}
    </div>
  );
}

export default function MaintManagePage({ loadId, incidentLoads, setIncidentLoads, loads, vehicles, clearIncident, addLLog, onBack, readOnly = false, archiveMaintLog }) {
  const [openStep, setOpenStep] = useState(null);

  const load = loads.find(l => l.id === loadId);
  const inc = incidentLoads[loadId];
  const vehicle = load?.vehicleId ? vehicles.find(v => v.id === load.vehicleId) : null;

  // Seed maint with an Occurrence entry derived from the original report on first open
  const maint = useMemo(() => {
    if (!inc) return null;
    if (inc.maint) return inc.maint;
    const reportedIso = (() => {
      // reportedAt is "DD/MM/YYYY, hh:mm:ss am/pm" from toLocaleString("en-IN")
      // Best effort: try Date parse, else fall back to now
      const d = new Date(inc.reportedAt);
      return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
    })();
    return {
      occurrence: { at: reportedIso, details: inc.note || "", notes: "" },
      events: [{ id: 1, kind: "occurrence", at: reportedIso, summary: "Breakdown reported", notes: inc.note || "", fields: { at: reportedIso, details: inc.note || "" } }],
    };
  }, [inc]);

  if (!inc || !load) {
    return (
      <div style={{padding:"2rem",fontFamily:"var(--font-body)"}}>
        <button onClick={onBack} style={btn("ghost")}>← Back</button>
        <div style={{marginTop:"1rem",color:"#6b7280"}}>Incident not found.</div>
      </div>
    );
  }

  const upsertEvent = (events, entry) => {
    const list = Array.isArray(events) ? [...events] : [];
    const idx = list.findIndex(e => e.kind === entry.kind);
    if (idx >= 0) {
      list[idx] = { ...list[idx], ...entry, id: list[idx].id };
    } else {
      list.push({ ...entry, id: Date.now() + Math.floor(Math.random()*1000) });
    }
    return list;
  };

  const persist = (newMaint, eventEntry) => {
    setIncidentLoads(p => {
      const cur = p[loadId];
      if (!cur) return p;
      const baseEvents = (cur.maint?.events) || (maint.events || []);
      const events = eventEntry ? upsertEvent(baseEvents, eventEntry) : baseEvents;
      return { ...p, [loadId]: { ...cur, maint: { ...newMaint, events } } };
    });
  };

  const fieldsForStep = (stepKey, form) => {
    const pick = (keys) => keys.reduce((a,k)=> (form[k]!==undefined ? (a[k]=form[k], a) : a), {});
    if (stepKey === "occurrence")   return pick(["at","details"]);
    if (stepKey === "acknowledged") return pick(["at"]);
    if (stepKey === "vendor")       return pick(["name","at"]);
    if (stepKey === "technician")   return pick(["name","assignedAt","etaArrive"]);
    if (stepKey === "repairStart")  return pick(["at","etaFinish"]);
    if (stepKey === "repairDone")   return pick(["at"]);
    if (stepKey === "closed")       return pick(["at"]);
    return {};
  };

  const handleSave = (stepKey, form, advance) => {
    const eventAt = form.at || form.assignedAt || new Date().toISOString();
    const summary = stepKey === "vendor" ? `Vendor assigned`
      : stepKey === "technician" ? `Technician assigned`
      : stepKey === "repairStart" ? `Repair started`
      : stepKey === "repairDone" ? `Repair completed`
      : stepKey === "closed" ? `Breakdown closed`
      : stepKey === "acknowledged" ? `Acknowledged`
      : `Breakdown reported`;
    const nowIso = new Date().toISOString();
    const stored = { ...form, _modifiedAt: nowIso };
    const newMaint = { ...maint, [stepKey]: stored };
    const eventEntry = { kind: stepKey, at: eventAt, summary, notes: form.notes||"", fields: fieldsForStep(stepKey, form), modifiedAt: nowIso };
    persist(newMaint, eventEntry);
    addLLog && addLLog(`🔧 ${load.lid}: ${summary}`, "#0ea5e9");

    if (stepKey === "closed") {
      // Save closed step, archive log, then clear the incident from active list
      setTimeout(() => {
        const finalEvents = upsertEvent((maint?.events)||[], { ...eventEntry, id: Date.now() });
        const finalMaint = { ...newMaint, events: finalEvents };
        archiveMaintLog && archiveMaintLog(loadId, finalMaint);
        clearIncident && clearIncident(loadId);
        onBack && onBack();
      }, 50);
      return;
    }
    setOpenStep(null);
    if (advance) {
      const idx = stepIndex(stepKey);
      const next = STEPS[idx+1];
      if (next) setTimeout(()=>setOpenStep(next.key), 80);
    }
  };

  const nextStepKey = useMemo(() => {
    for (const s of STEPS) {
      if (!maint?.[s.key]) return s.key;
    }
    return null;
  }, [maint]);

  // KPIs
  const t = {
    occ:  maint?.occurrence?.at && new Date(maint.occurrence.at).getTime(),
    ack:  maint?.acknowledged?.at && new Date(maint.acknowledged.at).getTime(),
    ven:  maint?.vendor?.at && new Date(maint.vendor.at).getTime(),
    tasn: maint?.technician?.assignedAt && new Date(maint.technician.assignedAt).getTime(),
    rs:   maint?.repairStart?.at && new Date(maint.repairStart.at).getTime(),
    rd:   maint?.repairDone?.at && new Date(maint.repairDone.at).getTime(),
    cl:   maint?.closed?.at && new Date(maint.closed.at).getTime(),
  };
  const kpis = {
    ack: t.ack && t.occ ? t.ack - t.occ : null,
    ven: t.ven && t.ack ? t.ven - t.ack : null,
    arr: t.rs && t.tasn ? t.rs - t.tasn : null,
    rep: t.rd && t.rs ? t.rd - t.rs : null,
    down: t.occ ? ((t.cl || Date.now()) - t.occ) : null,
  };

  return (
    <div style={{flex:1,overflowY:"auto",background:"var(--bg)",padding:"1rem 1.3rem"}}>
      {/* Top bar */}
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:10,marginBottom:"1rem"}}>
        <div style={{display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
          <button onClick={onBack} style={btn("ghost")}>← Back{readOnly ? " to Maint Logs" : " to Incidents"}</button>
          <div style={{fontFamily:"var(--font-mono)",fontWeight:800,fontSize:"1.05rem",color:"var(--accent2)"}}>{load.lid}</div>
          <span style={{background: readOnly?"#dcfce7":"#fee2e2",color: readOnly?"#15803d":"#b91c1c",border:`1px solid ${readOnly?"#86efac":"#fca5a5"}`,borderRadius:12,padding:"2px 10px",fontSize:".7rem",fontFamily:"var(--font-head)",fontWeight:800,letterSpacing:1}}>{readOnly ? "🏁 CLOSED" : "🔧 BREAKDOWN"}</span>
          <div style={{fontSize:".82rem",color:"#1f2937"}}>
            <strong>{inc.vehicleNum}</strong>{vehicle?.driver && ` · ${vehicle.driver}`}{vehicle?.mobile && ` · ${vehicle.mobile}`}
          </div>
        </div>
      </div>

      {/* KPIs */}
      <div style={{display:"flex",gap:".7rem",flexWrap:"wrap",marginBottom:"1rem"}}>
        {kpiCard("Time to Acknowledge", fmtDuration(kpis.ack), kpis.ack==null?"awaiting ack":null)}
        {kpiCard("Time to Assign Vendor", fmtDuration(kpis.ven), kpis.ven==null?"awaiting vendor":null)}
        {kpiCard("Time to Arrival", fmtDuration(kpis.arr), kpis.arr==null?"awaiting repair start":null)}
        {kpiCard("Repair Duration", fmtDuration(kpis.rep), kpis.rep==null?"in progress":null)}
        {kpiCard("Total Downtime", fmtDuration(kpis.down), t.cl?"closed":"running")}
      </div>

      <div style={{display:"grid",gridTemplateColumns:"minmax(0, 1.4fr) minmax(0, 1fr)",gap:"1rem"}}>
        {/* Activity timeline */}
        <div style={{background:"var(--surface)",border:"1px solid var(--border)",borderRadius:10,padding:"1rem"}}>
          <div style={{fontFamily:"var(--font-head)",fontWeight:800,fontSize:".9rem",letterSpacing:2,textTransform:"uppercase",color:"var(--text)",marginBottom:".8rem"}}>Activity Timeline</div>
          {(maint?.events?.length ? [...maint.events].reverse() : []).map(ev => {
            const meta = STEPS.find(s => s.key === ev.kind);
            const f = ev.fields || {};
            const metaBits = [];
            if (ev.kind === "vendor") {
              if (f.name) metaBits.push(`Vendor: ${f.name}`);
              if (f.at) metaBits.push(`Assigned ${fmtTime(f.at)}`);
            } else if (ev.kind === "technician") {
              if (f.name) metaBits.push(`Technician: ${f.name}`);
              if (f.assignedAt) metaBits.push(`Assigned ${fmtTime(f.assignedAt)}`);
              if (f.etaArrive) metaBits.push(`ETA arrive ${fmtTime(f.etaArrive)}`);
            } else if (ev.kind === "repairStart") {
              if (f.at) metaBits.push(`Started ${fmtTime(f.at)}`);
              if (f.etaFinish) metaBits.push(`ETA finish ${fmtTime(f.etaFinish)}`);
            } else if (ev.kind === "repairDone") {
              if (f.at) metaBits.push(`Completed ${fmtTime(f.at)}`);
            } else if (ev.kind === "acknowledged") {
              if (f.at) metaBits.push(`Acknowledged ${fmtTime(f.at)}`);
            } else if (ev.kind === "closed") {
              if (f.at) metaBits.push(`Closed ${fmtTime(f.at)}`);
            } else if (ev.kind === "occurrence") {
              if (f.at) metaBits.push(`Occurred ${fmtTime(f.at)}`);
            }
            const detailsText = ev.kind === "occurrence" ? (f.details || "") : "";
            return (
              <div key={ev.id} style={{display:"flex",gap:10,padding:".6rem 0",borderBottom:"1px dashed var(--border)"}}>
                <div style={{fontSize:"1.2rem"}}>{meta?.icon || "•"}</div>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{display:"flex",justifyContent:"space-between",gap:8,flexWrap:"wrap"}}>
                    <div style={{fontFamily:"var(--font-head)",fontWeight:700,fontSize:".82rem",color:"var(--text)"}}>{ev.summary}</div>
                    <div style={{fontSize:".7rem",color:"#6b7280"}}>{fmtTime(ev.at)}</div>
                  </div>
                  {metaBits.length>0 && <div style={{fontSize:".75rem",color:"#374151",marginTop:3}}>{metaBits.join(" · ")}</div>}
                  {detailsText && <div style={{fontSize:".78rem",color:"#374151",marginTop:3,whiteSpace:"pre-wrap"}}>{detailsText}</div>}
                  {ev.notes && <div style={{fontSize:".75rem",color:"#6b7280",marginTop:3,whiteSpace:"pre-wrap",fontStyle:"italic"}}>📝 {ev.notes}</div>}
                </div>
              </div>
            );
          })}
          {!maint?.events?.length && <div style={{color:"#6b7280",fontSize:".82rem"}}>No activity yet.</div>}
        </div>

        {/* Next action + steps */}
        <div style={{display:"flex",flexDirection:"column",gap:"1rem"}}>
          <div style={{background:"var(--surface)",border:"1px solid var(--border)",borderRadius:10,padding:"1rem"}}>
            <div style={{fontSize:".6rem",fontFamily:"var(--font-head)",fontWeight:700,letterSpacing:2,textTransform:"uppercase",color:"#6b7280",marginBottom:6}}>Next Action</div>
            {readOnly ? (
              <div style={{color:"#16a34a",fontWeight:700,fontFamily:"var(--font-head)",fontSize:".86rem"}}>Archived — read only.</div>
            ) : nextStepKey ? (
              <button onClick={()=>setOpenStep(nextStepKey)} style={{...btn("primary"),width:"100%",padding:".9rem",fontSize:".95rem"}}>
                {STEPS.find(s=>s.key===nextStepKey).icon} {STEPS.find(s=>s.key===nextStepKey).label}
              </button>
            ) : (
              <div style={{color:"#16a34a",fontWeight:700,fontFamily:"var(--font-head)",fontSize:".86rem"}}>All steps completed.</div>
            )}
          </div>

          <div style={{background:"var(--surface)",border:"1px solid var(--border)",borderRadius:10,padding:"1rem"}}>
            <div style={{fontFamily:"var(--font-head)",fontWeight:800,fontSize:".82rem",letterSpacing:2,textTransform:"uppercase",color:"var(--text)",marginBottom:".7rem"}}>Steps</div>
            <div style={{display:"flex",flexDirection:"column",gap:6}}>
              {STEPS.map(s => {
                const done = !!maint?.[s.key];
                return (
                  <div key={s.key} style={{display:"flex",alignItems:"center",gap:8,padding:".5rem .65rem",border:"1px solid var(--border)",borderRadius:7,background: done? "#ecfdf5":"var(--surface2)"}}>
                    <span style={{fontSize:"1.05rem"}}>{s.icon}</span>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontFamily:"var(--font-head)",fontWeight:700,fontSize:".8rem",color:"var(--text)"}}>{s.label}</div>
                      <div style={{fontSize:".7rem",color:"#6b7280"}}>{done ? `updated ${fmtTime(maint[s.key]._modifiedAt || maint[s.key].at || maint[s.key].assignedAt)}` : "pending"}</div>
                    </div>
                    {!readOnly && <button onClick={()=>setOpenStep(s.key)} style={{...btn("ghost"),padding:".35rem .6rem",fontSize:".68rem"}}>{done?"Edit":"Start"}</button>}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {!readOnly && openStep && (
        <MaintStepModal
          stepKey={openStep}
          initial={emptyForStep(openStep, maint)}
          isLast={openStep === "closed"}
          onClose={()=>setOpenStep(null)}
          onSave={(form, advance)=>handleSave(openStep, form, advance)}
        />
      )}
    </div>
  );
}
