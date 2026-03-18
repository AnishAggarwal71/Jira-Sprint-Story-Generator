import { useState, useRef, useEffect, useCallback } from "react";

const JIRA_MCP = "https://mcp.atlassian.com/v1/mcp";
const M365_MCP = "https://microsoft365.mcp.claude.com/mcp";
const PRIORITIES = ["Highest", "High", "Medium", "Low", "Lowest"];
const PRI_IDS = { Highest: "1", High: "2", Medium: "3", Low: "4", Lowest: "5" };
const ROLE = "Data Analyst";
const F_SP = "customfield_10120";
const F_AC = "customfield_10121";
const F_SPRINT = "customfield_10020";

async function mc(prompt, sys, url, name) {
  const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 2000, system: sys || "Be concise.", messages: [{ role: "user", content: prompt }], mcp_servers: [{ type: "url", url, name }] }) });
  return r.json();
}
function tx(d) { return (d.content || []).filter(b => b.type === "text").map(b => b.text).join(" "); }
function tr(d) { return (d.content || []).filter(b => b.type === "mcp_tool_result"); }
function jp(s) { try { return JSON.parse(s.replace(/```json|```/g, "").trim()); } catch { return null; } }

async function discoverJira(onLog) {
  onLog("Connecting to Atlassian...");
  const d = await mc("Do two things:\n1. List accessible Atlassian cloud resources\n2. Get current user\nReturn ONLY JSON: {cloudId, siteUrl, accountId, displayName}.", "JSON only.", JIRA_MCP, "atlassian");
  const t = tx(d); const trs = tr(d);
  let p = jp(t);
  if (p && p.cloudId && p.accountId) { onLog("Found cloud: " + (p.siteUrl || p.cloudId)); return p; }
  let cloudId = null, siteUrl = null, accountId = null, displayName = null;
  for (const r of trs) { try { const c = JSON.parse(r.content?.[0]?.text || "{}"); if (Array.isArray(c) && c[0]?.id) { cloudId = c[0].id; siteUrl = c[0].url; } if (c.accountId) { accountId = c.accountId; displayName = c.displayName; } } catch {} }
  if (!accountId) { const m = t.match(/"accountId"\s*:\s*"([^"]+)"/); if (m) accountId = m[1]; }
  if (!displayName) { const m = t.match(/"displayName"\s*:\s*"([^"]+)"/); if (m) displayName = m[1]; }
  if (!cloudId) { const m = t.match(/"(?:id|cloudId)"\s*:\s*"([0-9a-f-]{36})"/); if (m) cloudId = m[1]; }
  onLog(cloudId ? "Connected to " + (siteUrl || cloudId) : "Connection issue");
  return { cloudId, siteUrl, accountId, displayName: displayName || "Connected User" };
}

async function fetchEpics(pk, onLog) {
  onLog("Loading epics for " + pk + "...");
  const d = await mc("Search Jira: project = " + pk + " AND issuetype = Epic AND status != Done ORDER BY updated DESC. Max 30. Return ONLY JSON array: [{key, summary}].", "JSON array only.", JIRA_MCP, "atlassian");
  const r = jp(tx(d)) || [];
  onLog("Found " + r.length + " epics");
  return r;
}

async function fetchSprints(pk, onLog) {
  onLog("Loading sprints for " + pk + "...");
  const d = await mc('Search Jira issues with JQL: project = ' + pk + ' AND sprint is not EMPTY ORDER BY updated DESC. Return max 5 results. For each issue, extract the sprint data from customfield_10020. Then deduplicate sprints and return ONLY a JSON array of unique sprints: [{id, name, state}]. Only include sprints with state "active" or "future". No markdown.', "Extract sprint objects from customfield_10020 of the search results. Deduplicate by id. Return JSON array of unique sprints with state active or future only.", JIRA_MCP, "atlassian");
  const t = tx(d); let arr = jp(t) || [];
  if (!Array.isArray(arr)) arr = [];
  const active = arr.filter(s => s.state === "active").slice(0, 1);
  const future = arr.filter(s => s.state === "future").slice(0, 2);
  const result = [...active, ...future].slice(0, 3);
  onLog("Found " + result.length + " sprint" + (result.length !== 1 ? "s" : ""));
  return result;
}

async function pushIssue(story, pk, cloudId, acctId, priority, parentKey, sprintId) {
  const ac = story.acceptance_criteria.map((a, i) => (i+1) + ". " + a).join("\n");
  let af = '"' + F_SP + '": ' + story.story_points + ', "' + F_AC + '": "' + ac.replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
  if (priority) af = '"priority": {"id": "' + (PRI_IDS[priority] || "3") + '"}, ' + af;
  if (sprintId) af = '"' + F_SPRINT + '": ' + sprintId + ', ' + af;
  let pLine = parentKey ? ('\nparent: "' + parentKey + '"') : "";
  const prompt = 'Create Jira issue with createJiraIssue:\ncloudId: "' + cloudId + '"\nprojectKey: "' + pk + '"\nissueTypeName: "Story"\nsummary: "' + story.title.replace(/"/g, '\\"') + '"' + pLine + '\ndescription: "' + story.description.replace(/"/g, '\\"') + '"\ncontentFormat: "markdown"\nassignee_account_id: "' + acctId + '"\nadditional_fields: {' + af + '}\n\nUse EXACT parameters.';
  const d = await mc(prompt, '"' + F_SP + '"=Story Points, "' + F_AC + '"=Acceptance Criteria. Not in description.', JIRA_MCP, "atlassian");
  const t = tx(d);
  return { success: (tr(d).length > 0 || t.toLowerCase().includes("created")) && !d.error, message: t };
}

async function enrichTasks(tasks, onP) {
  const steps = tasks.map((t, i) => ({ label: "Task " + (i+1) + ": " + (t.text.length > 36 ? t.text.slice(0,36) + "\u2026" : t.text), status: "searching", found: false }));
  onP([...steps]);
  const prompt = tasks.map((t, i) => (i+1) + ". " + t.text + (t.notes ? " [Notes: " + t.notes + "]" : "")).join("\n");
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 4000, system: "Search M365. Return ONLY JSON array: [{task, context_found, email_context, teams_context, doc_context, key_requirements, stakeholders}].", messages: [{ role: "user", content: "Search M365:\n\n" + prompt }], mcp_servers: [{ type: "url", url: M365_MCP, name: "microsoft365" }] }) });
    const d = await r.json(); const en = jp(tx(d)) || tasks.map(t => ({ task: t.text, context_found: false }));
    steps.forEach((_, i) => { steps[i].status = "done"; steps[i].found = en[i]?.context_found || false; }); onP([...steps]); return en;
  } catch { steps.forEach((_, i) => { steps[i].status = "error"; }); onP([...steps]); return tasks.map(t => ({ task: t.text, context_found: false })); }
}

