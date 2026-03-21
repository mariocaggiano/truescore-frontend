import { useState, useEffect, useRef, useCallback } from "react";

// ── Config ────────────────────────────────────────────────────────────────────
// In produzione: punta al tuo backend Railway/Render
// In sviluppo:   http://localhost:8000
const API_BASE = typeof window !== "undefined" && window.TRUESCORE_API
  ? window.TRUESCORE_API
  : "http://localhost:8000";

const USE_MOCK = !API_BASE.startsWith("http");   // fallback se API non config.

// ── Fonts ─────────────────────────────────────────────────────────────────────
const FONT_LINK = "https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,700;1,400&family=DM+Mono:wght@300;400;500&family=DM+Sans:wght@300;400;500;600&display=swap";

// ── Design tokens ─────────────────────────────────────────────────────────────
const T = {
  navy:        "#0D0F1A",
  navyMid:     "#13162A",
  navyLight:   "#1E2240",
  navyBorder:  "#2A2F52",
  accent:      "#4B6EFF",
  accentDim:   "#2A3D8A",
  white:       "#F0EFE9",
  whiteDim:    "#9896A0",
  red:         "#E53935",
  redLight:    "#3A1515",
  orange:      "#F57C00",
  orangeLight: "#2E2010",
  green:       "#43A047",
  greenLight:  "#0E2A10",
  grey:        "#555870",
  greyLight:   "#1A1C2E",
};

const VERDICT_CFG = {
  discrepancy:       { color: T.red,    bg: T.redLight,    label: "DISCREPANZA",  icon: "✕" },
  warning:           { color: T.orange, bg: T.orangeLight, label: "ATTENZIONE",   icon: "!" },
  verified:          { color: T.green,  bg: T.greenLight,  label: "VERIFICATA",   icon: "✓" },
  uncertain:         { color: T.grey,   bg: T.greyLight,   label: "INCERTA",      icon: "?" },
  insufficient_data: { color: T.grey,   bg: T.greyLight,   label: "DATI INSUFF.", icon: "–" },
};

const TYPE_LABELS = {
  revenue: "Ricavi", partner_count: "Partner / Strutture",
  funding: "Funding", team_size: "Team", other: "Altro",
};

const fmtVal = (v) => {
  if (v === null || v === undefined) return "—";
  const n = parseFloat(v);
  if (isNaN(n)) return String(v);
  if (n >= 1e6) return `€${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `€${n.toLocaleString("it")}`;
  return `${n}`;
};

// ── Mock pipeline (demo senza backend) ────────────────────────────────────────
function buildMockResult(companyName) {
  const verdicts = [
    { id:"C000", type:"revenue",       text:"Ricavi 2023 pari a €3.8 milioni",             declared:3800000, verified:610420,  verdict:"discrepancy",       confidence:0.93, magnitude:0.84, reasoning:"Discrepanza significativa. Dichiarato: €3.800.000. Bilancio 2023: €610.420. Scarto: 84% (6.2x il dato ufficiale).", sources:["bilancio_infocamere"], flags:["Scarto >500% rispetto al bilancio depositato"] },
    { id:"C001", type:"partner_count", text:"320 strutture partner attive in tutta Italia", declared:320,     verified:78,      verdict:"discrepancy",       confidence:0.70, magnitude:0.76, reasoning:"OSM rileva ~51 strutture (stima corretta: 78). Dichiarato: 320. Scarto: 76%.", sources:["openstreetmap_overpass","wayback_machine"], flags:[] },
    { id:"C002", type:"funding",       text:"€2.5M raccolti: €500K seed + €2M Series A",   declared:2500000, verified:null,    verdict:"uncertain",         confidence:0.55, magnitude:0,    reasoning:"€500K seed confermato da news italiane. Series A da €2M non tracciato in alcuna fonte pubblica.", sources:["crunchbase"], flags:["Series A non tracciato"] },
    { id:"C003", type:"team_size",     text:"Un team di 28 professionisti",                 declared:28,      verified:30,      verdict:"verified",          confidence:0.65, magnitude:0.07, reasoning:"LinkedIn headcount: fascia 11-50, midpoint 30. Scarto 7% — entro margine tolleranza.", sources:["linkedin"], flags:[] },
  ];
  const scoreMap = { verified:1.0, warning:0.6, uncertain:0.4, discrepancy:0.1, insufficient_data:0.3 };
  const weights  = { revenue:0.35, partner_count:0.30, funding:0.25, team_size:0.10 };
  let ws=0, wt=0;
  for (const v of verdicts) { const w=weights[v.type]||0.05; ws+=w*scoreMap[v.verdict]*v.confidence; wt+=w; }
  const trust = Math.round(Math.max(0.5, Math.min(9.5, (ws/wt)*10)) * 10) / 10;
  return {
    company_name: companyName,
    trust_score: trust,
    trust_score_label: trust<0?"Dati insufficienti per una valutazione":trust>=7.5?"Alta affidabilità":trust>=5.5?"Affidabilità moderata":trust>=3.5?"Bassa affidabilità":"Molto bassa affidabilità",
    verdicts,
    red_flags:    verdicts.filter(v=>v.verdict==="discrepancy").map(v=>v.id),
    warnings:     verdicts.filter(v=>v.verdict==="warning").map(v=>v.id),
    unverifiable: verdicts.filter(v=>["uncertain","insufficient_data"].includes(v.verdict)).map(v=>v.id),
    pdf_ready: false,
    report_id: "TS-DEMO-0001",
    generated_at: new Date().toLocaleDateString("it-IT", {day:"2-digit",month:"long",year:"numeric"}),
  };
}

// ── API calls ──────────────────────────────────────────────────────────────────
// ── Client-side pre-fetch via proxy ──────────────────────────────────────
// Il backend fa il fetch passando l'IP reale del browser come X-Forwarded-For.
// Molti siti italiani non bloccano IP residenziali — solo i datacenter.

async function proxyFetch(url) {
  try {
    const resp = await fetch(
      `${API_BASE}/api/proxy-fetch?url=${encodeURIComponent(url)}`,
      { method: "GET" }
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.status === 200 ? { html: data.html, finalUrl: data.final_url } : null;
  } catch {
    return null;
  }
}

async function prefetchExternalData(companyName, vatNumber) {
  companyName = companyName.trim();
  const results = { ufficiocamerale: null, opencorporates: null };
  const fetches = [];

  // Fetch paralleli per velocità
  if (vatNumber) {
    fetches.push(
      proxyFetch(`https://www.ufficiocamerale.it/trova-azienda?piva=${encodeURIComponent(vatNumber)}`)
        .then(async r => {
          if (!r) return;
          // Se la pagina è una search results, segui il primo link azienda
          const parser = new DOMParser();
          const doc    = parser.parseFromString(r.html, "text/html");
          // Cerca link a pagine aziendali (URL con /NNN/slug-nome)
          const links  = Array.from(doc.querySelectorAll("a[href]"))
            .map(a => a.getAttribute("href"))
            .filter(h => h && /\/\d+\/[a-z]/.test(h) && !h.includes("trova-azienda") && !h.includes("news"));
          if (links.length > 0) {
            const companyPath = links[0].startsWith("http")
              ? links[0]
              : "https://www.ufficiocamerale.it" + links[0];
            const r2 = await proxyFetch(companyPath);
            if (r2) { results.ufficiocamerale = r2; return; }
          }
          // Fallback: usa la search page direttamente
          results.ufficiocamerale = r;
        })
        .catch(() => {})
    );
  }

  // Aggiungi "srl" solo se non già presente nel nome
  const ocName  = /s\.?r\.?l\.?|s\.?p\.?a\.?/i.test(companyName) ? companyName : companyName + " srl";
  const ocQuery = encodeURIComponent(ocName);
  fetches.push(
    proxyFetch(`https://opencorporates.com/companies?q=${ocQuery}&jurisdiction_code=it&type=company`)
      .then(r => { if (r) results.opencorporates = r; })
      .catch(() => {})
  );

  await Promise.all(fetches);
  return results;
}

