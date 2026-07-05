import { useState, useEffect, useRef, useMemo } from "react";
import { createPortal } from "react-dom";

// Display: DD-MM-YY (e.g. 09-06-26)
// Storage: "YYYY-MM-DD" for date; "YYYY-MM-DDTHH:mm" for datetime (local, no TZ)

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const WEEK = ["Mo","Tu","We","Th","Fr","Sa","Su"];

const pad = (n) => String(n).padStart(2, "0");
const getViewportWidth = () => {
  if (typeof window === "undefined") return 1024;
  const widths = [
    window.visualViewport?.width,
    document.documentElement?.clientWidth,
    window.innerWidth,
  ].filter(Boolean);
  return Math.min(...widths);
};
const isCompactViewport = () => getViewportWidth() <= 640;

function parseDateStr(s) {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s));
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2])-1, Number(m[3]));
}
function parseDateTimeStr(s) {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(s));
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2])-1, Number(m[3]), Number(m[4]), Number(m[5]));
}
function fmtDateOnly(d) {
  if (!d) return "";
  return `${pad(d.getDate())}-${pad(d.getMonth()+1)}-${String(d.getFullYear()).slice(2)}`;
}
function to12h(h24) {
  const h = Number(h24);
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return { h12, period };
}
function to24h(h12, period) {
  let h = Number(h12) % 12;
  if (period === "PM") h += 12;
  return h;
}
function fmtTime12(d) {
  if (!d) return "";
  const { h12, period } = to12h(d.getHours());
  return `${pad(h12)}:${pad(d.getMinutes())} ${period}`;
}
function fmtDateTime(d) {
  if (!d) return "";
  return `${fmtDateOnly(d)} ${fmtTime12(d)}`;
}
function toDateStr(d) {
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}
function toDateTimeStr(d) {
  return `${toDateStr(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function useClickOutside(ref, onOutside, active) {
  useEffect(() => {
    if (!active) return;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) onOutside(); };
    const onKey = (e) => { if (e.key === "Escape") onOutside(); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [ref, onOutside, active]);
}

function CalendarPanel({ selected, onPick, min, max }) {
  const isMobile = isCompactViewport();
  const today = useMemo(() => { const t = new Date(); t.setHours(0,0,0,0); return t; }, []);
  const [view, setView] = useState(() => selected || today);
  const [mode, setMode] = useState("days"); // days | months | years
  useEffect(() => { if (selected) setView(selected); }, [selected?.getTime()]);

  const minD = min ? parseDateStr(min) : null;
  const maxD = max ? parseDateStr(max) : null;
  const stripTime = (d) => { const x = new Date(d); x.setHours(0,0,0,0); return x; };
  const disabled = (d) => (minD && d < stripTime(minD)) || (maxD && d > stripTime(maxD));

  const year = view.getFullYear();
  const month = view.getMonth();
  const first = new Date(year, month, 1);
  const startIdx = (first.getDay() + 6) % 7;
  const daysInMonth = new Date(year, month+1, 0).getDate();
  const cells = [];
  for (let i = 0; i < startIdx; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(year, month, d));
  while (cells.length % 7 !== 0) cells.push(null);

  const sameDay = (a, b) => a && b && a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth() && a.getDate()===b.getDate();

  const navMonth = (delta) => setView(new Date(year, month+delta, 1));
  const navYear = (delta) => setView(new Date(year+delta, month, 1));

  return (
    <div className="pretty-date-picker" style={{padding:isMobile ? "12px 14px" : "10px 12px", width: isMobile ? "min(332px, calc(100vw - 28px))" : 264}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
        <button type="button" onClick={()=>navMonth(-1)} style={navBtn}>‹</button>
        <button type="button" onClick={()=>setMode(mode==="days"?"months":"days")} style={{background:"transparent",border:"none",fontFamily:"var(--font-head)",fontWeight:800,fontSize:".82rem",letterSpacing:1,textTransform:"uppercase",color:"var(--text)",cursor:"pointer",padding:"4px 8px",borderRadius:6}}>
          {MONTHS[month]} {year}
        </button>
        <button type="button" onClick={()=>navMonth(1)} style={navBtn}>›</button>
      </div>

      {mode === "days" && (
        <>
          <div className="pretty-date-week-grid" style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:2,marginBottom:4}}>
            {WEEK.map(w => <div key={w} style={{textAlign:"center",fontFamily:"var(--font-head)",fontSize:".58rem",fontWeight:700,letterSpacing:1,color:"#6b7280",padding:"4px 0"}}>{w}</div>)}
          </div>
          <div className="pretty-date-day-grid" style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:2}}>
            {cells.map((d,i) => {
              if (!d) return <div key={i} />;
              const isSel = sameDay(d, selected);
              const isToday = sameDay(d, today);
              const dis = disabled(d);
              return (
                <button key={i} type="button" disabled={dis} onClick={()=>onPick(d)} style={{
                  background: isSel ? "var(--accent, #2563eb)" : "transparent",
                  color: isSel ? "#fff" : dis ? "#cbd5e1" : "var(--text)",
                  border: isToday && !isSel ? "1.5px solid var(--accent, #2563eb)" : "1.5px solid transparent",
                  borderRadius: 6,
                  padding: isMobile ? "9px 0" : "6px 0",
                  fontFamily: "var(--font-mono)",
                  fontSize: isMobile ? ".86rem" : ".78rem",
                  fontWeight: isSel ? 800 : 500,
                  cursor: dis ? "not-allowed" : "pointer",
                  opacity: dis ? .4 : 1,
                }}>{d.getDate()}</button>
              );
            })}
          </div>
        </>
      )}

      {mode === "months" && (
        <div className="pretty-date-month-grid" style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:6}}>
          {MONTHS.map((m,i) => (
            <button key={m} type="button" onClick={()=>{setView(new Date(year,i,1)); setMode("days");}} style={{
              background: i===month ? "var(--accent, #2563eb)" : "transparent",
              color: i===month ? "#fff" : "var(--text)",
              border:"1px solid var(--border)",borderRadius:6,padding:"8px 0",
              fontFamily:"var(--font-head)",fontSize:".74rem",fontWeight:700,cursor:"pointer"
            }}>{m}</button>
          ))}
          <div style={{gridColumn:"1 / -1",display:"flex",justifyContent:"space-between",marginTop:4}}>
            <button type="button" onClick={()=>navYear(-1)} style={navBtn}>‹ {year-1}</button>
            <button type="button" onClick={()=>navYear(1)} style={navBtn}>{year+1} ›</button>
          </div>
        </div>
      )}
    </div>
  );
}

const navBtn = {
  background:"transparent",border:"1px solid var(--border)",borderRadius:6,
  padding:"4px 10px",cursor:"pointer",fontFamily:"var(--font-head)",fontWeight:700,
  fontSize:".78rem",color:"var(--text)"
};

function TriggerButton({ display, placeholder, open, onClick, style, icon = "📅" }) {
  return (
    <button type="button" onClick={onClick} style={{
      width:"100%",textAlign:"left",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"space-between",gap:8,
      background:"var(--bg)",border:"1px solid var(--border)",color: display ? "var(--text)" : "#9ca3af",
      padding:".5rem .7rem",borderRadius:6,fontFamily:"var(--font-mono)",fontSize:".84rem",outline:"none",
      boxShadow: open ? "0 0 0 2px rgba(37,99,235,.25)" : "none",
      ...(style||{})
    }}>
      <span>{display || placeholder}</span>
      <span style={{fontSize:".9rem",opacity:.6}}>{icon}</span>
    </button>
  );
}

function Panel({ children, anchorRef, onClose, closeOnOutside = true }) {
  const ref = useRef(null);
  const isMobile = isCompactViewport();
  useClickOutside(ref, onClose, !isMobile && closeOnOutside);
  const [style, setStyle] = useState({ position:"fixed", top:0, left:0, opacity: isMobile ? 1 : 0 });
  useEffect(() => {
    if (isMobile) {
      setStyle({ position:"fixed", top:"50%", left:"50%", transform:"translate(-50%,-50%)", opacity:1, zIndex:10000 });
      return;
    }
    if (!anchorRef?.current || !ref.current) return;
    const a = anchorRef.current.getBoundingClientRect();
    const p = ref.current.getBoundingClientRect();
    const margin = 6;
    let top = a.bottom + margin;
    if (top + p.height > window.innerHeight - 8) top = Math.max(8, a.top - p.height - margin);
    let left = a.left;
    if (left + p.width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - p.width - 8);
    setStyle({ position:"fixed", top, left, opacity:1, zIndex: 9999 });
  }, [anchorRef, isMobile]);
  const card = (
    <div ref={ref} style={{
      ...style,
      background:"var(--surface, #fff)",border:"1px solid var(--border)",borderRadius:10,
      boxShadow:"0 12px 32px rgba(15,23,42,.18)",
      maxWidth: isMobile ? "calc(100vw - 24px)" : undefined,
    }}>{children}</div>
  );
  if (typeof document === "undefined") return null;
  if (isMobile) {
    return createPortal(
      <div className="pretty-date-backdrop" onClick={closeOnOutside ? onClose : undefined} style={{
        position:"fixed", inset:0, background:"rgba(15,23,42,.45)", zIndex:9999,
      }}>
        <div onClick={e=>e.stopPropagation()} style={{display:"contents"}}>{card}</div>
      </div>,
      document.body
    );
  }
  return createPortal(card, document.body);
}

// ─────────── TIME PICKER (Material-style HH/MM + AM/PM) ───────────
export function PrettyTimePicker({ value, onChange, onClose }) {
  // value is "HH:mm" (24h). Initialize 12h state.
  const initial = (() => {
    if (value && /^\d{2}:\d{2}$/.test(value)) {
      const [h, m] = value.split(":").map(Number);
      const { h12, period } = to12h(h);
      return { h: String(h12), m: pad(m), period };
    }
    return { h: "12", m: "00", period: "AM" };
  })();
  const [h, setH] = useState(initial.h);
  const [m, setM] = useState(initial.m);
  const [period, setPeriod] = useState(initial.period);
  const [focus, setFocus] = useState("h"); // h | m

  const commit = () => {
    let hi = Math.max(1, Math.min(12, parseInt(h || "12", 10) || 12));
    let mi = Math.max(0, Math.min(59, parseInt(m || "0", 10) || 0));
    const h24 = to24h(hi, period);
    onChange(`${pad(h24)}:${pad(mi)}`);
    onClose?.();
  };

  const node = (
    <div className="pretty-time-backdrop" onClick={onClose} style={{
      position:"fixed", inset:0, background:"rgba(15,23,42,.55)", zIndex:10010,
      display:"flex", alignItems:"center", justifyContent:"center", padding:16,
    }}>
      <div onClick={e=>e.stopPropagation()} className="pretty-time-card" style={{
        background:"#fff", borderRadius:14, boxShadow:"0 18px 48px rgba(15,23,42,.28)",
        padding:"22px 24px 16px", width:"min(420px, 100%)",
      }}>
        <div style={{
          fontFamily:"var(--font-head)", fontSize:".72rem", fontWeight:700, letterSpacing:2,
          textTransform:"uppercase", color:"#374151", marginBottom:14,
        }}>Enter time</div>

        <div className="pretty-time-row" style={{display:"flex", alignItems:"flex-start", gap:14, justifyContent:"center"}}>
          {/* HOUR */}
          <div style={{display:"flex", flexDirection:"column", alignItems:"center", gap:6}}>
            <input
              value={h}
              onFocus={()=>setFocus("h")}
              onChange={e=>{
                const v = e.target.value.replace(/\D/g,"").slice(0,2);
                setH(v);
              }}
              onBlur={()=>{ if (h) setH(String(Math.max(1, Math.min(12, parseInt(h,10) || 12)))); }}
              inputMode="numeric"
              maxLength={2}
              className="pretty-time-box"
              style={{
                width:96, height:84, textAlign:"center", fontFamily:"var(--font-mono)",
                fontSize:"3rem", fontWeight:400, color:"#1f2937",
                background: focus==="h" ? "#ede9fe" : "#f1f5f9",
                border: focus==="h" ? "2px solid #6d28d9" : "2px solid transparent",
                borderRadius:10, outline:"none", padding:0,
              }}
            />
            <div style={{fontSize:".72rem", color:"#6b7280", fontFamily:"var(--font-body)"}}>Hour</div>
          </div>

          <div style={{fontSize:"2.4rem", color:"#9ca3af", fontWeight:300, lineHeight:"84px"}}>:</div>

          {/* MINUTE */}
          <div style={{display:"flex", flexDirection:"column", alignItems:"center", gap:6}}>
            <input
              value={m}
              onFocus={()=>setFocus("m")}
              onChange={e=>{
                const v = e.target.value.replace(/\D/g,"").slice(0,2);
                setM(v);
              }}
              onBlur={()=>{ if (m) setM(pad(Math.max(0, Math.min(59, parseInt(m,10) || 0)))); }}
              inputMode="numeric"
              maxLength={2}
              className="pretty-time-box"
              style={{
                width:96, height:84, textAlign:"center", fontFamily:"var(--font-mono)",
                fontSize:"3rem", fontWeight:400, color:"#1f2937",
                background: focus==="m" ? "#ede9fe" : "#f1f5f9",
                border: focus==="m" ? "2px solid #6d28d9" : "2px solid transparent",
                borderRadius:10, outline:"none", padding:0,
              }}
            />
            <div style={{fontSize:".72rem", color:"#6b7280", fontFamily:"var(--font-body)"}}>Minute</div>
          </div>

          {/* AM/PM */}
          <div className="pretty-time-ampm" style={{
            display:"grid", gridTemplateRows:"1fr 1fr", height:84, width:64,
            border:"1px solid #c4b5fd", borderRadius:8, overflow:"hidden",
          }}>
            {["AM","PM"].map((p, i) => (
              <button key={p} type="button" onClick={()=>setPeriod(p)} style={{
                background: period===p ? "#ede9fe" : "#fff",
                color: period===p ? "#6d28d9" : "#374151",
                fontFamily:"var(--font-head)", fontWeight:700, fontSize:".95rem",
                border:"none", cursor:"pointer",
                borderTop: i===1 ? "1px solid #c4b5fd" : "none",
              }}>{p}</button>
            ))}
          </div>
        </div>

        <div style={{display:"flex", alignItems:"center", marginTop:22, gap:8}}>
          <span style={{fontSize:"1.2rem", color:"#374151"}} aria-hidden>🕒</span>
          <div style={{marginLeft:"auto", display:"flex", gap:14}}>
            <button type="button" onClick={onClose} style={{
              background:"transparent", border:"none", color:"#6d28d9",
              fontFamily:"var(--font-head)", fontWeight:700, fontSize:".88rem",
              letterSpacing:1, textTransform:"uppercase", cursor:"pointer", padding:"6px 10px",
            }}>Cancel</button>
            <button type="button" onClick={commit} style={{
              background:"transparent", border:"none", color:"#6d28d9",
              fontFamily:"var(--font-head)", fontWeight:800, fontSize:".88rem",
              letterSpacing:1, textTransform:"uppercase", cursor:"pointer", padding:"6px 10px",
            }}>OK</button>
          </div>
        </div>
      </div>
    </div>
  );
  if (typeof document === "undefined") return null;
  return createPortal(node, document.body);
}


export { PrettyTimePicker as PrettyTime };

// ─────────── DATE PICKER (date only) ───────────
export function PrettyDate({ value, onChange, min, max, placeholder = "Pick a date", style }) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef(null);
  const d = parseDateStr(value);
  return (
    <div style={{position:"relative",width:"100%"}}>
      <div ref={anchorRef}>
        <TriggerButton display={fmtDateOnly(d)} placeholder={placeholder} open={open} onClick={()=>setOpen(o=>!o)} style={style} />
      </div>
      {open && (
        <Panel anchorRef={anchorRef} onClose={()=>setOpen(false)}>
          <CalendarPanel selected={d} min={min} max={max} onPick={(picked)=>{ onChange(toDateStr(picked)); setOpen(false); }} />
          <div style={{display:"flex",justifyContent:"space-between",borderTop:"1px solid var(--border)",padding:"6px 10px"}}>
            <button type="button" onClick={()=>{ onChange(""); setOpen(false); }} style={navBtn}>Clear</button>
            <button type="button" onClick={()=>{ const t=new Date(); t.setHours(0,0,0,0); onChange(toDateStr(t)); setOpen(false); }} style={navBtn}>Today</button>
          </div>
        </Panel>
      )}
    </div>
  );
}

// ─────────── DATE + TIME PICKER (two-step: calendar then time modal) ───────────
export function PrettyDateTime({ value, onChange, min, placeholder = "Pick date & time", style }) {
  const [open, setOpen] = useState(false);
  const [timeOpen, setTimeOpen] = useState(false);
  const anchorRef = useRef(null);
  const d = parseDateTimeStr(value);

  // Working draft so date + time commit atomically
  const [draftDate, setDraftDate] = useState(() => d ? toDateStr(d) : "");
  const [draftTime, setDraftTime] = useState(() => d ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : "");

  useEffect(() => {
    if (open) {
      setDraftDate(d ? toDateStr(d) : "");
      setDraftTime(d ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : "");
    }
  }, [open]); // eslint-disable-line

  const draftSelected = draftDate ? parseDateStr(draftDate) : null;
  const draftTimeLabel = (() => {
    if (!draftTime) return "Set time";
    const [hh, mm] = draftTime.split(":").map(Number);
    const { h12, period } = to12h(hh);
    return `${pad(h12)}:${pad(mm)} ${period}`;
  })();

  const commit = () => {
    if (!draftDate || !draftTime) {
      // Require both to commit a datetime
      if (!draftTime) { setTimeOpen(true); return; }
      return;
    }
    const [hh, mm] = draftTime.split(":").map(Number);
    const dt = parseDateStr(draftDate);
    dt.setHours(hh, mm, 0, 0);
    onChange(toDateTimeStr(dt));
    setOpen(false);
  };

  return (
    <div style={{position:"relative",width:"100%"}}>
      <div ref={anchorRef}>
        <TriggerButton display={fmtDateTime(d)} placeholder={placeholder} open={open} onClick={()=>setOpen(o=>!o)} style={style} />
      </div>
      {open && (
        <Panel anchorRef={anchorRef} onClose={()=>{ if (!timeOpen) setOpen(false); }} closeOnOutside={!timeOpen}>
          <CalendarPanel
            selected={draftSelected}
            min={min}
            onPick={(picked)=>{
              setDraftDate(toDateStr(picked));
              if (!draftTime) setTimeOpen(true);
            }}
          />
          <div style={{
            borderTop:"1px solid var(--border)", padding:"10px 12px",
            display:"flex", alignItems:"center", gap:8, flexWrap:"wrap",
          }}>
            <button type="button" onClick={()=>setTimeOpen(true)} style={{
              display:"inline-flex", alignItems:"center", gap:6,
              background: draftTime ? "#ede9fe" : "#f1f5f9",
              border:`1px solid ${draftTime ? "#c4b5fd" : "var(--border)"}`,
              color: draftTime ? "#6d28d9" : "#374151",
              padding:"6px 12px", borderRadius:6, cursor:"pointer",
              fontFamily:"var(--font-head)", fontWeight:700, fontSize:".78rem", letterSpacing:.5,
            }}>
              <span>🕒</span><span>{draftTimeLabel}</span>
            </button>
            <div style={{marginLeft:"auto", display:"flex", gap:6}}>
              <button type="button" onClick={()=>{
                const t = new Date();
                setDraftDate(toDateStr(t));
                setDraftTime(`${pad(t.getHours())}:${pad(t.getMinutes())}`);
                onChange(toDateTimeStr(t));
                setOpen(false);
              }} style={navBtn}>Now</button>
              <button type="button" onClick={()=>{ onChange(""); setDraftDate(""); setDraftTime(""); setOpen(false); }} style={navBtn}>Clear</button>
              <button type="button" onClick={commit} disabled={!draftDate || !draftTime} style={{
                ...navBtn,
                background: (!draftDate || !draftTime) ? "#cbd5e1" : "var(--accent, #2563eb)",
                color:"#fff", borderColor:"transparent",
                cursor: (!draftDate || !draftTime) ? "not-allowed" : "pointer",
              }}>Done</button>
            </div>
          </div>
        </Panel>
      )}
      {timeOpen && (
        <PrettyTimePicker
          value={draftTime}
          onChange={(t)=>{
            setDraftTime(t);
            if (draftDate) {
              const [hh, mm] = t.split(":").map(Number);
              const dt = parseDateStr(draftDate);
              dt.setHours(hh, mm, 0, 0);
              onChange(toDateTimeStr(dt));
              setOpen(false);
            }
          }}
          onClose={()=>setTimeOpen(false)}
        />
      )}
    </div>
  );
}