function buildPrompt(en, tasks) {
  const hasCtx = en.some(t => t.context_found), hasN = tasks.some(t => t.notes?.trim());
  let ctx = "";
  if (hasCtx || hasN) { ctx = "\n\nCONTEXT:\n" + en.map((t, i) => { let b = "\nTask " + (i+1) + ': "' + t.task + '"'; if (tasks[i]?.notes?.trim()) b += "\n  Notes: " + tasks[i].notes; if (t.context_found) { if (t.email_context && t.email_context !== "none found") b += "\n  Email: " + t.email_context; if (t.teams_context && t.teams_context !== "none found") b += "\n  Teams: " + t.teams_context; if (t.doc_context && t.doc_context !== "none found") b += "\n  Docs: " + t.doc_context; } return b; }).join(""); }
  return 'You are an Agile Scrum Master.\n\nRULES:\n- EXACTLY ONE story per task. ' + tasks.length + ' tasks = ' + tasks.length + ' stories.\n- TASK = primary action. NOTES = context within that task.\n- title: Craft a clear, professional story title. Do NOT just copy the task text verbatim. Rephrase it as a concise deliverable (e.g. task "Summary Activity Dashboard Refresh" becomes "SAD Monthly Refresh with DT Fixes and March 2026 Targets"). The title should reflect the actual scope including notes context.\n- Description: "As a ' + ROLE + ', I want to [goal] so that [benefit]." 1-2 sentences. Do not list notes in description.\n- Acceptance Criteria: 3-5 testable. Turn notes into QC criteria.\n- story_points: Fibonacci (0.5,1,2,3,5,8). Refresh+QC=1-2. Fix=0.5. Docs=0.5-1.\n- Do NOT generate priority or complexity.\n- Sprint cap 8 SP.' + (hasCtx ? '\n- context_sources: Short note' : '') + '\n\nReturn: {"recommended_capacity": N, "capacity_rationale": "...", "stories": [...]}\nONLY JSON.' + ctx;
}

async function genStories(tasks, en) {
  const sys = buildPrompt(en, tasks);
  const list = tasks.map((t, i) => (i+1) + ". " + t.text + (t.notes ? " [Notes: " + t.notes + "]" : "")).join("\n");
  const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 4000, system: sys, messages: [{ role: "user", content: "Generate EXACTLY " + tasks.length + " stories:\n\n" + list }] }) });
  return jp(tx(await r.json()));
}

function spCol(p) { if (p<=1) return {bg:"#E8F5E9",br:"#43A047",tx:"#2E7D32"}; if (p<=2) return {bg:"#E3F2FD",br:"#1E88E5",tx:"#1565C0"}; if (p<=3) return {bg:"#FFF8E1",br:"#FFB300",tx:"#F57F17"}; if (p<=5) return {bg:"#FBE9E7",br:"#F4511E",tx:"#BF360C"}; return {bg:"#F3E5F5",br:"#8E24AA",tx:"#6A1B9A"}; }
function SPB({p}) { const c=spCol(p); return <span style={{display:"inline-flex",alignItems:"center",gap:4,padding:"3px 10px",borderRadius:20,backgroundColor:c.bg,border:"1.5px solid "+c.br,color:c.tx,fontWeight:700,fontSize:12}}>{"◆ "+p+" SP"}</span>; }
function Pri({p}) { if(!p) return null; const m={Highest:{bg:"#B71C1C",c:"#FFF"},High:{bg:"#FFCDD2",c:"#B71C1C"},Medium:{bg:"#FFE0B2",c:"#E65100"},Low:{bg:"#C8E6C9",c:"#1B5E20"},Lowest:{bg:"#E0E0E0",c:"#616161"}}; const s=m[p]||m.Medium; return <span style={{padding:"2px 8px",borderRadius:10,backgroundColor:s.bg,color:s.c,fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:0.5}}>{p}</span>; }