async function apiAnalyze({ companyName, pitchText, bilancioText, websiteUrl, sector, pitchFile, bilancioFile, linkedinUrl, vatNumber, prefetchedData }) {
  const form = new FormData();
  form.append("company_name", companyName.trim());
  if (pitchText)    form.append("pitch_text", pitchText);
  if (bilancioText) form.append("bilancio_text", bilancioText);
  if (websiteUrl)   form.append("website_url", websiteUrl);
  if (sector)       form.append("sector", sector);
  if (linkedinUrl)  form.append("linkedin_url", linkedinUrl);
  if (vatNumber)    form.append("vat_number", vatNumber);
  if (pitchFile)    form.append("pitch_file", pitchFile);
  if (bilancioFile) form.append("bilancio_file", bilancioFile);

  // Dati pre-fetchati dal browser (HTML di siti terzi)
  if (prefetchedData?.ufficiocamerale?.html)
    form.append("ufficiocamerale_html", prefetchedData.ufficiocamerale.html);
  if (prefetchedData?.ufficiocamerale?.finalUrl)
    form.append("ufficiocamerale_url", prefetchedData.ufficiocamerale.finalUrl);
  if (prefetchedData?.opencorporates?.html)
    form.append("opencorporates_html", prefetchedData.opencorporates.html);

  const res = await fetch(`${API_BASE}/api/analyze`, { method:"POST", body:form });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

async function apiResult(jobId) {
  const res = await fetch(`${API_BASE}/api/result/${jobId}`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

// ── Visual components ──────────────────────────────────────────────────────────

const css = `
  @import url('${FONT_LINK}');
  * { box-sizing: border-box; }
  @keyframes spin    { to { transform: rotate(360deg); } }
  @keyframes fadeUp  { from { opacity:0; transform:translateY(14px); } to { opacity:1; transform:translateY(0); } }
  @keyframes scanline{ 0% { top:-2px; } 100% { top:100%; } }
  @keyframes pulse   { 0%,100%{ opacity:1; } 50%{ opacity:0.35; } }
  @keyframes ticker  { from { opacity:0.4; } to { opacity:1; } }
  ::-webkit-scrollbar { width:4px; }
  ::-webkit-scrollbar-track { background:${T.navy}; }
  ::-webkit-scrollbar-thumb { background:${T.navyBorder}; border-radius:2px; }
  input::placeholder, textarea::placeholder { color:${T.grey}; }
  a { color:${T.accent}; }
`;

function Grain() {
  return <div style={{
    position:"fixed", inset:0, pointerEvents:"none", zIndex:0, opacity:0.025,
    backgroundImage:`url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`,
  }}/>;
}

function ScanLine() {
  return <div style={{position:"absolute",inset:0,pointerEvents:"none",overflow:"hidden",borderRadius:"inherit",zIndex:1}}>
    <div style={{position:"absolute",left:0,right:0,height:"2px",background:"linear-gradient(90deg,transparent,rgba(75,110,255,0.45),transparent)",animation:"scanline 2.8s linear infinite"}}/>
  </div>;
}

function Spinner() {
  return <span style={{display:"inline-block",width:12,height:12,borderRadius:"50%",border:`2px solid ${T.accent}`,borderTopColor:"transparent",animation:"spin 0.8s linear infinite"}}/>;
}

function UploadZone({ label, hint, icon, file, onFile, accept }) {
  const [drag, setDrag] = useState(false);
  const ref = useRef();
  return (
    <div
      onClick={() => ref.current?.click()}
      onDragOver={e => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={e => { e.preventDefault(); setDrag(false); const f=e.dataTransfer.files[0]; if(f) onFile(f); }}
      style={{
        border:`1px solid ${drag ? T.accent : file ? T.accentDim : T.navyBorder}`,
        borderRadius:6, padding:"18px 16px", cursor:"pointer",
        background: drag ? `${T.accent}12` : file ? `${T.accent}08` : T.navyMid,
        transition:"all 0.2s", position:"relative", overflow:"hidden",
      }}
    >
      {drag && <ScanLine/>}
      <input ref={ref} type="file" accept={accept} style={{display:"none"}} onChange={e=>e.target.files[0]&&onFile(e.target.files[0])}/>
      <div style={{display:"flex",alignItems:"center",gap:12}}>
        <div style={{width:36,height:36,borderRadius:6,background:file?T.accentDim:T.navyLight,display:"flex",alignItems:"center",justifyContent:"center",fontSize:17,flexShrink:0,border:`1px solid ${file?T.accent:T.navyBorder}`}}>{icon}</div>
        <div style={{flex:1}}>
          <div style={{fontFamily:"'DM Sans',sans-serif",fontSize:12.5,fontWeight:600,color:file?T.white:T.whiteDim}}>{label}</div>
          <div style={{fontFamily:"'DM Mono',monospace",fontSize:9.5,color:file?T.accent:T.grey,marginTop:2,letterSpacing:"0.05em"}}>{file ? `✓  ${file.name}` : hint}</div>
        </div>
        {!file && <div style={{fontFamily:"'DM Mono',monospace",fontSize:8,color:T.grey,border:`1px solid ${T.navyBorder}`,borderRadius:4,padding:"2px 8px",letterSpacing:"0.08em",flexShrink:0}}>CARICA</div>}
      </div>
    </div>
  );
}

function PipelineStep({ n, label, status, detail }) {
  const c = {idle:T.grey,running:T.accent,done:T.green,error:T.red}[status]||T.grey;
  return (
    <div style={{display:"flex",alignItems:"flex-start",gap:14,padding:"12px 0",borderBottom:`1px solid ${T.navyBorder}`}}>
      <div style={{width:32,height:32,borderRadius:"50%",flexShrink:0,border:`2px solid ${c}`,display:"flex",alignItems:"center",justifyContent:"center",background:status==="done"?`${T.green}20`:status==="running"?`${T.accent}15`:"transparent",transition:"all 0.4s"}}>
        {status==="done"  ? <span style={{color:T.green,fontSize:14}}>✓</span>
        :status==="running"? <Spinner/>
        :<span style={{fontFamily:"'DM Mono',monospace",fontSize:11,color:c,fontWeight:500}}>{n}</span>}
      </div>
      <div style={{paddingTop:4}}>
        <div style={{fontFamily:"'DM Sans',sans-serif",fontSize:13,fontWeight:600,color:status==="idle"?T.grey:T.white,transition:"color 0.3s"}}>{label}</div>
        {detail && <div style={{fontFamily:"'DM Mono',monospace",fontSize:10,color:T.accent,marginTop:3,letterSpacing:"0.04em"}}>{detail}</div>}
      </div>
    </div>
  );
}

function ClaimCard({ v }) {
  const [open, setOpen] = useState(v.verdict === "discrepancy");
  const cfg = VERDICT_CFG[v.verdict] || VERDICT_CFG.insufficient_data;
  return (
    <div style={{border:`1px solid ${T.navyBorder}`,borderLeft:`3px solid ${cfg.color}`,borderRadius:6,marginBottom:10,overflow:"hidden"}}>
      <div onClick={()=>setOpen(o=>!o)} style={{padding:"12px 16px",cursor:"pointer",background:open?`${cfg.bg}50`:T.navyMid,display:"flex",alignItems:"center",gap:12,transition:"background 0.2s"}}>
        <div style={{width:26,height:26,borderRadius:"50%",flexShrink:0,background:cfg.color,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"'DM Mono',monospace",fontSize:11,color:"white",fontWeight:700}}>{cfg.icon}</div>
        <div style={{flex:1,minWidth:0}}>
          <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
            <span style={{fontFamily:"'DM Sans',sans-serif",fontSize:12,fontWeight:600,color:T.white}}>{TYPE_LABELS[v.type]||v.type}</span>
            <span style={{fontFamily:"'DM Mono',monospace",fontSize:9,letterSpacing:"0.08em",color:cfg.color,border:`1px solid ${cfg.color}40`,padding:"1px 7px",borderRadius:20}}>{cfg.label}</span>
          </div>
          <div style={{fontFamily:"'DM Sans',sans-serif",fontSize:11,color:T.whiteDim,marginTop:2,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{v.text}</div>
        </div>
        <div style={{display:"flex",gap:3,flexShrink:0}}>
          {[1,2,3,4,5].map(i=><div key={i} style={{width:6,height:6,borderRadius:"50%",background:i<=Math.round(v.confidence*5)?T.white:T.navyBorder}}/>)}
        </div>
        <span style={{color:T.grey,fontSize:11,flexShrink:0,transform:open?"rotate(180deg)":"none",transition:"transform 0.2s"}}>▾</span>
      </div>
      {open && (
        <div style={{padding:"14px 16px",background:T.navy,borderTop:`1px solid ${T.navyBorder}`}}>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10,marginBottom:12}}>
            {[["DICHIARATO",fmtVal(v.declared),T.whiteDim],["VERIFICATO",fmtVal(v.verified),cfg.color],["SCARTO",v.magnitude>0?`${(v.magnitude*100).toFixed(0)}%`:"—",cfg.color]].map(([l,val,c])=>(
              <div key={l} style={{background:T.navyMid,border:`1px solid ${T.navyBorder}`,borderRadius:5,padding:"10px 12px"}}>
                <div style={{fontFamily:"'DM Mono',monospace",fontSize:8,color:T.grey,letterSpacing:"0.1em",marginBottom:4}}>{l}</div>
                <div style={{fontFamily:"'DM Mono',monospace",fontSize:13,color:c,fontWeight:500}}>{val}</div>
              </div>
            ))}
          </div>
          <div style={{fontFamily:"'DM Sans',sans-serif",fontSize:11.5,color:T.whiteDim,lineHeight:1.7,background:T.navyMid,borderRadius:5,padding:"10px 12px",border:`1px solid ${T.navyBorder}`}}>{v.reasoning}</div>
          {v.sources?.length>0 && (
            <div style={{marginTop:10}}>
              <div style={{fontFamily:"'DM Mono',monospace",fontSize:8,color:T.grey,letterSpacing:"0.1em",marginBottom:5}}>FONTI CON DATI</div>
              <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                {v.sources.map(s=><span key={s} style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:T.green,background:`${T.green}15`,padding:"2px 8px",borderRadius:20,letterSpacing:"0.04em"}}>✓ {s}</span>)}
              </div>
            </div>
          )}
          {(!v.sources || v.sources.length===0) && v.sources_consulted?.length>0 && (
            <div style={{marginTop:10}}>
              <div style={{fontFamily:"'DM Mono',monospace",fontSize:8,color:T.grey,letterSpacing:"0.1em",marginBottom:5}}>FONTI CONSULTATE — NESSUN RISULTATO</div>
              <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                {v.sources_consulted.map(s=><span key={s} style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:T.grey,background:T.greyLight,padding:"2px 8px",borderRadius:20,letterSpacing:"0.04em",textDecoration:"line-through",opacity:0.7}}>✕ {s}</span>)}
              </div>
            </div>
          )}
          {v.sources?.length>0 && v.sources_consulted?.filter(s=>!v.sources.includes(s)).length>0 && (
            <div style={{marginTop:6}}>
              <div style={{fontFamily:"'DM Mono',monospace",fontSize:8,color:T.grey,letterSpacing:"0.1em",marginBottom:5}}>FONTI SENZA RISULTATI</div>
              <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                {v.sources_consulted.filter(s=>!v.sources.includes(s)).map(s=><span key={s} style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:T.grey,background:T.greyLight,padding:"2px 8px",borderRadius:20,letterSpacing:"0.04em",opacity:0.6}}>✕ {s}</span>)}
              </div>
            </div>
          )}
          {v.flags?.length>0 && (
            <div style={{marginTop:8}}>
              {v.flags.map((f,i)=><div key={i} style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:cfg.color,marginTop:4,paddingLeft:4,opacity:0.8}}> ▸ {f}</div>)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TrustMeter({ score }) {
  const [width, setWidth] = useState(0);
  useEffect(()=>{ setTimeout(()=>setWidth(score<0?0:(score/10)*100), 100); },[score]);
  const color = score<0?T.grey:score<4?T.red:score<6.5?T.orange:T.green;
  return (
    <div>
      <div style={{height:8,background:T.navyBorder,borderRadius:4,overflow:"hidden",marginBottom:6}}>
        <div style={{width:`${width}%`,height:"100%",background:color,borderRadius:4,transition:"width 1.2s cubic-bezier(0.22,1,0.36,1)"}}/>
      </div>
      <div style={{display:"flex",justifyContent:"space-between",fontFamily:"'DM Mono',monospace",fontSize:8,color:T.grey}}>
        <span>0</span><span>5</span><span>10</span>
      </div>
    </div>
  );
}

// ── Screens ────────────────────────────────────────────────────────────────────

function UploadScreen({ onSubmit }) {
  const [companyName, setCompanyName] = useState("");
  const [pitchFile,    setPitchFile]   = useState(null);
  const [bilancioFile, setBilancioFile]= useState(null);
  const [pitchText,    setPitchText]   = useState("");
  const [bilancioText, setBilancioText]= useState("");
  const [websiteUrl,   setWebsiteUrl]  = useState("");
  const [sector,       setSector]      = useState("");
  const [linkedinUrl,  setLinkedinUrl] = useState("");
  const [vatNumber,    setVatNumber]   = useState("");

  const canSubmit = companyName.trim().length > 0;

  const input = (val, set, placeholder, mono=false) => (
    <input value={val} onChange={e=>set(e.target.value)} placeholder={placeholder}
      style={{width:"100%",background:T.navyMid,border:`1px solid ${T.navyBorder}`,borderRadius:6,padding:"11px 14px",color:T.white,fontFamily:mono?"'DM Mono',monospace":"'DM Sans',sans-serif",fontSize:mono?12:13,outline:"none"}}
      onFocus={e=>e.target.style.borderColor=T.accent}
      onBlur={e=>e.target.style.borderColor=T.navyBorder}/>
  );

  const textarea = (val, set, placeholder, rows=3) => (
    <textarea value={val} onChange={e=>set(e.target.value)} placeholder={placeholder} rows={rows}
      style={{width:"100%",background:T.navyMid,border:`1px solid ${T.navyBorder}`,borderRadius:6,padding:"10px 14px",color:T.white,resize:"vertical",fontFamily:"'DM Sans',sans-serif",fontSize:12,outline:"none",lineHeight:1.6}}
      onFocus={e=>e.target.style.borderColor=T.accent}
      onBlur={e=>e.target.style.borderColor=T.navyBorder}/>
  );

  const label = (txt, opt=false) => (
    <label style={{display:"block",fontFamily:"'DM Mono',monospace",fontSize:9,color:T.grey,letterSpacing:"0.1em",textTransform:"uppercase",marginBottom:7}}>
      {txt} {opt && <span style={{color:T.accentDim}}>(opzionale)</span>}
    </label>
  );

  return (
    <div style={{minHeight:"100vh",background:T.navy,color:T.white,fontFamily:"'DM Sans',sans-serif",position:"relative"}}>
      <Grain/>
      <style>{css}</style>
      <div style={{maxWidth:580,margin:"0 auto",padding:"40px 24px",animation:"fadeUp 0.6s ease both"}}>

        {/* Wordmark */}
        <div style={{marginBottom:44}}>
          <div style={{display:"inline-flex",alignItems:"center",gap:1,marginBottom:6}}>
            <span style={{fontFamily:"'Playfair Display',serif",fontSize:22,fontWeight:700,color:T.accent,letterSpacing:"-0.02em"}}>True</span>
            <span style={{fontFamily:"'Playfair Display',serif",fontSize:22,fontWeight:700,color:T.white,letterSpacing:"-0.02em"}}>Score</span>
          </div>
          <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:T.grey,letterSpacing:"0.14em",textTransform:"uppercase"}}>Business Verification Intelligence</div>
        </div>

        {/* Headline */}
        <h1 style={{fontFamily:"'Playfair Display',serif",fontSize:33,fontWeight:700,lineHeight:1.2,color:T.white,margin:"0 0 10px",letterSpacing:"-0.02em"}}>
          Verifica le claim<br/><em style={{color:T.accent,fontStyle:"italic"}}>prima</em> di firmare.
        </h1>
        <p style={{fontSize:13.5,color:T.whiteDim,lineHeight:1.75,margin:"0 0 34px"}}>
          Carica il pitch deck e il bilancio. TrueScore incrocia le dichiarazioni
          con fonti pubbliche e genera un report con Trust Score.
        </p>

        <div style={{display:"flex",flexDirection:"column",gap:14}}>

          {/* Nome azienda */}
          <div>
            {label("Nome azienda *")}
            {input(companyName, setCompanyName, "es. MoveNow S.r.l.")}
          </div>

          {/* Pitch deck */}
          <div>
            {label("Pitch deck / materiale commerciale")}
            <UploadZone label="Pitch deck o one-pager" hint="PDF, TXT · trascina o clicca" icon="📄" accept=".pdf,.txt,.md" file={pitchFile} onFile={setPitchFile}/>
            {!pitchFile && <div style={{marginTop:6}}>{textarea(pitchText,setPitchText,"...oppure incolla direttamente il testo del pitch deck qui")}</div>}
          </div>

          {/* Bilancio */}
          <div>
            {label("Bilancio Infocamere", true)}
            <UploadZone label="Bilancio depositato" hint="PDF scaricato da Infocamere · trascina o clicca" icon="📊" accept=".pdf,.txt" file={bilancioFile} onFile={setBilancioFile}/>
            {!bilancioFile && <div style={{marginTop:6}}>{textarea(bilancioText,setBilancioText,"...oppure incolla il testo del bilancio",2)}</div>}
          </div>

          {/* Website + Settore */}
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
            <div>
              {label("Sito web", true)}
              {input(websiteUrl,setWebsiteUrl,"https://azienda.it",true)}
            </div>
            <div>
              {label("Settore", true)}
              {input(sector,setSector,"es. Mobilità, SaaS...",false)}
            </div>
          </div>

          {/* Avviso backend */}
          {USE_MOCK && (
            <div style={{background:T.navyMid,border:`1px solid ${T.navyBorder}`,borderRadius:6,padding:"10px 14px",display:"flex",gap:10,alignItems:"flex-start"}}>
              <span style={{color:T.orange,fontSize:14,flexShrink:0,marginTop:1}}>⚠</span>
              <div style={{fontFamily:"'DM Mono',monospace",fontSize:9.5,color:T.grey,lineHeight:1.6}}>
                <b style={{color:T.orange}}>Demo mode</b> — backend non configurato.<br/>
                Imposta <code style={{color:T.accent}}>window.TRUESCORE_API</code> per usare il backend reale.
              </div>
            </div>
          )}

          {/* LinkedIn + Partita IVA */}
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
            <div>
              {label("Profilo LinkedIn", true)}
              {input(linkedinUrl,setLinkedinUrl,"https://linkedin.com/company/...",true)}
            </div>
            <div>
              {label("Partita IVA", true)}
              {input(vatNumber,setVatNumber,"es. 12345678901",true)}
            </div>
          </div>

          {/* CTA */}
          <button onClick={()=>onSubmit({companyName,pitchText,bilancioText,websiteUrl,sector,pitchFile,bilancioFile,linkedinUrl,vatNumber})}
            disabled={!canSubmit}
            style={{marginTop:4,padding:"14px 24px",background:canSubmit?T.accent:T.navyBorder,border:"none",borderRadius:6,cursor:canSubmit?"pointer":"not-allowed",color:"white",fontFamily:"'DM Sans',sans-serif",fontSize:14,fontWeight:600,letterSpacing:"0.02em",transition:"all 0.2s",boxShadow:canSubmit?`0 0 24px ${T.accent}40`:"none"}}>
            Avvia Analisi →
          </button>
        </div>

        {/* Chips */}
        <div style={{marginTop:26,display:"flex",gap:8,flexWrap:"wrap"}}>
          {["Costo zero","Fonti pubbliche","AI-powered","PDF scaricabile"].map(t=>(
            <span key={t} style={{fontFamily:"'DM Mono',monospace",fontSize:8.5,color:T.grey,border:`1px solid ${T.navyBorder}`,borderRadius:20,padding:"3px 10px",letterSpacing:"0.06em"}}>{t}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

function AnalyzingScreen({ companyName, steps }) {
  return (
    <div style={{minHeight:"100vh",background:T.navy,color:T.white,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"'DM Sans',sans-serif"}}>
      <Grain/>
      <style>{css}</style>
      <div style={{width:460,padding:"0 24px",animation:"fadeUp 0.4s ease both"}}>
        <div style={{marginBottom:28}}>
          <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:T.accent,letterSpacing:"0.14em",textTransform:"uppercase",marginBottom:10}}>Analisi in corso</div>
          <h2 style={{fontFamily:"'Playfair Display',serif",fontSize:26,fontWeight:700,color:T.white,margin:0}}>{companyName}</h2>
        </div>
        <div style={{background:T.navyMid,border:`1px solid ${T.navyBorder}`,borderRadius:8,padding:"8px 20px",position:"relative",overflow:"hidden"}}>
          {steps.some(s=>s.status==="running") && <ScanLine/>}
          {steps.map((s,i)=><PipelineStep key={i} {...s}/>)}
        </div>
        <div style={{marginTop:18,fontFamily:"'DM Mono',monospace",fontSize:9.5,color:T.grey,textAlign:"center",letterSpacing:"0.04em",animation:"pulse 2s ease infinite"}}>
          {steps.find(s=>s.status==="running")?.detail || "Inizializzazione..."}
        </div>
      </div>
    </div>
  );
}

function ReportScreen({ result, jobId, onReset }) {
  const [tab, setTab] = useState("claims");
  const score    = result.trust_score;
  const scoreC   = score<0?T.grey:score<4?T.red:score<6.5?T.orange:T.green;
  const verdicts = result.verdicts || [];
  const redFlags = verdicts.filter(v=>result.red_flags?.includes(v.id));
  const hasApi   = jobId && !USE_MOCK;

  return (
    <div style={{minHeight:"100vh",background:T.navy,color:T.white,fontFamily:"'DM Sans',sans-serif"}}>
      <Grain/>
      <style>{css}</style>

      {/* Sticky topbar */}
      <div style={{background:T.navyMid,borderBottom:`1px solid ${T.navyBorder}`,padding:"12px 24px",display:"flex",alignItems:"center",justifyContent:"space-between",position:"sticky",top:0,zIndex:100}}>
        <div style={{display:"flex",alignItems:"center",gap:14}}>
          <span style={{fontFamily:"'Playfair Display',serif",fontSize:16,fontWeight:700}}>
            <span style={{color:T.accent}}>True</span><span style={{color:T.white}}>Score</span>
          </span>
          <span style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:T.grey,borderLeft:`1px solid ${T.navyBorder}`,paddingLeft:14,letterSpacing:"0.06em"}}>{result.company_name}</span>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:12}}>
          <div style={{textAlign:"right"}}>
            <span style={{fontFamily:"'DM Mono',monospace",fontSize:8,color:T.grey,letterSpacing:"0.06em"}}>TRUST SCORE  </span>
            <span style={{fontFamily:"'Playfair Display',serif",fontSize:20,fontWeight:700,color:scoreC}}>{score<0?"N/D":score.toFixed(1)}</span>
            <span style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:T.grey}}>/10</span>
          </div>
          {hasApi && (
            <a href={`${API_BASE}/api/report/${jobId}`} target="_blank" rel="noopener noreferrer"
              style={{padding:"6px 14px",background:T.accent,borderRadius:5,color:"white",textDecoration:"none",fontFamily:"'DM Mono',monospace",fontSize:9,letterSpacing:"0.06em"}}>
              ↓ PDF
            </a>
          )}
          <button onClick={onReset} style={{padding:"6px 14px",background:"transparent",border:`1px solid ${T.navyBorder}`,borderRadius:5,color:T.whiteDim,cursor:"pointer",fontFamily:"'DM Mono',monospace",fontSize:9,letterSpacing:"0.06em"}}>
            NUOVA ANALISI
          </button>
        </div>
      </div>

      <div style={{maxWidth:800,margin:"0 auto",padding:"28px 24px"}}>

        {/* Hero card */}
        <div style={{background:T.navyMid,border:`1px solid ${T.navyBorder}`,borderRadius:10,padding:"24px 26px 20px",marginBottom:18,animation:"fadeUp 0.5s ease both"}}>
          <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:16}}>
            <div>
              <h2 style={{fontFamily:"'Playfair Display',serif",fontSize:26,fontWeight:700,color:T.white,margin:"0 0 4px",letterSpacing:"-0.01em"}}>{result.company_name}</h2>
              <div style={{fontFamily:"'DM Mono',monospace",fontSize:9.5,color:T.grey,letterSpacing:"0.06em"}}>
                {verdicts.length} CLAIM  ·  {redFlags.length} DISCREPANZE  ·  {result.report_id}  ·  {result.generated_at}
              </div>
            </div>
            <div style={{textAlign:"right",flexShrink:0,marginLeft:20}}>
              <div style={{fontFamily:"'Playfair Display',serif",fontSize:52,fontWeight:700,color:scoreC,lineHeight:1}}>{score<0?"N/D":score.toFixed(1)}</div>
              <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:T.grey,marginTop:2}}>{result.trust_score_label}</div>
            </div>
          </div>
          <TrustMeter score={score}/>
        </div>

        {/* Stat strip */}
        <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8,marginBottom:20,animation:"fadeUp 0.5s 0.08s ease both",animationFillMode:"both"}}>
          {[
            ["Claim",        verdicts.length,                         T.white],
            ["Discrepanze",  result.red_flags?.length||0,             T.red],
            ["Attenzioni",   result.warnings?.length||0,              T.orange],
            ["Non verif.",   result.unverifiable?.length||0,          T.grey],
          ].map(([l,v,c])=>(
            <div key={l} style={{background:T.navyMid,border:`1px solid ${T.navyBorder}`,borderRadius:7,padding:"14px 14px 10px"}}>
              <div style={{fontFamily:"'Playfair Display',serif",fontSize:28,fontWeight:700,color:c,lineHeight:1}}>{v}</div>
              <div style={{fontFamily:"'DM Mono',monospace",fontSize:8,color:T.grey,marginTop:5,letterSpacing:"0.08em",textTransform:"uppercase"}}>{l}</div>
            </div>
          ))}
        </div>

        {/* Tabs */}
        <div style={{display:"flex",gap:2,borderBottom:`1px solid ${T.navyBorder}`,marginBottom:18}}>
          {[["claims",`Claim (${verdicts.length})`],["redflags",`Red Flags (${redFlags.length})`],["people","Persone Chiave"],["legal","Stato Legale"],["sources","Fonti & Disclaimer"]].map(([id,lbl])=>(
            <button key={id} onClick={()=>setTab(id)} style={{padding:"10px 18px",border:"none",background:"transparent",cursor:"pointer",fontSize:12,fontWeight:600,color:tab===id?T.white:T.grey,fontFamily:"'DM Sans',sans-serif",borderBottom:tab===id?`2px solid ${T.accent}`:"2px solid transparent",marginBottom:-1,transition:"all 0.15s"}}>{lbl}</button>
          ))}
        </div>

        {/* Tab: Claims */}
        {tab === "claims" && (
          <div style={{animation:"fadeUp 0.35s ease both"}}>
            {verdicts.map(v=><ClaimCard key={v.id} v={v}/>)}
          </div>
        )}

        {/* Tab: Red Flags */}
        {tab === "redflags" && (
          <div style={{animation:"fadeUp 0.35s ease both"}}>
            {redFlags.length === 0
              ? <div style={{textAlign:"center",padding:"60px 0",fontFamily:"'DM Mono',monospace",fontSize:11,color:T.grey,letterSpacing:"0.08em"}}>NESSUNA DISCREPANZA RILEVATA</div>
              : redFlags.map(v=>(
                <div key={v.id} style={{background:T.navyMid,border:`1px solid ${T.redLight}`,borderLeft:`3px solid ${T.red}`,borderRadius:7,padding:"18px",marginBottom:12}}>
                  <div style={{fontFamily:"'DM Sans',sans-serif",fontSize:13,fontWeight:700,color:T.red,marginBottom:5}}>{TYPE_LABELS[v.type]||v.type}</div>
                  <div style={{fontFamily:"'DM Sans',sans-serif",fontSize:12,color:T.whiteDim,marginBottom:12,lineHeight:1.6}}>{v.text}</div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10,marginBottom:12}}>
                    {[["Dichiarato",fmtVal(v.declared)],["Verificato",fmtVal(v.verified)],["Scarto",`${(v.magnitude*100).toFixed(0)}%`]].map(([l,val])=>(
                      <div key={l} style={{background:T.navy,border:`1px solid ${T.navyBorder}`,borderRadius:5,padding:"10px 12px",textAlign:"center"}}>
                        <div style={{fontFamily:"'DM Mono',monospace",fontSize:8,color:T.grey,letterSpacing:"0.1em",marginBottom:4}}>{l}</div>
                        <div style={{fontFamily:"'DM Mono',monospace",fontSize:14,color:l==="Dichiarato"?T.whiteDim:T.red,fontWeight:500}}>{val}</div>
                      </div>
                    ))}
                  </div>
                  <div style={{fontFamily:"'DM Sans',sans-serif",fontSize:11.5,color:T.whiteDim,lineHeight:1.7}}>{v.reasoning}</div>
                </div>
              ))
            }
          </div>
        )}

        {/* Tab: Persone Chiave */}
        {tab === "people" && (
          <div style={{animation:"fadeUp 0.35s ease both"}}>
            {!result.key_people || !result.key_people.found ? (
              <div style={{background:T.navyMid,border:`1px solid ${T.navyBorder}`,borderRadius:8,padding:32,textAlign:"center"}}>
                <div style={{fontFamily:"'DM Mono',monospace",fontSize:11,color:T.grey,letterSpacing:"0.08em",marginBottom:10}}>NESSUNA PERSONA CHIAVE TROVATA</div>
                <div style={{fontFamily:"'DM Sans',sans-serif",fontSize:12,color:T.grey,lineHeight:1.7}}>Non sono stati trovati profili pubblici. Prova su <a href={`https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(result.company_name)}`} target="_blank" rel="noopener noreferrer" style={{color:T.accent}}>LinkedIn</a>.</div>
              </div>
            ) : (
              <div>
                {result.key_people.summary && (
                  <div style={{background:T.navyMid,border:`1px solid ${T.navyBorder}`,borderLeft:`3px solid ${T.accent}`,borderRadius:8,padding:"16px 20px",marginBottom:16}}>
                    <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:T.grey,letterSpacing:"0.1em",marginBottom:8}}>RELAZIONE SINTETICA</div>
                    <div style={{fontFamily:"'DM Sans',sans-serif",fontSize:12.5,color:T.whiteDim,lineHeight:1.8}}>{result.key_people.summary}</div>
                  </div>
                )}
                <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))",gap:10}}>
                  {(result.key_people.people||[]).map((p,i) => {
                    const isTop = ["ceo","founder","fondatore","presidente","managing","cfo","coo","cto","cmo"].some(r=>p.role?.toLowerCase().includes(r));
                    return (
                      <div key={i} style={{background:T.navyMid,border:`1px solid ${isTop?T.accentDim:T.navyBorder}`,borderRadius:8,padding:"14px 16px"}}>
                        <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:8}}>
                          <div>
                            <div style={{fontFamily:"'DM Sans',sans-serif",fontSize:13,fontWeight:600,color:T.white}}>{p.name}</div>
                            <div style={{fontFamily:"'DM Mono',monospace",fontSize:10,color:isTop?T.accent:T.grey,marginTop:3}}>{p.role}</div>
                          </div>
                          {isTop && <span style={{width:8,height:8,borderRadius:"50%",background:T.accent,flexShrink:0,marginTop:4}}/>}
                        </div>
                        <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                          {p.linkedin && <a href={p.linkedin} target="_blank" rel="noopener noreferrer" style={{fontFamily:"'DM Mono',monospace",fontSize:8.5,color:T.accent,background:`${T.accent}15`,padding:"2px 10px",borderRadius:20,textDecoration:"none",border:`1px solid ${T.accentDim}`}}>LinkedIn →</a>}
                          <span style={{fontFamily:"'DM Mono',monospace",fontSize:8,color:T.grey,padding:"2px 8px",borderRadius:20,border:`1px solid ${T.navyBorder}`}}>{p.source==="linkedin"?"LinkedIn":p.source==="website_team_page"?"Sito web":"Google"}</span>
                          <span style={{fontFamily:"'DM Mono',monospace",fontSize:8,color:T.grey,opacity:0.6}}>{Math.round((p.confidence||0)*100)}% conf.</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
                {result.key_people.sources?.length > 0 && <div style={{marginTop:12,fontFamily:"'DM Mono',monospace",fontSize:9,color:T.grey}}>Fonti: {result.key_people.sources.join(" · ")}</div>}
              </div>
            )}
          </div>
        )}

        {/* Tab: Stato Legale */}
        {tab === "legal" && (
          <div style={{animation:"fadeUp 0.35s ease both"}}>
            {!result.legal_status || !result.legal_status.found ? (
              <div style={{background:T.navyMid,border:`1px solid ${T.navyBorder}`,borderRadius:8,padding:32,textAlign:"center"}}>
                <div style={{fontFamily:"'DM Mono',monospace",fontSize:11,color:T.grey,letterSpacing:"0.08em"}}>AZIENDA NON TROVATA SU OPENCORPORATES</div>
              </div>
            ) : (() => {
              const ls = result.legal_status;
              const statusColor = ls.status_normalized==="attiva"?T.green:ls.status_normalized==="cessata"?T.red:T.orange;
              return (
                <div>
                  <div style={{background:T.navyMid,border:`1px solid ${T.navyBorder}`,borderLeft:`3px solid ${statusColor}`,borderRadius:8,padding:"20px 24px",marginBottom:12,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                    <div>
                      <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:T.grey,letterSpacing:"0.1em",marginBottom:8}}>STATO SOCIETARIO</div>
                      <div style={{display:"flex",alignItems:"center",gap:12}}>
                        <span style={{fontFamily:"'Playfair Display',serif",fontSize:24,fontWeight:700,color:statusColor}}>{ls.status_label}</span>
                        <span style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:statusColor,background:`${statusColor}15`,padding:"3px 10px",borderRadius:20,border:`1px solid ${statusColor}40`}}>OPENCORPORATES</span>
                      </div>
                    </div>
                    {ls.opencorporates_url && <a href={ls.opencorporates_url} target="_blank" rel="noopener noreferrer" style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:T.accent,border:`1px solid ${T.accentDim}`,padding:"6px 12px",borderRadius:5,textDecoration:"none"}}>SCHEDA →</a>}
                  </div>
                  <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:10,marginBottom:12}}>
                    {[["Denominazione",ls.name||"—"],["Forma giuridica",ls.company_type||"—"],["N° di registro",ls.company_number||"—"],["Data costituzione",ls.incorporation_date?new Date(ls.incorporation_date).toLocaleDateString("it-IT"):"—"],["Sede legale",ls.registered_address||"—"],["Data cessazione",ls.dissolution_date?new Date(ls.dissolution_date).toLocaleDateString("it-IT"):"—"]].map(([label,value])=>(
                      <div key={label} style={{background:T.navyMid,border:`1px solid ${T.navyBorder}`,borderRadius:6,padding:"12px 14px"}}>
                        <div style={{fontFamily:"'DM Mono',monospace",fontSize:8,color:T.grey,letterSpacing:"0.1em",marginBottom:5}}>{label}</div>
                        <div style={{fontFamily:"'DM Sans',sans-serif",fontSize:12.5,color:T.white,fontWeight:500}}>{value}</div>
                      </div>
                    ))}
                  </div>
                  {ls.flags?.length>0 && <div style={{display:"flex",flexDirection:"column",gap:8}}>{ls.flags.map((f,i)=>{const fc=f.severity==="critical"?T.red:f.severity==="warning"?T.orange:T.grey;return(<div key={i} style={{background:f.severity==="critical"?T.redLight:f.severity==="warning"?T.orangeLight:T.greyLight,border:`1px solid ${fc}40`,borderLeft:`3px solid ${fc}`,borderRadius:6,padding:"12px 14px"}}><span style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:fc,marginRight:8,fontWeight:700}}>{f.severity==="critical"?"⚠ CRITICO":f.severity==="warning"?"! ATTENZIONE":"ℹ INFO"}</span><span style={{fontFamily:"'DM Sans',sans-serif",fontSize:12,color:T.white}}>{f.text}</span></div>);})}</div>}
                </div>
              );
            })()}
          </div>
        )}

        {/* Tab: Sources */}
        {tab === "sources" && (
          <div style={{animation:"fadeUp 0.35s ease both"}}>
            <div style={{background:T.navyMid,border:`1px solid ${T.navyBorder}`,borderRadius:8,padding:20,marginBottom:14}}>
              <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:T.grey,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:14}}>Fonti consultate</div>
              {["Pitch deck / materiale commerciale (caricato dall'utente)","Bilancio Infocamere (caricato dall'utente)","OpenStreetMap / Overpass API","Crunchbase / news scraping","LinkedIn company page","Wayback Machine — archivio storico sito web"].map((s,i)=>(
                <div key={i} style={{display:"flex",alignItems:"center",gap:12,padding:"9px 0",borderBottom:i<5?`1px solid ${T.navyBorder}`:"none"}}>
                  <div style={{width:20,height:20,borderRadius:"50%",background:T.navyLight,border:`1px solid ${T.navyBorder}`,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"'DM Mono',monospace",fontSize:8,color:T.accent,flexShrink:0}}>{i+1}</div>
                  <span style={{fontFamily:"'DM Sans',sans-serif",fontSize:12,color:T.whiteDim}}>{s}</span>
                </div>
              ))}
            </div>
            <div style={{background:T.navyMid,border:`1px solid ${T.navyBorder}`,borderRadius:8,padding:20}}>
              <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:T.grey,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:12}}>Disclaimer</div>
              <p style={{fontFamily:"'DM Sans',sans-serif",fontSize:11.5,color:T.grey,lineHeight:1.8,margin:0}}>
                Il presente report è stato generato da TrueScore sulla base di fonti pubblicamente disponibili e dei documenti forniti dall'utente.
                Il report non costituisce parere legale, finanziario o professionale e non deve essere utilizzato come unica base per decisioni
                di investimento o accordi commerciali. TrueScore declina ogni responsabilità per inesattezze nelle fonti consultate. I dati
                sono aggiornati alla data di generazione.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main App ───────────────────────────────────────────────────────────────────