function SSel({options,value,onChange,placeholder,disabled}) {
  const [open,setOpen]=useState(false); const [flt,setFlt]=useState(""); const ref=useRef(null);
  useEffect(()=>{const h=e=>{if(ref.current&&!ref.current.contains(e.target))setOpen(false)};document.addEventListener("mousedown",h);return()=>document.removeEventListener("mousedown",h)},[]);
  const fd=options.filter(o=>o.label.toLowerCase().includes(flt.toLowerCase())); const sel=options.find(o=>o.value===value);
  return (
    <div ref={ref} style={{position:"relative",flex:1,minWidth:120}}>
      <div onClick={()=>!disabled&&setOpen(!open)} style={{padding:"5px 8px",borderRadius:6,border:"1.5px solid #CFD8DC",fontSize:11,backgroundColor:disabled?"#F5F5F5":"#FFF",color:value?"#263238":"#B0BEC5",cursor:disabled?"not-allowed":"pointer",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",minHeight:18}}>{sel?sel.label:placeholder||"Select..."}</div>
      {open&&<div style={{position:"absolute",top:"100%",left:0,right:0,zIndex:100,backgroundColor:"#FFF",border:"1px solid #CFD8DC",borderRadius:6,boxShadow:"0 4px 16px rgba(0,0,0,0.12)",maxHeight:200,overflow:"hidden",marginTop:2}}>
        <input type="text" value={flt} onChange={e=>setFlt(e.target.value)} placeholder="Type to filter..." autoFocus style={{width:"100%",padding:"6px 8px",border:"none",borderBottom:"1px solid #ECEFF1",fontSize:11,outline:"none",boxSizing:"border-box"}} />
        <div style={{maxHeight:160,overflowY:"auto"}}>
          <div onClick={()=>{onChange("");setOpen(false);setFlt("")}} style={{padding:"5px 8px",fontSize:11,color:"#90A4AE",cursor:"pointer"}}>None</div>
          {fd.map(o=><div key={o.value} onClick={()=>{onChange(o.value);setOpen(false);setFlt("")}} style={{padding:"5px 8px",fontSize:11,cursor:"pointer",backgroundColor:o.value===value?"#E3F2FD":"transparent",color:"#263238",borderBottom:"1px solid #F5F5F5"}}>{o.label}</div>)}
          {fd.length===0&&<div style={{padding:"8px",fontSize:11,color:"#B0BEC5",textAlign:"center"}}>No matches</div>}
        </div>
      </div>}
    </div>
  );
}

function TRow({task,index,onChange,onRemove,total,epics,sprints,jc}) {
  const [sn,setSn]=useState(!!task.notes);
  return (
    <div style={{backgroundColor:"#FAFAFA",borderRadius:10,border:"1px solid #ECEFF1",padding:"10px 12px"}}>
      <div style={{display:"flex",gap:7,alignItems:"center"}}>
        <span style={{width:22,height:22,borderRadius:6,backgroundColor:"#263238",color:"#FFF",display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:700,fontFamily:"'Space Mono', monospace",flexShrink:0}}>{index+1}</span>
        <input type="text" value={task.text} onChange={e=>onChange(index,"text",e.target.value)} placeholder="Describe your task..." style={{flex:1,padding:"7px 10px",borderRadius:8,border:"1.5px solid #CFD8DC",fontSize:13,fontFamily:"'Space Mono', monospace",outline:"none",backgroundColor:"#FFF",color:"#263238",boxSizing:"border-box"}} onFocus={e=>e.target.style.borderColor="#43A047"} onBlur={e=>e.target.style.borderColor="#CFD8DC"} />
        <select value={task.priority||""} onChange={e=>onChange(index,"priority",e.target.value)} style={{width:90,padding:"7px 2px",borderRadius:8,border:"1.5px solid #CFD8DC",fontSize:11,outline:"none",color:task.priority?"#263238":"#B0BEC5",backgroundColor:"#FFF",flexShrink:0}}>
          <option value="">Priority</option>{PRIORITIES.map(p=><option key={p} value={p}>{p}</option>)}
        </select>
        <button onClick={()=>setSn(!sn)} title="Notes" style={{width:28,height:28,borderRadius:7,border:"1.5px solid "+(sn||task.notes?"#1E88E5":"#CFD8DC"),backgroundColor:sn||task.notes?"#E3F2FD":"#FFF",color:sn||task.notes?"#1565C0":"#90A4AE",cursor:"pointer",fontSize:12,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>{"\uD83D\uDCDD"}</button>
        {total>1&&<button onClick={()=>onRemove(index)} style={{width:28,height:28,borderRadius:7,border:"1.5px solid #FFCDD2",backgroundColor:"#FFF",color:"#E53935",cursor:"pointer",fontSize:14,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>{"\u00D7"}</button>}
      </div>
      {jc&&(epics.length>0||sprints.length>0)&&<div style={{display:"flex",gap:6,marginTop:6,marginLeft:29}}>
        {epics.length>0&&<SSel options={epics.map(e=>({value:e.key,label:e.key+": "+(e.summary?.length>28?e.summary.slice(0,28)+"\u2026":e.summary)}))} value={task.parent||""} onChange={v=>onChange(index,"parent",v)} placeholder="Parent (Epic)" />}
        {sprints.length>0&&<SSel options={sprints.map(s=>({value:String(s.id),label:s.name+" ("+s.state+")"}))} value={task.sprint||""} onChange={v=>onChange(index,"sprint",v)} placeholder="Sprint" />}
      </div>}
      {sn&&<div style={{marginTop:6,marginLeft:29}}><textarea value={task.notes||""} onChange={e=>onChange(index,"notes",e.target.value)} placeholder="Context: resolved issues, changes to QC, new data..." rows={2} style={{width:"100%",padding:"7px 10px",borderRadius:8,border:"1.5px solid #90CAF9",fontSize:12,lineHeight:1.5,resize:"vertical",outline:"none",backgroundColor:"#F3F8FF",color:"#37474F",boxSizing:"border-box"}} /></div>}
    </div>
  );
}

function ESP({points,onChange}) {
  const [ed,setEd]=useState(false); const [v,setV]=useState(String(points)); const ref=useRef(null);
  useEffect(()=>{setV(String(points))},[points]); useEffect(()=>{if(ed&&ref.current)ref.current.focus()},[ed]);
  const cm=()=>{const n=parseFloat(v);if(!isNaN(n)&&n>=0)onChange(n);else setV(String(points));setEd(false)};
  if(ed) return <div onClick={e=>e.stopPropagation()} style={{display:"inline-flex",alignItems:"center",gap:4}}><input ref={ref} type="number" step="0.25" min="0" max="99" value={v} onChange={e=>setV(e.target.value)} onBlur={cm} onKeyDown={e=>{if(e.key==="Enter")cm();if(e.key==="Escape"){setV(String(points));setEd(false)}}} style={{width:50,padding:"3px 5px",borderRadius:6,border:"2px solid #43A047",fontSize:13,fontFamily:"'Space Mono', monospace",fontWeight:800,textAlign:"center",outline:"none",color:"#2E7D32",backgroundColor:"#E8F5E9"}} /><span style={{fontSize:10,fontWeight:700,color:"#43A047"}}>SP</span></div>;
  return <div onClick={e=>{e.stopPropagation();setEd(true)}} style={{cursor:"pointer"}} title="Click to edit"><SPB p={points} /></div>;
}

function SC({story,index,jS,onSP,task,sprints,epics}) {
  const [op,setOp]=useState(true);
  const stM={success:{bg:"#E8F5E9",c:"#2E7D32",l:"\u2713 IN JIRA"},pushing:{bg:"#FFF8E1",c:"#F57F17",l:"PUSHING..."},error:{bg:"#FFEBEE",c:"#C62828",l:"FAILED"}};
  const st=jS?stM[jS]:null; const pe=task?.parent?epics.find(e=>e.key===task.parent):null; const sp=task?.sprint?sprints.find(s=>String(s.id)===task.sprint):null;
  return (
    <div style={{backgroundColor:"#FFF",border:"1px solid #E0E0E0",borderRadius:12,overflow:"hidden",boxShadow:"0 1px 4px rgba(0,0,0,0.04)"}}>
      <div onClick={()=>setOp(!op)} style={{padding:"12px 14px",cursor:"pointer",display:"flex",alignItems:"center",gap:8,borderBottom:op?"1px solid #F0F0F0":"none",userSelect:"none",flexWrap:"wrap"}}>
        <span style={{width:22,height:22,borderRadius:6,backgroundColor:"#263238",color:"#FFF",display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:700,fontFamily:"'Space Mono', monospace",flexShrink:0}}>{index+1}</span>
        <h3 style={{margin:0,flex:1,fontSize:13,fontWeight:700,color:"#212121",lineHeight:1.4,minWidth:140}}>{story.title}</h3>
        {st&&<span style={{padding:"2px 7px",borderRadius:10,fontSize:9,fontWeight:700,backgroundColor:st.bg,color:st.c}}>{st.l}</span>}
        <ESP points={story.story_points} onChange={v=>onSP(index,v)} />
        <span style={{fontSize:14,color:"#90A4AE",transform:op?"rotate(180deg)":"rotate(0deg)",transition:"transform 0.2s"}}>{"\u25BE"}</span>
      </div>
      {op&&<div style={{padding:"12px 14px 14px"}}>
        <div style={{display:"flex",gap:6,marginBottom:10,flexWrap:"wrap",alignItems:"center"}}>
          <Pri p={task?.priority} />
          {pe&&<span style={{padding:"2px 8px",borderRadius:10,backgroundColor:"#EDE7F6",color:"#5E35B1",fontSize:10,fontWeight:700}}>{"\uD83D\uDCCB "+pe.key}</span>}
          {sp&&<span style={{padding:"2px 8px",borderRadius:10,backgroundColor:"#E3F2FD",color:"#1565C0",fontSize:10,fontWeight:700}}>{"\uD83C\uDFC3 "+sp.name}</span>}
        </div>
        <div style={{marginBottom:10}}>
          <h4 style={{margin:"0 0 3px",fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:1,color:"#90A4AE"}}>Description</h4>
          <p style={{margin:0,fontSize:12,lineHeight:1.6,color:"#455A64"}}>{story.description}</p>
        </div>
        {story.context_sources&&<div style={{marginBottom:10,padding:"7px 10px",backgroundColor:"#E3F2FD",borderRadius:7,borderLeft:"3px solid #1E88E5"}}><p style={{margin:0,fontSize:11,color:"#1565C0"}}>{story.context_sources}</p></div>}
        <div>
          <h4 style={{margin:"0 0 6px",fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:1,color:"#90A4AE"}}>Acceptance Criteria</h4>
          <div style={{display:"flex",flexDirection:"column",gap:3}}>
            {story.acceptance_criteria.map((ac,i)=><div key={i} style={{display:"flex",gap:7,alignItems:"flex-start",padding:"5px 8px",backgroundColor:"#FAFAFA",borderRadius:6,border:"1px solid #F0F0F0"}}><span style={{width:14,height:14,borderRadius:4,border:"2px solid #B0BEC5",flexShrink:0,marginTop:1,display:"flex",alignItems:"center",justifyContent:"center",fontSize:7,color:"#B0BEC5"}}>{"\u2713"}</span><span style={{fontSize:11,lineHeight:1.5,color:"#37474F"}}>{ac}</span></div>)}
          </div>
        </div>
      </div>}
    </div>
  );
}

function ELog({steps}) {
  if(!steps.length) return null;
  return <div style={{marginBottom:12,borderRadius:10,border:"1px solid #E0E0E0",overflow:"hidden",backgroundColor:"#FFF"}}>
    <div style={{padding:"7px 12px",backgroundColor:"#E3F2FD",fontSize:11,fontWeight:700,color:"#1565C0",display:"flex",alignItems:"center",gap:5}}>{"\uD83D\uDD0D M365 Enrichment"}</div>
    <div style={{maxHeight:130,overflowY:"auto"}}>{steps.map((s,i)=><div key={i} style={{padding:"5px 12px",borderBottom:"1px solid #F5F5F5",display:"flex",alignItems:"center",gap:7,fontSize:11}}>
      <span style={{width:6,height:6,borderRadius:"50%",flexShrink:0,backgroundColor:s.status==="done"?"#43A047":s.status==="searching"?"#1E88E5":"#E53935",animation:s.status==="searching"?"pulse 1s infinite":"none"}} />
      <span style={{flex:1,color:"#37474F",fontWeight:500}}>{s.label}</span>
      <span style={{fontSize:9,fontWeight:700,color:s.status==="done"?"#2E7D32":"#1565C0"}}>{s.status==="done"?(s.found?"Found":"None"):"..."}</span>
    </div>)}</div>
    <style>{"@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}"}</style>
  </div>;
}

function ConnLog({logs}) {
  if(!logs.length) return null;
  return <div style={{marginTop:8,borderRadius:6,border:"1px solid #ECEFF1",overflow:"hidden",maxHeight:120,overflowY:"auto"}}>
    {logs.map((l,i)=><div key={i} style={{padding:"4px 10px",borderBottom:"1px solid #F5F5F5",fontSize:10,color:"#546E7A",display:"flex",alignItems:"center",gap:5}}>
      <span style={{width:5,height:5,borderRadius:"50%",backgroundColor:l.includes("Found")||l.includes("Connected")||l.includes("epics")||l.includes("sprint")?"#43A047":l.includes("issue")||l.includes("failed")?"#E53935":"#1E88E5",flexShrink:0}} />
      {l}
    </div>)}
  </div>;
}

export default function App() {
  const [tasks,setTasks]=useState([{text:"",notes:"",priority:"",parent:"",sprint:""}]);
  const [stories,setStories]=useState(null);
  const [recSP,setRecSP]=useState(null);
  const [spR,setSpR]=useState("");
  const [mCap,setMCap]=useState("");
  const [uCap,setUCap]=useState(false);
  const [loading,setLoading]=useState(false);
  const [phase,setPhase]=useState("");
  const [error,setError]=useState(null);
  const [useM,setUseM]=useState(true);
  const [eSteps,setESteps]=useState([]);
  const [pk,setPk]=useState("");
  const [jL,setJL2]=useState(false);
  const [jC,setJC]=useState(null);
  const [jE,setJE]=useState(null);
  const [epics,setEpics]=useState([]);
  const [sprints,setSprints]=useState([]);
  const [jS,setJS]=useState({});
  const [pushing,setPushing]=useState(false);
  const [jLog,setJLog]=useState([]);
  const [connLogs,setConnLogs]=useState([]);
  const rRef=useRef(null);

  const addLog=useCallback((msg)=>{setConnLogs(prev=>[...prev,msg])},[]);
  const uT=(i,f,v)=>{const u=[...tasks];u[i]={...u[i],[f]:v};setTasks(u)};
  const addT=()=>setTasks([...tasks,{text:"",notes:"",priority:"",parent:"",sprint:""}]);
  const rmT=i=>tasks.length>1&&setTasks(tasks.filter((_,j)=>j!==i));
  const val=tasks.filter(t=>t.text.trim());
  const uSP=(i,v)=>{const u=[...stories];u[i]={...u[i],story_points:v};setStories(u)};

  const cap=uCap&&mCap?parseFloat(mCap)||999:recSP||999;
  const tot=stories?stories.reduce((s,st)=>s+(st.story_points||0),0):0;
  const allD=stories?.length>0&&Object.keys(jS).length===stories.length&&Object.values(jS).every(s=>s==="success");
  const someF=stories&&Object.values(jS).some(s=>s==="error");
  const okC=Object.values(jS).filter(s=>s==="success").length;

  const reset=()=>{setTasks([{text:"",notes:"",priority:"",parent:"",sprint:""}]);setStories(null);setRecSP(null);setSpR("");setMCap("");setUCap(false);setError(null);setESteps([]);setJS({});setJLog([]);setPushing(false);setPhase("")};

  const connect=useCallback(async()=>{
    if(!pk.trim())return;
    setJL2(true);setJE(null);setConnLogs([]);
    try{
      const ctx=await discoverJira(addLog);
      if(ctx.cloudId){
        setJC(ctx);addLog("Authenticated as "+ctx.displayName);
        const [ep,sp]=await Promise.all([fetchEpics(pk.trim().toUpperCase(),addLog),fetchSprints(pk.trim().toUpperCase(),addLog)]);
        setEpics(Array.isArray(ep)?ep:[]);setSprints(Array.isArray(sp)?sp:[]);
        addLog("Ready to push stories");
      } else {setJE("Could not connect. Ensure Atlassian connector is enabled.");addLog("Connection failed")}
    }catch(e){console.error(e);setJE("Connection failed.");addLog("Error: "+e.message)}
    setJL2(false);
  },[pk,addLog]);

  const generate=async()=>{
    if(!val.length)return;
    setLoading(true);setError(null);setStories(null);setJS({});setJLog([]);setESteps([]);setRecSP(null);setSpR("");
    try{
      let en;
      if(useM){setPhase("enriching");en=await enrichTasks(val,setESteps)}else en=val.map(t=>({task:t.text,context_found:false}));
      setPhase("generating");
      const res=await genStories(val,en);
      if(res?.stories){setStories(res.stories);setRecSP(res.recommended_capacity);setSpR(res.capacity_rationale||"")}
      else if(Array.isArray(res)){setStories(res);setRecSP(res.reduce((s,st)=>s+(st.story_points||0),0))}
      else setError("Unexpected response. Try again.");
    }catch(e){console.error(e);setError("Something went wrong.")}
    finally{setLoading(false);setPhase("")}
  };

  const push=async()=>{
    if(!stories||!pk.trim()||!jC?.cloudId||allD)return;
    setPushing(true);setJLog([]);
    const st={...jS},logs=[];
    for(let i=0;i<stories.length;i++){
      if(st[i]==="success")continue;
      st[i]="pushing";setJS({...st});
      logs.push({i,title:stories[i].title,status:"pushing"});setJLog([...logs]);
      try{
        const t=val[i];
        const r=await pushIssue(stories[i],pk.trim().toUpperCase(),jC.cloudId,jC.accountId,t?.priority||null,t?.parent||null,t?.sprint?parseInt(t.sprint):null);
        st[i]=r.success?"success":"error";
      }catch{st[i]="error"}
      logs[logs.length-1].status=st[i];setJS({...st});setJLog([...logs]);
    }
    setPushing(false);
  };

  useEffect(()=>{if(stories&&rRef.current)rRef.current.scrollIntoView({behavior:"smooth",block:"start"})},[stories]);

  return (
    <div style={{minHeight:"100vh",backgroundColor:"#F5F5F5",fontFamily:"'DM Sans', sans-serif"}}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet" />
      <style>{"@keyframes spin{to{transform:rotate(360deg)}}"}</style>

      <div style={{background:"linear-gradient(135deg,#263238 0%,#37474F 50%,#455A64 100%)",padding:"32px 24px 26px",textAlign:"center"}}>
        <div style={{display:"inline-flex",alignItems:"center",gap:10,marginBottom:8}}>
          <span style={{width:36,height:36,borderRadius:9,background:"linear-gradient(135deg,#66BB6A,#43A047)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:17}}>{"\u26A1"}</span>
          <h1 style={{margin:0,fontSize:22,fontWeight:800,color:"#FFF",letterSpacing:-0.5}}>Sprint Story Generator</h1>
        </div>
        <p style={{margin:"0 0 12px",fontSize:12,color:"#B0BEC5"}}>AI-powered user story creation for your team</p>
        <div style={{display:"inline-flex",gap:7,flexWrap:"wrap",justifyContent:"center"}}>
          {[["Microsoft 365","#90CAF9","#64B5F6"],["Jira","#CE93D8","#BA68C8"],["SP Estimation","#80CBC4","#4DB6AC"]].map(([l,c,d])=><span key={l} style={{padding:"4px 14px",borderRadius:18,backgroundColor:"rgba(255,255,255,0.08)",fontFamily:"'Space Mono', monospace",fontSize:11,color:c,fontWeight:700,display:"flex",alignItems:"center",gap:5}}><span style={{width:6,height:6,borderRadius:"50%",backgroundColor:d}}/>{l}</span>)}
        </div>
      </div>

      <div style={{maxWidth:720,margin:"0 auto",padding:"22px 16px 60px"}}>
        <div style={{backgroundColor:"#FFF",borderRadius:12,padding:18,border:"1px solid #E0E0E0",marginBottom:12}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
            <div><label style={{fontSize:12,fontWeight:700,color:"#37474F",textTransform:"uppercase",letterSpacing:0.8}}>Sprint Tasks</label><p style={{margin:"2px 0 0",fontSize:11,color:"#90A4AE"}}>Add your tasks for this sprint</p></div>
            <button onClick={addT} style={{padding:"5px 10px",borderRadius:7,border:"1.5px solid #43A047",backgroundColor:"#FFF",color:"#2E7D32",fontSize:11,fontWeight:700,cursor:"pointer"}}>+ Add</button>
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:6}}>{tasks.map((t,i)=><TRow key={i} task={t} index={i} onChange={uT} onRemove={rmT} total={tasks.length} epics={epics} sprints={sprints} jc={!!jC} />)}</div>
          <div style={{marginTop:10,display:"flex",alignItems:"center",gap:9,padding:"9px 12px",backgroundColor:useM?"#E3F2FD":"#FAFAFA",borderRadius:9,border:"1.5px solid "+(useM?"#90CAF9":"#E0E0E0"),cursor:"pointer"}} onClick={()=>setUseM(!useM)}>
            <div style={{width:34,height:18,borderRadius:9,backgroundColor:useM?"#1E88E5":"#B0BEC5",position:"relative",flexShrink:0}}><div style={{width:14,height:14,borderRadius:7,backgroundColor:"#FFF",position:"absolute",top:2,left:useM?18:2,transition:"left 0.2s",boxShadow:"0 1px 3px rgba(0,0,0,0.2)"}} /></div>
            <div style={{flex:1}}><span style={{fontSize:12,fontWeight:700,color:useM?"#1565C0":"#78909C"}}>Enrich with Microsoft 365</span><span style={{fontSize:10,color:useM?"#42A5F5":"#B0BEC5",display:"block",marginTop:1}}>{useM?"Outlook \u00B7 Teams \u00B7 SharePoint":"Task text + notes only"}</span></div>
          </div>
          <button onClick={generate} disabled={loading||!val.length} style={{marginTop:10,width:"100%",padding:"11px 18px",borderRadius:9,border:"none",background:loading||!val.length?"#B0BEC5":"linear-gradient(135deg,#43A047,#2E7D32)",color:"#FFF",fontSize:13,fontWeight:700,cursor:loading||!val.length?"not-allowed":"pointer"}}>{loading?(phase==="enriching"?"\uD83D\uDD0D Searching M365...":"\u23F3 Generating..."):useM?"Search M365 & Generate":"Generate Stories"}</button>
        </div>

        {loading&&phase==="generating"&&!eSteps.length&&<div style={{textAlign:"center",padding:"18px 0"}}><div style={{width:28,height:28,border:"3px solid #E0E0E0",borderTopColor:"#43A047",borderRadius:"50%",animation:"spin 0.8s linear infinite",margin:"0 auto 7px"}} /><p style={{fontSize:12,color:"#78909C",fontWeight:600}}>Generating stories...</p></div>}
        <ELog steps={eSteps} />
        {error&&<div style={{padding:10,borderRadius:9,backgroundColor:"#FFEBEE",border:"1px solid #EF9A9A",color:"#C62828",fontSize:12,fontWeight:600,textAlign:"center",marginBottom:12}}>{error}</div>}

        {stories&&<div ref={rRef}>
          <div style={{backgroundColor:"#FFF",borderRadius:12,border:"1px solid #E0E0E0",padding:16,marginBottom:12}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
              <span style={{fontSize:11,fontWeight:700,color:"#37474F",textTransform:"uppercase",letterSpacing:0.8}}>Sprint Capacity</span>
              <span style={{fontSize:20,fontWeight:800,fontFamily:"'Space Mono', monospace",color:tot>cap&&cap!==999?"#C62828":"#2E7D32"}}>{tot}<span style={{fontSize:12,fontWeight:500,color:"#90A4AE"}}>{" / "+(cap===999?"\u2014":cap)+" SP"}</span></span>
            </div>
            {cap!==999&&<div style={{height:7,borderRadius:7,backgroundColor:"#ECEFF1",overflow:"hidden",marginBottom:8}}><div style={{height:"100%",width:Math.min((tot/cap)*100,100)+"%",borderRadius:7,background:tot>cap?"linear-gradient(90deg,#EF5350,#C62828)":"linear-gradient(90deg,#66BB6A,#2E7D32)",transition:"width 0.6s"}} /></div>}
            {recSP&&<div style={{padding:"8px 12px",backgroundColor:"#F1F8E9",borderRadius:7,borderLeft:"3px solid #66BB6A",marginBottom:8}}><div style={{fontSize:11,fontWeight:700,color:"#33691E"}}>Recommended: <span style={{fontFamily:"'Space Mono', monospace",fontSize:13}}>{recSP+" SP"}</span></div>{spR&&<div style={{fontSize:10,color:"#558B2F",lineHeight:1.4}}>{spR}</div>}</div>}
            <div style={{display:"flex",alignItems:"center",gap:9}}>
              <div onClick={()=>setUCap(!uCap)} style={{display:"flex",alignItems:"center",gap:7,cursor:"pointer"}}><div style={{width:32,height:16,borderRadius:8,backgroundColor:uCap?"#FF9800":"#CFD8DC",position:"relative",flexShrink:0}}><div style={{width:12,height:12,borderRadius:6,backgroundColor:"#FFF",position:"absolute",top:2,left:uCap?18:2,transition:"left 0.2s"}} /></div><span style={{fontSize:11,fontWeight:600,color:uCap?"#E65100":"#90A4AE"}}>Custom</span></div>
              {uCap&&<input type="number" step="0.5" min="0.5" value={mCap} onChange={e=>setMCap(e.target.value)} placeholder={String(recSP||tot)} style={{width:50,padding:"3px 5px",borderRadius:5,border:"2px solid #FF9800",fontSize:13,fontFamily:"'Space Mono', monospace",fontWeight:800,textAlign:"center",outline:"none",color:"#E65100"}} />}
            </div>
            <p style={{margin:"5px 0 0",fontSize:10,color:"#78909C"}}>Click any story's SP badge to edit</p>
          </div>

          <div style={{backgroundColor:"#FFF",borderRadius:12,border:"1px solid #E0E0E0",padding:14,marginBottom:12}}>
            <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:10}}>
              <span style={{fontSize:16}}>{"\uD83D\uDD17"}</span><h3 style={{margin:0,fontSize:13,fontWeight:700,color:"#263238"}}>Push to Jira</h3>
              {jC?.displayName&&<span style={{marginLeft:"auto",padding:"2px 7px",borderRadius:12,backgroundColor:"#E8F5E9",color:"#2E7D32",fontSize:9,fontWeight:700}}>{"\uD83D\uDC64 "+jC.displayName}</span>}
              {okC>0&&<span style={{padding:"2px 7px",borderRadius:12,backgroundColor:"#E8F5E9",color:"#2E7D32",fontSize:9,fontWeight:700}}>{okC+"/"+stories.length}</span>}
            </div>
            {!jC?<div>
              <p style={{margin:"0 0 7px",fontSize:11,color:"#78909C"}}>Connect to load Parent/Sprint options and push stories.</p>
              <div style={{display:"flex",gap:7,marginBottom:8}}>
                <input type="text" value={pk} onChange={e=>setPk(e.target.value.toUpperCase())} placeholder="PROJECT KEY (e.g. BIADD)" style={{flex:1,padding:"8px 9px",borderRadius:7,border:"1.5px solid #CFD8DC",fontSize:12,fontFamily:"'Space Mono', monospace",fontWeight:700,outline:"none",boxSizing:"border-box",letterSpacing:1.5,textTransform:"uppercase"}} />
                <button onClick={connect} disabled={jL||!pk.trim()} style={{padding:"8px 14px",borderRadius:7,border:"none",background:jL||!pk.trim()?"#B0BEC5":"linear-gradient(135deg,#78909C,#546E7A)",color:"#FFF",fontSize:11,fontWeight:700,cursor:jL||!pk.trim()?"not-allowed":"pointer",flexShrink:0,display:"flex",alignItems:"center",gap:4}}>
                  {jL?<><span style={{width:11,height:11,border:"2px solid rgba(255,255,255,0.3)",borderTopColor:"#FFF",borderRadius:"50%",animation:"spin 0.8s linear infinite",display:"inline-block"}} />Connecting</>:"Connect"}
                </button>
              </div>
              <ConnLog logs={connLogs} />
              {jE&&<div style={{marginTop:8,padding:"7px 10px",backgroundColor:"#FFEBEE",borderRadius:6,fontSize:11,color:"#C62828"}}>{jE}</div>}
            </div>:<>
              <div style={{padding:"6px 9px",backgroundColor:"#E8F5E9",borderRadius:6,marginBottom:8,fontSize:10,color:"#2E7D32",display:"flex",alignItems:"center",gap:5}}>
                <span style={{width:6,height:6,borderRadius:"50%",backgroundColor:"#43A047"}} />
                {"Connected as "+jC.displayName+(jC.siteUrl?" \u00B7 "+jC.siteUrl.replace("https://",""):"")+(" \u00B7 "+epics.length+" epics \u00B7 "+sprints.length+" sprints")}
              </div>
              {allD?<div style={{textAlign:"center"}}>
                <div style={{padding:"12px 18px",backgroundColor:"#E8F5E9",borderRadius:9,marginBottom:8}}><span style={{fontSize:20}}>{"\uD83C\uDF89"}</span><p style={{margin:"5px 0 0",fontSize:13,fontWeight:700,color:"#2E7D32"}}>{"All "+stories.length+" stories pushed!"}</p></div>
                <button onClick={reset} style={{width:"100%",padding:"10px 18px",borderRadius:9,border:"none",background:"linear-gradient(135deg,#263238,#455A64)",color:"#FFF",fontSize:13,fontWeight:700,cursor:"pointer"}}>{"\u2190 Start New Sprint"}</button>
              </div>:<button onClick={push} disabled={pushing} style={{width:"100%",padding:"10px 14px",borderRadius:9,border:"none",background:pushing?"#B0BEC5":"linear-gradient(135deg,#1E88E5,#1565C0)",color:"#FFF",fontSize:12,fontWeight:700,cursor:pushing?"not-allowed":"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:5}}>
                {pushing?<><span style={{width:12,height:12,border:"2px solid rgba(255,255,255,0.3)",borderTopColor:"#FFF",borderRadius:"50%",animation:"spin 0.8s linear infinite",display:"inline-block"}} />{someF?"Retrying...":"Pushing..."}</>:someF?<>{"\uD83D\uDD04 Retry Failed"}</>:<>{"\uD83D\uDE80 Push All to Jira"}</>}
              </button>}
              {jLog.length>0&&!allD&&<div style={{marginTop:8,borderRadius:6,border:"1px solid #ECEFF1",overflow:"hidden"}}><div style={{maxHeight:110,overflowY:"auto"}}>{jLog.map((l,i)=><div key={i} style={{padding:"5px 10px",borderBottom:"1px solid #F5F5F5",display:"flex",alignItems:"center",gap:6,fontSize:10}}>
                <span style={{width:5,height:5,borderRadius:"50%",flexShrink:0,backgroundColor:l.status==="success"?"#43A047":l.status==="pushing"?"#FFB300":"#E53935"}} />
                <span style={{flex:1,fontWeight:500,color:"#37474F",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{l.title.length>40?l.title.slice(0,40)+"\u2026":l.title}</span>
                <span style={{fontSize:9,fontWeight:700,color:l.status==="success"?"#2E7D32":l.status==="pushing"?"#F57F17":"#C62828"}}>{l.status==="success"?"\u2713":l.status==="pushing"?"...":"\u2717"}</span>
              </div>)}</div></div>}
            </>}
          </div>

          <h2 style={{margin:"16px 0 8px",fontSize:15,fontWeight:800,color:"#263238"}}>{"Stories "}<span style={{fontSize:11,fontWeight:600,color:"#90A4AE"}}>{"("+stories.length+")"}</span></h2>
          <div style={{display:"flex",flexDirection:"column",gap:9}}>{stories.map((s,i)=><SC key={i} story={s} index={i} jS={jS[i]} onSP={uSP} task={val[i]} sprints={sprints} epics={epics} />)}</div>

          <div style={{marginTop:18,backgroundColor:"#FFF",borderRadius:11,border:"1px solid #E0E0E0",overflow:"hidden"}}>
            <div style={{padding:"10px 14px",backgroundColor:"#263238",color:"#FFF",fontSize:10,fontWeight:700,letterSpacing:0.8,textTransform:"uppercase"}}>Sprint Summary</div>
            <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
              <thead><tr style={{backgroundColor:"#FAFAFA"}}>{["#","Story","Priority","Parent","Sprint","SP","Jira"].map(h=><th key={h} style={{padding:"7px 8px",textAlign:"left",fontWeight:700,color:"#78909C",fontSize:9,textTransform:"uppercase",letterSpacing:0.7,borderBottom:"1px solid #ECEFF1"}}>{h}</th>)}</tr></thead>
              <tbody>{stories.map((s,i)=>{const t=val[i];return <tr key={i} style={{borderBottom:"1px solid #F0F0F0"}}>
                <td style={{padding:"6px 8px",fontFamily:"'Space Mono', monospace",fontWeight:700,color:"#90A4AE",fontSize:10}}>{i+1}</td>
                <td style={{padding:"6px 8px",fontWeight:600,color:"#37474F",maxWidth:140,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{s.title}</td>
                <td style={{padding:"6px 8px"}}><Pri p={t?.priority} /></td>
                <td style={{padding:"6px 8px",fontSize:10,color:"#5E35B1",fontWeight:600}}>{t?.parent||"\u2014"}</td>
                <td style={{padding:"6px 8px",fontSize:10,color:"#1565C0",fontWeight:600}}>{t?.sprint?(sprints.find(sp=>String(sp.id)===t.sprint)?.name||"").slice(0,15)||t.sprint:"\u2014"}</td>
                <td style={{padding:"6px 8px",fontFamily:"'Space Mono', monospace",fontWeight:700,fontSize:13}}>{s.story_points}</td>
                <td style={{padding:"6px 8px"}}>{jS[i]==="success"?<span style={{color:"#2E7D32",fontWeight:700}}>{"\u2713"}</span>:jS[i]==="error"?<span style={{color:"#C62828",fontWeight:700}}>{"\u2717"}</span>:jS[i]==="pushing"?<span style={{color:"#F57F17"}}>{"\u23F3"}</span>:<span style={{color:"#CFD8DC"}}>{"\u2014"}</span>}</td>
              </tr>})}
              <tr style={{backgroundColor:"#FAFAFA"}}><td colSpan={5} style={{padding:"8px 8px",fontWeight:800,color:"#263238",textAlign:"right"}}>Total</td><td style={{padding:"8px 8px",fontFamily:"'Space Mono', monospace",fontWeight:800,fontSize:15,color:tot>cap&&cap!==999?"#C62828":"#2E7D32"}}>{tot}</td><td /></tr>
              </tbody>
            </table>
          </div>
        </div>}
      </div>
    </div>
  );
}