export default function TrueScoreApp() {
  const [screen,    setScreen]    = useState("upload");
  const [jobId,     setJobId]     = useState(null);
  const [companyName, setCN]      = useState("");
  const [result,    setResult]    = useState(null);
  const [steps, setSteps] = useState([
    { n:1, label:"Claim Extractor",     status:"idle", detail:null },
    { n:2, label:"Data Collector",      status:"idle", detail:null },
    { n:3, label:"Verification Engine", status:"idle", detail:null },
    { n:4, label:"Report Generator",    status:"idle", detail:null },
  ]);

  const updStep = (idx, patch) =>
    setSteps(prev => prev.map((s,i) => i===idx ? {...s,...patch} : s));

  const sleep = ms => new Promise(r => setTimeout(r,ms));

  // ── Mock pipeline animation ─────────────────────────────────────────────────
  const runMock = async (companyName) => {
    const labels = [
      ["Claim Extractor",     "Estrazione claim con AI..."],
      ["Data Collector",      "Interrogazione fonti esterne..."],
      ["Verification Engine", "Calcolo verdicts e Trust Score..."],
      ["Report Generator",    "Composizione report..."],
    ];
    for (let i=0; i<4; i++) {
      updStep(i, {status:"running", detail:labels[i][1]});
      await sleep(800 + Math.random()*400);
      updStep(i, {status:"done", detail:i===2?`Trust Score: 1.7/10`:`${[4,8,4,4][i]} risultati`});
      await sleep(200);
    }
    await sleep(400);
    setResult(buildMockResult(companyName));
    setScreen("report");
  };

  // ── Real API pipeline ───────────────────────────────────────────────────────
  const runReal = async (payload) => {
    // Pre-fetch dati da siti terzi con l'IP reale del browser
    updStep(0, {status:"running", detail:"Recupero dati da fonti esterne..."});
    const prefetchedData = await prefetchExternalData(
      payload.companyName,
      payload.vatNumber || ""
    );
    payload = { ...payload, prefetchedData };

    const { job_id } = await apiAnalyze(payload);
    setJobId(job_id);

    // Polling SSE
    const es = new EventSource(`${API_BASE}/api/status/${job_id}/stream`);
    const stepMap = {1:0,2:1,3:2,4:3};

    es.onmessage = async (e) => {
      const data = JSON.parse(e.data);
      if (data.status === "closed" || data.status === "done") {
        es.close();
        const res = await apiResult(job_id);
        setResult({...res, legal_status: res.legal_status||null, key_people: res.key_people||null});
        setScreen("report");
        return;
      }
      if (data.status === "error") {
        es.close();
        alert("Errore analisi: " + (data.error||"sconosciuto"));
        setScreen("upload");
        return;
      }
      const stepIdx = stepMap[data.current_step];
      if (stepIdx !== undefined) {
        // Completa gli step precedenti
        for (let i=0; i<stepIdx; i++) updStep(i, {status:"done"});
        updStep(stepIdx, {
          status: data.step_status === "done" ? "done" : "running",
          detail: data.step_detail,
        });
      }
    };
    es.onerror = () => { es.close(); };
  };

  const handleSubmit = async (payload) => {
    setCN(payload.companyName);
    setSteps([
      {n:1,label:"Claim Extractor",     status:"idle",detail:null},
      {n:2,label:"Data Collector",      status:"idle",detail:null},
      {n:3,label:"Verification Engine", status:"idle",detail:null},
      {n:4,label:"Report Generator",    status:"idle",detail:null},
    ]);
    setScreen("analyzing");
    try {
      if (USE_MOCK) await runMock(payload.companyName);
      else          await runReal(payload);
    } catch (err) {
      alert(`Errore: ${err.message}`);
      setScreen("upload");
    }
  };

  const handleReset = () => {
    setScreen("upload"); setResult(null); setJobId(null);
  };

  if (screen==="upload")    return <UploadScreen onSubmit={handleSubmit}/>;
  if (screen==="analyzing") return <AnalyzingScreen companyName={companyName} steps={steps}/>;
  if (screen==="report")    return <ReportScreen result={result} jobId={jobId} onReset={handleReset}/>;
  return null;
}
