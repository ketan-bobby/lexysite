import { readFileSync, writeFileSync } from "node:fs";
import puppeteer from "puppeteer";
import MarkdownIt from "markdown-it";

const md = new MarkdownIt({ html: true, linkify: true, typographer: true });
const stripFrontMatter = (s) => s.replace(/^---[\s\S]*?---\s*/, "");

/* ── SVG GRAPHICS ─────────────────────────────────────────────────────── */

const PIPELINE_SVG = `
<svg viewBox="0 0 900 320" xmlns="http://www.w3.org/2000/svg" class="figure">
  <defs>
    <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0" stop-color="#020617"/><stop offset="1" stop-color="#0f172a"/>
    </linearGradient>
    <marker id="arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#06b6d4"/>
    </marker>
  </defs>
  <rect width="900" height="320" fill="url(#bg)" rx="12"/>

  <!-- Top row -->
  ${["ICP","Sourcing","Screening","Verify","Outreach"].map((label, i) => {
    const x = 40 + i * 170;
    const colors = ["#8b5cf6","#3b82f6","#06b6d4","#22c55e","#f97316"];
    return `
      <g transform="translate(${x},60)">
        <rect width="130" height="80" rx="14" fill="${colors[i]}" fill-opacity="0.15" stroke="${colors[i]}" stroke-width="1.5"/>
        <circle cx="20" cy="20" r="11" fill="#1e293b" stroke="${colors[i]}" stroke-width="1"/>
        <text x="20" y="24" text-anchor="middle" fill="${colors[i]}" font-size="11" font-weight="700" font-family="Inter,sans-serif">${i+1}</text>
        <text x="65" y="50" text-anchor="middle" fill="#e2e8f0" font-size="14" font-weight="600" font-family="Inter,sans-serif">${label}</text>
      </g>
    `;
  }).join("")}

  <!-- Top arrows -->
  ${[0,1,2,3].map(i => {
    const x = 40 + i * 170 + 130;
    return `<line x1="${x+2}" y1="100" x2="${x+38}" y2="100" stroke="#06b6d4" stroke-width="1.5" marker-end="url(#arr)" opacity="0.7"/>`;
  }).join("")}

  <!-- Down connector from Outreach to Schedule -->
  <path d="M 855 140 Q 875 140 875 175 L 875 195 Q 875 220 850 220" stroke="#06b6d4" stroke-width="1.5" fill="none" marker-end="url(#arr)" opacity="0.7"/>

  <!-- Bottom row reversed: Schedule, Interview, Proctoring, Anti-Ghost (right to left) -->
  ${[
    {label:"Schedule", color:"#6366f1", num:6},
    {label:"Interview", color:"#10b981", num:7},
    {label:"Proctoring", color:"#f43f5e", num:8},
    {label:"Anti-Ghost", color:"#eab308", num:9},
  ].map((s, i) => {
    const x = 720 - i * 170;
    return `
      <g transform="translate(${x},200)">
        <rect width="130" height="80" rx="14" fill="${s.color}" fill-opacity="0.15" stroke="${s.color}" stroke-width="1.5"/>
        <circle cx="20" cy="20" r="11" fill="#1e293b" stroke="${s.color}" stroke-width="1"/>
        <text x="20" y="24" text-anchor="middle" fill="${s.color}" font-size="11" font-weight="700" font-family="Inter,sans-serif">${s.num}</text>
        <text x="65" y="50" text-anchor="middle" fill="#e2e8f0" font-size="14" font-weight="600" font-family="Inter,sans-serif">${s.label}</text>
      </g>
    `;
  }).join("")}

  <!-- Bottom arrows (right to left) -->
  ${[0,1,2].map(i => {
    const x = 720 - i * 170;
    return `<line x1="${x-2}" y1="240" x2="${x-38}" y2="240" stroke="#06b6d4" stroke-width="1.5" marker-end="url(#arr)" opacity="0.7"/>`;
  }).join("")}

  <text x="450" y="305" text-anchor="middle" fill="#64748b" font-size="11" font-family="Inter,sans-serif">L3xy 9-Stage Autonomous Hiring Pipeline</text>
</svg>
`;

const SCORING_SVG = `
<svg viewBox="0 0 900 280" xmlns="http://www.w3.org/2000/svg" class="figure">
  <rect width="900" height="280" fill="#020617" rx="12"/>
  <text x="450" y="34" text-anchor="middle" fill="#e2e8f0" font-size="18" font-weight="700" font-family="Inter,sans-serif">Hire Probability — Composite Score Stack</text>
  <text x="450" y="56" text-anchor="middle" fill="#94a3b8" font-size="11" font-family="Inter,sans-serif">Bayesian posterior over four weighted composites, decay-adjusted per signal</text>

  ${[
    {label:"Fit",        pct:35, color:"#06b6d4", desc:"Skills 45% · Experience 30% · ICP 25%"},
    {label:"Quality",    pct:25, color:"#22c55e", desc:"Screening 40-60% · Interview 40% · Sourcing 20-40%"},
    {label:"Trust",      pct:20, color:"#f59e0b", desc:"Verification 50% · Proctoring 30% · Fraud 20%"},
    {label:"Conversion", pct:20, color:"#ec4899", desc:"Engagement 30% · Anti-ghost 30% · Scheduling 40%"},
  ].map((s, i) => {
    const y = 90 + i * 42;
    const w = s.pct * 14;
    return `
      <g>
        <text x="50" y="${y+18}" fill="#e2e8f0" font-size="13" font-weight="600" font-family="Inter,sans-serif">${s.label}</text>
        <rect x="140" y="${y}" width="${w}" height="26" rx="4" fill="${s.color}" fill-opacity="0.85"/>
        <text x="${145+w}" y="${y+18}" fill="${s.color}" font-size="13" font-weight="700" font-family="Inter,sans-serif">${s.pct}%</text>
        <text x="50" y="${y+34}" fill="#64748b" font-size="9" font-family="Inter,sans-serif">${s.desc}</text>
      </g>
    `;
  }).join("")}
</svg>
`;

const NBA_SVG = `
<svg viewBox="0 0 900 220" xmlns="http://www.w3.org/2000/svg" class="figure">
  <rect width="900" height="220" fill="#020617" rx="12"/>
  <text x="450" y="34" text-anchor="middle" fill="#e2e8f0" font-size="18" font-weight="700" font-family="Inter,sans-serif">Next Best Action — Decision Waterfall</text>

  ${[
    {label:"Verify",    color:"#f59e0b", cond:"Trust score below policy floor"},
    {label:"Re-engage", color:"#ec4899", cond:"Dropoff probability > ghosting alert"},
    {label:"Advance",   color:"#22c55e", cond:"Hire probability ≥ advance threshold"},
    {label:"Reject",    color:"#ef4444", cond:"Quality below floor & screening complete"},
    {label:"Schedule",  color:"#06b6d4", cond:"Default action — keep moving"},
  ].map((s, i) => {
    const x = 50 + i * 170;
    return `
      <g transform="translate(${x},80)">
        <rect width="160" height="60" rx="10" fill="${s.color}" fill-opacity="0.18" stroke="${s.color}" stroke-width="1.5"/>
        <text x="80" y="28" text-anchor="middle" fill="${s.color}" font-size="15" font-weight="700" font-family="Inter,sans-serif">${s.label}</text>
        <text x="80" y="46" text-anchor="middle" fill="#94a3b8" font-size="9" font-family="Inter,sans-serif">${s.cond}</text>
      </g>
    `;
  }).join("")}

  ${[0,1,2,3].map(i => {
    const x = 50 + i * 170 + 160;
    return `<line x1="${x+2}" y1="110" x2="${x+8}" y2="110" stroke="#475569" stroke-width="1.5"/>`;
  }).join("")}

  <text x="450" y="180" text-anchor="middle" fill="#64748b" font-size="11" font-family="Inter,sans-serif">First matching condition wins. Tenant policy defines all thresholds.</text>
  <text x="450" y="200" text-anchor="middle" fill="#475569" font-size="10" font-family="Inter,sans-serif">Every NBA records a snapshot of the policy that produced it — fully auditable.</text>
</svg>
`;

const ENGINE_SVG = `
<svg viewBox="0 0 900 280" xmlns="http://www.w3.org/2000/svg" class="figure">
  <rect width="900" height="280" fill="#020617" rx="12"/>
  <text x="450" y="34" text-anchor="middle" fill="#e2e8f0" font-size="18" font-weight="700" font-family="Inter,sans-serif">From Signals to Decision</text>

  <!-- Agents column -->
  ${["ICP","Sourcing","Screening","Verify","Outreach","Schedule","Interview","Proctoring","Anti-Ghost"].map((a,i)=>{
    const y = 70 + i * 22;
    return `
      <rect x="40" y="${y-12}" width="150" height="18" rx="4" fill="#0e7490" fill-opacity="0.25" stroke="#06b6d4" stroke-opacity="0.4"/>
      <text x="115" y="${y+1}" text-anchor="middle" fill="#cffafe" font-size="11" font-family="Inter,sans-serif">${a}</text>
    `;
  }).join("")}

  <!-- Engine box -->
  <rect x="380" y="80" width="220" height="130" rx="14" fill="#06b6d4" fill-opacity="0.18" stroke="#06b6d4" stroke-width="2"/>
  <text x="490" y="115" text-anchor="middle" fill="#06b6d4" font-size="16" font-weight="700" font-family="Inter,sans-serif">Intelligence</text>
  <text x="490" y="135" text-anchor="middle" fill="#06b6d4" font-size="16" font-weight="700" font-family="Inter,sans-serif">Engine</text>
  <text x="490" y="160" text-anchor="middle" fill="#94a3b8" font-size="10" font-family="Inter,sans-serif">Bayesian merge · decay</text>
  <text x="490" y="174" text-anchor="middle" fill="#94a3b8" font-size="10" font-family="Inter,sans-serif">policy gating · tenant β</text>
  <text x="490" y="192" text-anchor="middle" fill="#94a3b8" font-size="10" font-family="Inter,sans-serif">closed-loop learning</text>

  <!-- Output column -->
  ${[
    {l:"Hire Probability", c:"#22c55e"},
    {l:"Next Best Action", c:"#f59e0b"},
    {l:"Strengths & Risks", c:"#06b6d4"},
    {l:"Stage Forecasts", c:"#ec4899"},
    {l:"Decision Audit", c:"#a855f7"},
  ].map((o,i)=>{
    const y = 90 + i * 28;
    return `
      <rect x="700" y="${y-13}" width="170" height="22" rx="5" fill="${o.c}" fill-opacity="0.18" stroke="${o.c}" stroke-opacity="0.6"/>
      <text x="785" y="${y+2}" text-anchor="middle" fill="${o.c}" font-size="11" font-weight="600" font-family="Inter,sans-serif">${o.l}</text>
    `;
  }).join("")}

  <!-- Connecting lines -->
  ${[0,2,4,6,8].map(i=>`<line x1="195" y1="${70+i*22}" x2="378" y2="145" stroke="#06b6d4" stroke-width="0.6" opacity="0.4"/>`).join("")}
  ${[0,2,4].map(i=>`<line x1="602" y1="145" x2="698" y2="${90+i*28*2}" stroke="#06b6d4" stroke-width="0.6" opacity="0.4"/>`).join("")}

  <text x="115" y="50" text-anchor="middle" fill="#94a3b8" font-size="11" font-family="Inter,sans-serif" font-weight="600">9 Specialist Agents</text>
  <text x="785" y="50" text-anchor="middle" fill="#94a3b8" font-size="11" font-family="Inter,sans-serif" font-weight="600">Recruiter Surface</text>
</svg>
`;

const CANDIDATE_GRAPH_SVG = `
<svg viewBox="0 0 900 380" xmlns="http://www.w3.org/2000/svg" class="figure">
  <defs>
    <radialGradient id="core" cx="0.5" cy="0.5">
      <stop offset="0" stop-color="#06b6d4" stop-opacity="0.9"/>
      <stop offset="1" stop-color="#0e7490" stop-opacity="0.4"/>
    </radialGradient>
    <filter id="glow"><feGaussianBlur stdDeviation="6"/></filter>
  </defs>
  <rect width="900" height="380" fill="#020617" rx="12"/>
  <text x="450" y="32" text-anchor="middle" fill="#e2e8f0" font-size="18" font-weight="700" font-family="Inter,sans-serif">The Candidate is the Center</text>
  <text x="450" y="52" text-anchor="middle" fill="#94a3b8" font-size="11" font-family="Inter,sans-serif">A single living profile, continuously enriched by every agent and every interaction</text>

  <!-- Core candidate node -->
  <circle cx="450" cy="200" r="55" fill="url(#core)" filter="url(#glow)"/>
  <circle cx="450" cy="200" r="48" fill="#06b6d4" fill-opacity="0.25" stroke="#06b6d4" stroke-width="2"/>
  <text x="450" y="195" text-anchor="middle" fill="white" font-size="13" font-weight="700" font-family="Inter,sans-serif">CANDIDATE</text>
  <text x="450" y="212" text-anchor="middle" fill="#cffafe" font-size="9" font-family="Inter,sans-serif">live profile</text>

  <!-- Orbiting nodes -->
  ${[
    {x:200, y:120, label:"Sourcing signals", c:"#3b82f6"},
    {x:260, y:280, label:"Screening history", c:"#06b6d4"},
    {x:160, y:220, label:"ICP fit (per role)", c:"#8b5cf6"},
    {x:730, y:120, label:"Verify trust", c:"#22c55e"},
    {x:760, y:230, label:"Outreach replies", c:"#f97316"},
    {x:680, y:310, label:"Interview scores", c:"#10b981"},
    {x:380, y:75,  label:"Engagement timeline", c:"#ec4899"},
    {x:520, y:75,  label:"Connection strength", c:"#a855f7"},
    {x:380, y:330, label:"Conversation history", c:"#eab308"},
    {x:520, y:330, label:"Cross-role rankings", c:"#f43f5e"},
  ].map(n => `
    <line x1="${n.x}" y1="${n.y}" x2="450" y2="200" stroke="${n.c}" stroke-width="0.8" opacity="0.45"/>
    <circle cx="${n.x}" cy="${n.y}" r="6" fill="${n.c}" fill-opacity="0.3" stroke="${n.c}" stroke-width="1.5"/>
    <text x="${n.x}" y="${n.y - 12}" text-anchor="middle" fill="${n.c}" font-size="10" font-weight="600" font-family="Inter,sans-serif">${n.label}</text>
  `).join("")}

  <text x="450" y="365" text-anchor="middle" fill="#475569" font-size="10" font-family="Inter,sans-serif">Signals append. They never overwrite. The graph grows. The candidate stays warm — for every role, forever.</text>
</svg>
`;

const USERCOVER_SVG = `
<svg viewBox="0 0 800 240" xmlns="http://www.w3.org/2000/svg" class="cover-svg">
  <defs>
    <linearGradient id="ucg" x1="0" x2="1"><stop offset="0" stop-color="#06b6d4"/><stop offset="1" stop-color="#8b5cf6"/></linearGradient>
  </defs>
  <rect width="800" height="240" fill="#020617" rx="16"/>

  <!-- Recruiter avatar (center) -->
  <circle cx="400" cy="120" r="44" fill="#06b6d4" fill-opacity="0.18" stroke="#06b6d4" stroke-width="2"/>
  <circle cx="400" cy="105" r="14" fill="#06b6d4" fill-opacity="0.7"/>
  <path d="M 376 140 Q 400 122 424 140 L 424 152 Q 400 158 376 152 Z" fill="#06b6d4" fill-opacity="0.7"/>
  <text x="400" y="180" text-anchor="middle" fill="#cffafe" font-size="11" font-weight="700" font-family="Inter,sans-serif" letter-spacing="2">YOU</text>

  <!-- Agents around the recruiter -->
  ${["ICP","Source","Screen","Verify","Reach","Sched","Intvw","Proct","NoGhost"].map((label, i) => {
    const angle = (i / 9) * 2 * Math.PI - Math.PI / 2;
    const x = 400 + Math.cos(angle) * 150;
    const y = 120 + Math.sin(angle) * 80;
    const colors = ["#8b5cf6","#3b82f6","#06b6d4","#22c55e","#f97316","#6366f1","#10b981","#f43f5e","#eab308"];
    return `
      <line x1="400" y1="120" x2="${x}" y2="${y}" stroke="${colors[i]}" stroke-width="0.8" opacity="0.4"/>
      <circle cx="${x}" cy="${y}" r="16" fill="${colors[i]}" fill-opacity="0.18" stroke="${colors[i]}" stroke-width="1.5"/>
      <text x="${x}" y="${y+3}" text-anchor="middle" fill="${colors[i]}" font-size="8" font-weight="700" font-family="Inter,sans-serif">${label}</text>
    `;
  }).join("")}

  <text x="400" y="220" text-anchor="middle" fill="#64748b" font-size="11" font-family="Inter,sans-serif" letter-spacing="2">YOU LEAD · L3XY EXECUTES</text>
</svg>
`;

const DASHBOARD_SVG = `
<svg viewBox="0 0 900 440" xmlns="http://www.w3.org/2000/svg" class="figure">
  <rect width="900" height="440" fill="#020617" rx="12"/>
  <text x="450" y="28" text-anchor="middle" fill="#94a3b8" font-size="11" font-family="Inter,sans-serif">A look at the L3xy Recruiter Dashboard</text>

  <!-- Top nav -->
  <rect x="20" y="44" width="860" height="32" rx="6" fill="#0f172a" stroke="#1e293b"/>
  <text x="38" y="64" fill="#06b6d4" font-size="12" font-weight="700" font-family="Inter,sans-serif">L3XY</text>
  ${["Dashboard","Jobs","Candidates","Inbox","Interviews","Decisions"].map((t,i) => `
    <text x="${130 + i*92}" y="64" fill="${i===0?"#06b6d4":"#94a3b8"}" font-size="10" font-weight="${i===0?"700":"500"}" font-family="Inter,sans-serif">${t}</text>
  `).join("")}
  <circle cx="860" cy="60" r="9" fill="#06b6d4" fill-opacity="0.3" stroke="#06b6d4"/>

  <!-- KPI strip -->
  ${[
    {label:"Roles in Motion", val:"24", c:"#8b5cf6"},
    {label:"Total Candidates", val:"1,847", c:"#06b6d4"},
    {label:"AI Interviews", val:"312", c:"#22c55e"},
    {label:"Offers & Hires", val:"18", c:"#f97316"},
  ].map((k,i) => `
    <g transform="translate(${20 + i*215},92)">
      <rect width="200" height="74" rx="8" fill="#0f172a" stroke="${k.c}" stroke-opacity="0.4"/>
      <text x="14" y="22" fill="#64748b" font-size="9" font-family="Inter,sans-serif" text-transform="uppercase" letter-spacing="1">${k.label}</text>
      <text x="14" y="56" fill="${k.c}" font-size="26" font-weight="800" font-family="Inter,sans-serif">${k.val}</text>
      <text x="180" y="56" text-anchor="end" fill="#22c55e" font-size="10" font-family="Inter,sans-serif">↑ 12%</text>
    </g>
  `).join("")}

  <!-- Pipeline funnel -->
  <g transform="translate(20,182)">
    <rect width="555" height="160" rx="8" fill="#0f172a" stroke="#1e293b"/>
    <text x="16" y="22" fill="#e2e8f0" font-size="12" font-weight="700" font-family="Inter,sans-serif">AI Pipeline Funnel</text>
    ${[
      {label:"Sourced",     val:847, c:"#3b82f6"},
      {label:"Screened",    val:412, c:"#06b6d4"},
      {label:"Verified",    val:287, c:"#22c55e"},
      {label:"Outreached",  val:264, c:"#f97316"},
      {label:"Scheduled",   val:142, c:"#6366f1"},
      {label:"Interviewed", val:88,  c:"#10b981"},
    ].map((s,i) => {
      const w = (s.val/847) * 380;
      const y = 42 + i*18;
      return `
        <text x="16" y="${y+12}" fill="#94a3b8" font-size="9" font-family="Inter,sans-serif">${s.label}</text>
        <rect x="100" y="${y+2}" width="${w}" height="13" rx="3" fill="${s.c}" fill-opacity="0.7"/>
        <text x="${108+w}" y="${y+12}" fill="${s.c}" font-size="9" font-weight="700" font-family="Inter,sans-serif">${s.val}</text>
      `;
    }).join("")}
  </g>

  <!-- Recommended Actions -->
  <g transform="translate(595,182)">
    <rect width="285" height="160" rx="8" fill="#0f172a" stroke="#06b6d4" stroke-opacity="0.4"/>
    <text x="14" y="22" fill="#06b6d4" font-size="12" font-weight="700" font-family="Inter,sans-serif">Recommended Actions</text>
    ${[
      {a:"Review", t:"5 hire-ready for Staff PM"},
      {a:"Approve", t:"3 outreach drafts pending"},
      {a:"Re-engage", t:"7 at risk of ghosting"},
      {a:"Verify", t:"2 trust flags need eyes"},
    ].map((r,i) => `
      <g transform="translate(14,${36 + i*28})">
        <rect width="60" height="20" rx="4" fill="#06b6d4" fill-opacity="0.2" stroke="#06b6d4" stroke-opacity="0.6"/>
        <text x="30" y="14" text-anchor="middle" fill="#06b6d4" font-size="9" font-weight="700" font-family="Inter,sans-serif">${r.a}</text>
        <text x="72" y="14" fill="#cbd5e1" font-size="9.5" font-family="Inter,sans-serif">${r.t}</text>
      </g>
    `).join("")}
  </g>

  <!-- Hire-ready candidates -->
  <g transform="translate(20,358)">
    <rect width="860" height="68" rx="8" fill="#0f172a" stroke="#1e293b"/>
    <text x="16" y="20" fill="#e2e8f0" font-size="12" font-weight="700" font-family="Inter,sans-serif">Hire-Ready Candidates</text>
    ${[
      {n:"Sarah K.", r:"Staff Eng", p:94, c:"#22c55e"},
      {n:"Marcus T.", r:"Sr PM", p:89, c:"#22c55e"},
      {n:"Priya R.", r:"Director", p:87, c:"#22c55e"},
      {n:"Devon L.", r:"Designer", p:82, c:"#06b6d4"},
      {n:"Aiko M.", r:"Sr Eng", p:79, c:"#06b6d4"},
    ].map((cand,i) => `
      <g transform="translate(${16 + i*168},32)">
        <circle cx="12" cy="14" r="10" fill="${cand.c}" fill-opacity="0.25" stroke="${cand.c}"/>
        <text x="28" y="12" fill="#e2e8f0" font-size="10" font-weight="600" font-family="Inter,sans-serif">${cand.n}</text>
        <text x="28" y="24" fill="#64748b" font-size="9" font-family="Inter,sans-serif">${cand.r}</text>
        <text x="148" y="20" text-anchor="end" fill="${cand.c}" font-size="14" font-weight="700" font-family="Inter,sans-serif">${cand.p}%</text>
      </g>
    `).join("")}
  </g>
</svg>
`;

const CARD_SVG = `
<svg viewBox="0 0 900 480" xmlns="http://www.w3.org/2000/svg" class="figure">
  <rect width="900" height="480" fill="#020617" rx="12"/>
  <text x="450" y="26" text-anchor="middle" fill="#94a3b8" font-size="11" font-family="Inter,sans-serif">Anatomy of a Candidate Card</text>

  <!-- Header card -->
  <rect x="20" y="42" width="860" height="120" rx="10" fill="#0f172a" stroke="#1e293b"/>

  <!-- Avatar -->
  <circle cx="80" cy="102" r="34" fill="#06b6d4" fill-opacity="0.2" stroke="#06b6d4" stroke-width="2"/>
  <circle cx="80" cy="92" r="11" fill="#06b6d4" fill-opacity="0.7"/>
  <path d="M 60 122 Q 80 108 100 122 L 100 130 Q 80 134 60 130 Z" fill="#06b6d4" fill-opacity="0.7"/>

  <!-- Name + meta -->
  <text x="135" y="78" fill="#e2e8f0" font-size="18" font-weight="700" font-family="Inter,sans-serif">Sarah Kowalski</text>
  <text x="135" y="98" fill="#94a3b8" font-size="11" font-family="Inter,sans-serif">Staff Engineer · Distributed Systems · Berlin, DE</text>
  <rect x="135" y="108" width="68" height="18" rx="4" fill="#22c55e" fill-opacity="0.18" stroke="#22c55e" stroke-opacity="0.6"/>
  <text x="169" y="121" text-anchor="middle" fill="#22c55e" font-size="9" font-weight="700" font-family="Inter,sans-serif">VERIFIED</text>
  <rect x="210" y="108" width="78" height="18" rx="4" fill="#f59e0b" fill-opacity="0.18" stroke="#f59e0b" stroke-opacity="0.6"/>
  <text x="249" y="121" text-anchor="middle" fill="#f59e0b" font-size="9" font-weight="700" font-family="Inter,sans-serif">NBA: ADVANCE</text>

  <!-- Hire probability gauge -->
  <g transform="translate(620,62)">
    <rect width="240" height="86" rx="8" fill="#020617" stroke="#22c55e" stroke-opacity="0.5"/>
    <text x="14" y="20" fill="#64748b" font-size="9" font-family="Inter,sans-serif" letter-spacing="1">HIRE PROBABILITY</text>
    <text x="14" y="58" fill="#22c55e" font-size="32" font-weight="800" font-family="Inter,sans-serif">94%</text>
    <text x="100" y="58" fill="#94a3b8" font-size="10" font-family="Inter,sans-serif">Fit 96 · Quality 92</text>
    <text x="100" y="72" fill="#94a3b8" font-size="10" font-family="Inter,sans-serif">Trust 95 · Conv 91</text>
  </g>

  <!-- Action buttons -->
  <g transform="translate(135,138)">
    ${["Push to Client","Advance","Reject","Send Message"].map((b,i) => `
      <rect x="${i*112}" y="0" width="100" height="20" rx="4" fill="${i===1?"#22c55e":i===2?"#ef4444":"#06b6d4"}" fill-opacity="0.18" stroke="${i===1?"#22c55e":i===2?"#ef4444":"#06b6d4"}" stroke-opacity="0.6"/>
      <text x="${i*112 + 50}" y="13" text-anchor="middle" fill="${i===1?"#22c55e":i===2?"#ef4444":"#06b6d4"}" font-size="9" font-weight="700" font-family="Inter,sans-serif">${b}</text>
    `).join("")}
  </g>

  <!-- Lexy Prediction box -->
  <rect x="20" y="178" width="860" height="62" rx="8" fill="#06b6d4" fill-opacity="0.06" stroke="#06b6d4" stroke-opacity="0.4"/>
  <text x="36" y="200" fill="#06b6d4" font-size="10" font-weight="700" font-family="Inter,sans-serif" letter-spacing="1">LEXY PREDICTION</text>
  <text x="36" y="220" fill="#cbd5e1" font-size="11" font-family="Inter,sans-serif">Sarah is a strong fit for Staff Engineer. Skills align across distributed systems and Go.</text>
  <text x="36" y="234" fill="#cbd5e1" font-size="11" font-family="Inter,sans-serif">Trust verified. She's responsive (avg reply 4h) and likely to advance through interview.</text>

  <!-- Tabs -->
  <g transform="translate(20,256)">
    ${["Intelligence","Timeline","Interviews","Resume","Verification"].map((t,i) => `
      <rect x="${i*150}" y="0" width="140" height="24" rx="4" fill="${i===0?"#06b6d4":"#0f172a"}" fill-opacity="${i===0?"0.25":"1"}" stroke="${i===0?"#06b6d4":"#1e293b"}"/>
      <text x="${i*150+70}" y="16" text-anchor="middle" fill="${i===0?"#06b6d4":"#94a3b8"}" font-size="10" font-weight="${i===0?"700":"500"}" font-family="Inter,sans-serif">${t}</text>
    `).join("")}
  </g>

  <!-- Intelligence content -->
  <rect x="20" y="288" width="860" height="178" rx="8" fill="#0f172a" stroke="#1e293b"/>
  <text x="36" y="310" fill="#e2e8f0" font-size="12" font-weight="700" font-family="Inter,sans-serif">Score Breakdown</text>

  ${[
    {label:"Skills",     pct:96, c:"#06b6d4", note:"Go, Rust, Kubernetes, gRPC, Postgres"},
    {label:"Experience", pct:92, c:"#22c55e", note:"8 yrs · 2 staff roles · ex-Datadog"},
    {label:"ICP Fit",    pct:94, c:"#8b5cf6", note:"Domain match · seniority match · location ok"},
    {label:"Engagement", pct:88, c:"#f97316", note:"Replied 2/2 · avg 4h response"},
    {label:"Trust",      pct:95, c:"#10b981", note:"ID verified · employment confirmed · no flags"},
    {label:"Quality",    pct:91, c:"#ec4899", note:"Screening 94% · Interview pending"},
  ].map((d,i) => {
    const y = 326 + i*22;
    return `
      <text x="36" y="${y+12}" fill="#cbd5e1" font-size="10" font-weight="600" font-family="Inter,sans-serif">${d.label}</text>
      <rect x="120" y="${y}" width="${d.pct*2.4}" height="14" rx="3" fill="${d.c}" fill-opacity="0.7"/>
      <text x="${126+d.pct*2.4}" y="${y+11}" fill="${d.c}" font-size="10" font-weight="700" font-family="Inter,sans-serif">${d.pct}</text>
      <text x="400" y="${y+11}" fill="#64748b" font-size="9" font-family="Inter,sans-serif">${d.note}</text>
    `;
  }).join("")}
</svg>
`;

const PARTNERS_SVG = `
<svg viewBox="0 0 900 460" xmlns="http://www.w3.org/2000/svg" class="figure">
  <defs>
    <radialGradient id="centerpulse" cx="0.5" cy="0.5">
      <stop offset="0" stop-color="#06b6d4" stop-opacity="0.55"/>
      <stop offset="1" stop-color="#06b6d4" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="flowL" x1="0" x2="1" y1="0" y2="0">
      <stop offset="0" stop-color="#06b6d4" stop-opacity="0.1"/>
      <stop offset="1" stop-color="#06b6d4" stop-opacity="0.6"/>
    </linearGradient>
    <linearGradient id="flowR" x1="1" x2="0" y1="0" y2="0">
      <stop offset="0" stop-color="#22c55e" stop-opacity="0.1"/>
      <stop offset="1" stop-color="#22c55e" stop-opacity="0.6"/>
    </linearGradient>
  </defs>
  <rect width="900" height="460" fill="#020617" rx="12"/>
  <text x="450" y="28" text-anchor="middle" fill="#e2e8f0" font-size="16" font-weight="700" font-family="Inter,sans-serif">L3xy Partner Network — Channel Economics</text>
  <text x="450" y="48" text-anchor="middle" fill="#94a3b8" font-size="11" font-family="Inter,sans-serif">Partners bring distribution + pool depth → L3xy shares 20-40% of attributed revenue</text>

  <!-- Center: L3xy -->
  <circle cx="450" cy="240" r="115" fill="url(#centerpulse)"/>
  <circle cx="450" cy="240" r="78" fill="#06b6d4" fill-opacity="0.22" stroke="#06b6d4" stroke-width="2"/>
  <text x="450" y="232" text-anchor="middle" fill="white" font-size="15" font-weight="800" font-family="Inter,sans-serif">L3XY</text>
  <text x="450" y="252" text-anchor="middle" fill="white" font-size="10" font-family="Inter,sans-serif">platform + pool</text>
  <text x="450" y="270" text-anchor="middle" fill="#67e8f9" font-size="9" font-family="Inter,sans-serif">attribution engine</text>

  ${(() => {
    // LEFT SIDE: partner channels feeding customers in
    const left = [
      {x:140, y:90,  label:"Staffing agency / RPO",       share:"30-40%", c:"#a855f7"},
      {x:120, y:160, label:"Regional reseller",            share:"30-40%", c:"#ec4899"},
      {x:120, y:230, label:"ATS marketplace",              share:"15-25%", c:"#22c55e"},
      {x:120, y:300, label:"HRIS embedded",                share:"20-30%", c:"#10b981"},
      {x:140, y:370, label:"Job board partner",            share:"20-30%", c:"#f59e0b"},
    ];
    // RIGHT SIDE: outcomes
    const right = [
      {x:760, y:110, label:"+ Customers", detail:"distribution into markets", c:"#06b6d4"},
      {x:780, y:200, label:"+ Pool depth", detail:"each partner seeds candidates", c:"#0ea5e9"},
      {x:780, y:290, label:"~ Net margin", detail:"~91% T1 / ~54% India", c:"#22c55e"},
      {x:760, y:380, label:"− CAC borne by partner", detail:"channel CAC ≈ 0", c:"#facc15"},
    ];
    let svg = "";
    left.forEach(p => {
      svg += `
        <path d="M ${p.x+95} ${p.y+15} Q 280 ${p.y+15} 372 240" stroke="url(#flowL)" stroke-width="2" fill="none"/>
        <rect x="${p.x-8}" y="${p.y-2}" width="190" height="34" rx="7" fill="${p.c}" fill-opacity="0.16" stroke="${p.c}" stroke-width="1.2"/>
        <text x="${p.x+5}" y="${p.y+15}" fill="${p.c}" font-size="10" font-weight="700" font-family="Inter,sans-serif">${p.label}</text>
        <text x="${p.x+5}" y="${p.y+27}" fill="${p.c}" font-size="9" font-family="Inter,sans-serif" opacity="0.85">share: ${p.share}</text>
      `;
    });
    right.forEach(o => {
      svg += `
        <path d="M 528 240 Q 640 ${o.y+12} ${o.x-100} ${o.y+12}" stroke="url(#flowR)" stroke-width="2" fill="none"/>
        <rect x="${o.x-100}" y="${o.y-2}" width="200" height="34" rx="7" fill="${o.c}" fill-opacity="0.14" stroke="${o.c}" stroke-width="1.2"/>
        <text x="${o.x-92}" y="${o.y+15}" fill="${o.c}" font-size="10" font-weight="700" font-family="Inter,sans-serif">${o.label}</text>
        <text x="${o.x-92}" y="${o.y+27}" fill="${o.c}" font-size="9" font-family="Inter,sans-serif" opacity="0.85">${o.detail}</text>
      `;
    });
    return svg;
  })()}

  <!-- Tier ribbon along bottom -->
  <text x="36" y="440" fill="#94a3b8" font-size="9" font-weight="700" font-family="Inter,sans-serif">TIERS:</text>
  <rect x="86" y="428" width="120" height="20" rx="10" fill="#94a3b8" fill-opacity="0.15" stroke="#cbd5e1" stroke-width="1"/>
  <text x="146" y="442" text-anchor="middle" fill="#cbd5e1" font-size="9" font-family="Inter,sans-serif">Silver — 20% / $0-50K</text>
  <rect x="216" y="428" width="120" height="20" rx="10" fill="#facc15" fill-opacity="0.18" stroke="#facc15" stroke-width="1"/>
  <text x="276" y="442" text-anchor="middle" fill="#facc15" font-size="9" font-family="Inter,sans-serif">Gold — 25% / $50-250K</text>
  <rect x="346" y="428" width="140" height="20" rx="10" fill="#06b6d4" fill-opacity="0.22" stroke="#06b6d4" stroke-width="1"/>
  <text x="416" y="442" text-anchor="middle" fill="#67e8f9" font-size="9" font-family="Inter,sans-serif">Platinum — 30% / $250K+</text>
  <rect x="496" y="428" width="160" height="20" rx="10" fill="#a855f7" fill-opacity="0.22" stroke="#a855f7" stroke-width="1"/>
  <text x="576" y="442" text-anchor="middle" fill="#c084fc" font-size="9" font-family="Inter,sans-serif">Anchor — up to 40%, exclusive</text>
</svg>
`;

const ATTRIBUTION_SVG = `
<svg viewBox="0 0 900 460" xmlns="http://www.w3.org/2000/svg" class="figure">
  <defs>
    <radialGradient id="hirepulse" cx="0.5" cy="0.5">
      <stop offset="0" stop-color="#f59e0b" stop-opacity="0.6"/>
      <stop offset="1" stop-color="#f59e0b" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="900" height="460" fill="#020617" rx="12"/>
  <text x="450" y="28" text-anchor="middle" fill="#e2e8f0" font-size="16" font-weight="700" font-family="Inter,sans-serif">Multi-Signal Hire Attribution</text>
  <text x="450" y="48" text-anchor="middle" fill="#94a3b8" font-size="11" font-family="Inter,sans-serif">No single signal is ground truth — confidence is triangulated from many independent sources</text>

  <!-- Center: hire confirmation -->
  <circle cx="450" cy="240" r="105" fill="url(#hirepulse)"/>
  <circle cx="450" cy="240" r="70" fill="#f59e0b" fill-opacity="0.18" stroke="#f59e0b" stroke-width="2"/>
  <text x="450" y="232" text-anchor="middle" fill="white" font-size="13" font-weight="800" font-family="Inter,sans-serif">HIRE</text>
  <text x="450" y="250" text-anchor="middle" fill="white" font-size="13" font-weight="800" font-family="Inter,sans-serif">CONFIRMED</text>
  <text x="450" y="268" text-anchor="middle" fill="#fbbf24" font-size="9" font-family="Inter,sans-serif">score ≥ 80 → auto-bill</text>

  ${(() => {
    const sigs = [
      // Customer-controllable (low trust, top-left zone)
      {x:130, y:90,  label:"Mark Hired (UI)",          w:30, c:"#64748b", trust:"low"},
      {x:130, y:150, label:"Pipeline → hired",          w:20, c:"#64748b", trust:"low"},
      {x:130, y:210, label:"Offer letter upload",       w:15, c:"#94a3b8", trust:"med"},
      {x:130, y:270, label:"Reference checks sent",     w:15, c:"#94a3b8", trust:"med"},

      // External / hard to fake (right zone)
      {x:770, y:90,  label:"E-signature webhook",       w:40, c:"#22c55e", trust:"high"},
      {x:770, y:150, label:"ATS hire webhook",          w:45, c:"#22c55e", trust:"high"},
      {x:770, y:210, label:"Background check fired",    w:25, c:"#22c55e", trust:"high"},
      {x:770, y:270, label:"Payroll/HRIS webhook",      w:50, c:"#10b981", trust:"gold"},

      // Independent signals (bottom zone)
      {x:200, y:380, label:"Candidate confirms",         w:30, c:"#0ea5e9", trust:"med"},
      {x:380, y:410, label:"Email phrase detection",     w:20, c:"#0ea5e9", trust:"med"},
      {x:540, y:410, label:"LinkedIn drift",             w:50, c:"#a855f7", trust:"killer"},
      {x:720, y:380, label:"Public hire announcement",   w:25, c:"#a855f7", trust:"high"},
    ];
    return sigs.map(s => {
      return `
        <line x1="${s.x}" y1="${s.y}" x2="450" y2="240" stroke="${s.c}" stroke-width="${0.4 + s.w/40}" opacity="0.45"/>
        <rect x="${s.x-72}" y="${s.y-15}" width="144" height="30" rx="6" fill="${s.c}" fill-opacity="0.15" stroke="${s.c}" stroke-width="1.2"/>
        <text x="${s.x}" y="${s.y-1}" text-anchor="middle" fill="${s.c}" font-size="10" font-weight="700" font-family="Inter,sans-serif">${s.label}</text>
        <text x="${s.x}" y="${s.y+11}" text-anchor="middle" fill="${s.c}" font-size="9" font-family="Inter,sans-serif" opacity="0.85">+${s.w} weight</text>
      `;
    }).join("");
  })()}

  <!-- Legend -->
  <text x="36" y="60" fill="#64748b" font-size="9" font-family="Inter,sans-serif" font-weight="700">CUSTOMER-CONTROLLABLE</text>
  <text x="864" y="60" text-anchor="end" fill="#22c55e" font-size="9" font-family="Inter,sans-serif" font-weight="700">EXTERNAL / HARD TO FAKE</text>
  <text x="450" y="450" text-anchor="middle" fill="#a855f7" font-size="10" font-style="italic" font-family="Inter,sans-serif">LinkedIn drift is the killer signal — detects off-platform hires within an 18-month attribution window</text>
</svg>
`;

const REGIONS_SVG = `
<svg viewBox="0 0 900 460" xmlns="http://www.w3.org/2000/svg" class="figure">
  <rect width="900" height="460" fill="#020617" rx="12"/>
  <text x="450" y="28" text-anchor="middle" fill="#e2e8f0" font-size="16" font-weight="700" font-family="Inter,sans-serif">Customer Cost-Per-Hire vs. L3xy Cost — by Region</text>
  <text x="450" y="48" text-anchor="middle" fill="#94a3b8" font-size="10" font-family="Inter,sans-serif">Our cost is roughly flat globally; customer willingness-to-pay swings 20×</text>

  <!-- L3xy cost reference line -->
  <line x1="320" y1="70" x2="320" y2="430" stroke="#22c55e" stroke-width="1.5" stroke-dasharray="4 3"/>
  <text x="324" y="76" fill="#22c55e" font-size="9" font-weight="700" font-family="Inter,sans-serif">L3xy ~$50/hire</text>

  ${(() => {
    const regions = [
      {label:"Japan / Korea (agency)",       lo: 3300, hi:10000, c:"#a855f7"},
      {label:"US / Canada (agency, tech)",   lo: 4700, hi:25000, c:"#06b6d4"},
      {label:"GCC (UAE/Saudi)",              lo: 4000, hi: 8000, c:"#facc15"},
      {label:"Australia / NZ",               lo: 3300, hi: 5300, c:"#10b981"},
      {label:"Western Europe (DE/FR)",       lo: 3000, hi: 4500, c:"#0ea5e9"},
      {label:"UK",                           lo: 4400, hi: 6300, c:"#3b82f6"},
      {label:"Singapore / HK",               lo: 2200, hi: 3700, c:"#14b8a6"},
      {label:"LATAM (BR/MX)",                lo:  800, hi: 3000, c:"#f59e0b"},
      {label:"India (tech roles)",           lo: 2400, hi: 6000, c:"#ef4444"},
      {label:"India (commodity roles)",      lo:  600, hi: 1800, c:"#ef4444"},
      {label:"SE Asia (PH/VN/ID)",           lo:  500, hi: 1500, c:"#f97316"},
      {label:"Africa (NG/KE/ZA)",            lo:  400, hi: 1500, c:"#ec4899"},
      {label:"Pakistan / Bangladesh / SL",   lo:  300, hi: 1000, c:"#fb7185"},
    ];
    const max = 25000;
    const xScale = v => 320 + (Math.log10(v+1) / Math.log10(max+1)) * 540;
    return regions.map((r, i) => {
      const y = 92 + i * 26;
      const x1 = xScale(r.lo);
      const x2 = xScale(r.hi);
      return `
        <text x="312" y="${y+12}" text-anchor="end" fill="#cbd5e1" font-size="10" font-family="Inter,sans-serif">${r.label}</text>
        <line x1="${x1}" y1="${y+8}" x2="${x2}" y2="${y+8}" stroke="${r.c}" stroke-width="6" stroke-linecap="round" opacity="0.9"/>
        <circle cx="${x1}" cy="${y+8}" r="4" fill="${r.c}"/>
        <circle cx="${x2}" cy="${y+8}" r="4" fill="${r.c}"/>
        <text x="${x1-6}" y="${y+11}" text-anchor="end" fill="${r.c}" font-size="9" font-family="Inter,sans-serif">$${r.lo.toLocaleString()}</text>
        <text x="${x2+6}" y="${y+11}" fill="${r.c}" font-size="9" font-weight="700" font-family="Inter,sans-serif">$${r.hi.toLocaleString()}</text>
      `;
    }).join("");
  })()}

  <!-- X axis -->
  <line x1="320" y1="438" x2="860" y2="438" stroke="#334155"/>
  ${[100,1000,5000,25000].map(v => {
    const x = 320 + (Math.log10(v+1) / Math.log10(25001)) * 540;
    return `<text x="${x}" y="452" text-anchor="middle" fill="#64748b" font-size="9" font-family="Inter,sans-serif">$${v.toLocaleString()}</text>`;
  }).join("")}
</svg>
`;

const LIVING_SVG = `
<svg viewBox="0 0 900 410" xmlns="http://www.w3.org/2000/svg" class="figure">
  <defs>
    <radialGradient id="pulse" cx="0.5" cy="0.5">
      <stop offset="0" stop-color="#06b6d4" stop-opacity="0.5"/>
      <stop offset="1" stop-color="#06b6d4" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="900" height="410" fill="#020617" rx="12"/>
  <text x="450" y="28" text-anchor="middle" fill="#e2e8f0" font-size="16" font-weight="700" font-family="Inter,sans-serif">The Always-On Pool</text>
  <text x="450" y="48" text-anchor="middle" fill="#94a3b8" font-size="11" font-family="Inter,sans-serif">Six background workers run continuously — even when the recruiter sleeps</text>

  <!-- Center pool -->
  <circle cx="450" cy="200" r="100" fill="url(#pulse)"/>
  <circle cx="450" cy="200" r="62" fill="#06b6d4" fill-opacity="0.18" stroke="#06b6d4" stroke-width="2"/>
  <text x="450" y="195" text-anchor="middle" fill="white" font-size="13" font-weight="700" font-family="Inter,sans-serif">TALENT</text>
  <text x="450" y="212" text-anchor="middle" fill="white" font-size="13" font-weight="700" font-family="Inter,sans-serif">POOL</text>

  <!-- Schedulers around the pool -->
  ${[
    {x:160, y:100, label:"Outreach Autopilot",     cad:"every 15 min",   c:"#f97316", desc:"Advances campaign sequences"},
    {x:740, y:100, label:"Ghosting Detectors",     cad:"every 30 min",   c:"#ef4444", desc:"4 detectors scan continuously"},
    {x:110, y:240, label:"Nurture Cycle",          cad:"every 6 hours",  c:"#ec4899", desc:"AI re-engagement emails"},
    {x:790, y:240, label:"Pool Revival",           cad:"every 24 hours", c:"#22c55e", desc:"Wakes Passive 30-89d / Inactive 90+d"},
    {x:280, y:345, label:"Cross-Role Re-Scan",     cad:"every 24 hours", c:"#8b5cf6", desc:"Every candidate × every open role"},
    {x:620, y:345, label:"LinkedIn Drift Monitor", cad:"every 24 hours", c:"#0ea5e9", desc:"Detects job changes after 180d quiet"},
  ].map(s => `
    <line x1="${s.x}" y1="${s.y}" x2="450" y2="200" stroke="${s.c}" stroke-width="0.8" opacity="0.4" stroke-dasharray="3 3"/>
    <rect x="${s.x-90}" y="${s.y-26}" width="180" height="52" rx="8" fill="${s.c}" fill-opacity="0.12" stroke="${s.c}" stroke-width="1.5"/>
    <text x="${s.x}" y="${s.y-9}" text-anchor="middle" fill="${s.c}" font-size="11" font-weight="700" font-family="Inter,sans-serif">${s.label}</text>
    <text x="${s.x}" y="${s.y+5}" text-anchor="middle" fill="${s.c}" font-size="9" font-family="Inter,sans-serif" opacity="0.85">${s.cad}</text>
    <text x="${s.x}" y="${s.y+18}" text-anchor="middle" fill="#94a3b8" font-size="8" font-family="Inter,sans-serif">${s.desc}</text>
  `).join("")}
</svg>
`;

const ECONCOVER_SVG = `
<svg viewBox="0 0 800 240" xmlns="http://www.w3.org/2000/svg" class="cover-svg">
  <defs>
    <linearGradient id="ecg" x1="0" x2="0" y1="1" y2="0">
      <stop offset="0" stop-color="#22c55e" stop-opacity="0.1"/>
      <stop offset="1" stop-color="#22c55e" stop-opacity="0.7"/>
    </linearGradient>
  </defs>
  <rect width="800" height="240" fill="#020617" rx="16"/>
  <text x="400" y="32" text-anchor="middle" fill="#94a3b8" font-size="11" font-family="Inter,sans-serif" letter-spacing="2">COST PER HIRE — TRAJECTORY</text>

  <!-- Y axis baseline -->
  <line x1="80" y1="200" x2="720" y2="200" stroke="#1e293b" stroke-width="1"/>
  <line x1="80" y1="60" x2="80" y2="200" stroke="#1e293b" stroke-width="1"/>

  <!-- Bars -->
  ${[
    {label:"Month 1", val:85, x:140},
    {label:"Month 6", val:57, x:280},
    {label:"Month 12", val:47, x:420},
    {label:"Month 24", val:42, x:560},
  ].map(b => {
    const h = (b.val / 100) * 130;
    return `
      <rect x="${b.x-30}" y="${200-h}" width="60" height="${h}" rx="4" fill="url(#ecg)" stroke="#22c55e" stroke-width="1.5"/>
      <text x="${b.x}" y="${195-h}" text-anchor="middle" fill="#22c55e" font-size="13" font-weight="800" font-family="Inter,sans-serif">$${b.val}</text>
      <text x="${b.x}" y="218" text-anchor="middle" fill="#94a3b8" font-size="10" font-family="Inter,sans-serif">${b.label}</text>
    `;
  }).join("")}

  <!-- Market reference line -->
  <text x="50" y="80" fill="#ef4444" font-size="9" font-family="Inter,sans-serif">$4,700</text>
  <text x="50" y="92" fill="#64748b" font-size="8" font-family="Inter,sans-serif">in-house avg</text>
</svg>
`;

const FUNNEL_SVG = `
<svg viewBox="0 0 900 360" xmlns="http://www.w3.org/2000/svg" class="figure">
  <rect width="900" height="360" fill="#020617" rx="12"/>
  <text x="450" y="28" text-anchor="middle" fill="#e2e8f0" font-size="16" font-weight="700" font-family="Inter,sans-serif">Per-Hire Cost Waterfall</text>
  <text x="450" y="48" text-anchor="middle" fill="#94a3b8" font-size="10" font-family="Inter,sans-serif">Cold-start tenant — every candidate sourced via paid Tier-3 APIs (worst case)</text>

  ${[
    {label:"Sourced (Tier 3)",  count:200, cost:48.00, c:"#f59e0b"},
    {label:"Screened",          count:100, cost: 5.00, c:"#06b6d4"},
    {label:"Verified",          count: 50, cost: 1.00, c:"#22c55e"},
    {label:"Outreached",        count: 40, cost: 1.72, c:"#f97316"},
    {label:"Scheduled",         count:  8, cost: 0.08, c:"#6366f1"},
    {label:"Interviewed",       count:  6, cost:25.68, c:"#10b981"},
    {label:"Anti-ghost ops",    count: 40, cost: 0.80, c:"#eab308"},
    {label:"Comms + infra",     count: "—",cost: 3.00, c:"#a855f7"},
    {label:"ICP setup",         count: "1 job", cost: 0.05, c:"#8b5cf6"},
  ].map((s, i) => {
    const y = 80 + i * 28;
    const w = (s.cost / 50) * 380;
    return `
      <text x="36" y="${y+12}" fill="#cbd5e1" font-size="10" font-weight="600" font-family="Inter,sans-serif">${s.label}</text>
      <text x="200" y="${y+12}" fill="#64748b" font-size="9" font-family="Inter,sans-serif">${typeof s.count === "number" ? s.count + " candidates" : s.count}</text>
      <rect x="320" y="${y}" width="${Math.max(w,4)}" height="18" rx="3" fill="${s.c}" fill-opacity="0.7"/>
      <text x="${328+Math.max(w,4)}" y="${y+13}" fill="${s.c}" font-size="11" font-weight="700" font-family="Inter,sans-serif">$${s.cost.toFixed(2)}</text>
    `;
  }).join("")}

  <line x1="36" y1="332" x2="864" y2="332" stroke="#334155" stroke-width="1"/>
  <text x="36" y="350" fill="#22c55e" font-size="13" font-weight="800" font-family="Inter,sans-serif">TOTAL — NEW TENANT (worst case)</text>
  <text x="864" y="350" text-anchor="end" fill="#22c55e" font-size="16" font-weight="800" font-family="Inter,sans-serif">$85.33 / hire</text>
</svg>
`;

const TRAJECTORY_SVG = `
<svg viewBox="0 0 900 320" xmlns="http://www.w3.org/2000/svg" class="figure">
  <rect width="900" height="320" fill="#020617" rx="12"/>
  <text x="450" y="28" text-anchor="middle" fill="#e2e8f0" font-size="16" font-weight="700" font-family="Inter,sans-serif">Cost Per Hire — Trajectory vs. Market</text>
  <text x="450" y="48" text-anchor="middle" fill="#94a3b8" font-size="10" font-family="Inter,sans-serif">Living Talent Graph compounds margin with tenant maturity</text>

  <!-- Market reference band -->
  <rect x="80" y="70" width="780" height="20" fill="#ef4444" fill-opacity="0.1" stroke="#ef4444" stroke-opacity="0.3" stroke-dasharray="3 3"/>
  <text x="90" y="84" fill="#ef4444" font-size="10" font-weight="700" font-family="Inter,sans-serif">$4,700 — in-house industry average · $12K–$25K agency</text>

  <!-- Y axis -->
  <line x1="80" y1="120" x2="80" y2="270" stroke="#334155" stroke-width="1"/>
  <line x1="80" y1="270" x2="860" y2="270" stroke="#334155" stroke-width="1"/>
  ${[0, 25, 50, 75, 100].map(v => `
    <text x="72" y="${270 - (v/100)*150 + 4}" text-anchor="end" fill="#64748b" font-size="9" font-family="Inter,sans-serif">$${v}</text>
    <line x1="78" y1="${270 - (v/100)*150}" x2="80" y2="${270 - (v/100)*150}" stroke="#334155"/>
  `).join("")}

  <!-- Trajectory line -->
  ${(() => {
    const pts = [
      {x:160, y:270 - (85/100)*150, label:"$85", lbl:"Month 1"},
      {x:340, y:270 - (57/100)*150, label:"$57", lbl:"Month 6"},
      {x:520, y:270 - (47/100)*150, label:"$47", lbl:"Month 12"},
      {x:700, y:270 - (42/100)*150, label:"$42", lbl:"Month 24"},
    ];
    let path = `M ${pts[0].x} ${pts[0].y}`;
    pts.slice(1).forEach(p => path += ` L ${p.x} ${p.y}`);
    return `
      <path d="${path}" stroke="#22c55e" stroke-width="3" fill="none"/>
      <path d="${path} L 700 270 L 160 270 Z" fill="#22c55e" fill-opacity="0.1"/>
      ${pts.map(p => `
        <circle cx="${p.x}" cy="${p.y}" r="6" fill="#22c55e" stroke="#020617" stroke-width="2"/>
        <text x="${p.x}" y="${p.y - 14}" text-anchor="middle" fill="#22c55e" font-size="12" font-weight="800" font-family="Inter,sans-serif">${p.label}</text>
        <text x="${p.x}" y="288" text-anchor="middle" fill="#94a3b8" font-size="10" font-family="Inter,sans-serif">${p.lbl}</text>
      `).join("")}
    `;
  })()}

  <text x="450" y="310" text-anchor="middle" fill="#475569" font-size="10" font-family="Inter,sans-serif" font-style="italic">Every other AI sourcing tool's curve goes the other way — they spend more on external APIs as they grow.</text>
</svg>
`;

const COVER_GRAPHIC = `
<svg viewBox="0 0 800 200" xmlns="http://www.w3.org/2000/svg" class="cover-svg">
  <defs>
    <linearGradient id="cg" x1="0" x2="1">
      <stop offset="0" stop-color="#06b6d4"/>
      <stop offset="1" stop-color="#3b82f6"/>
    </linearGradient>
  </defs>
  <rect width="800" height="200" fill="#020617" rx="16"/>
  ${Array.from({length: 9}).map((_,i) => {
    const x = 60 + i * 80;
    const colors = ["#8b5cf6","#3b82f6","#06b6d4","#22c55e","#f97316","#6366f1","#10b981","#f43f5e","#eab308"];
    return `
      <circle cx="${x}" cy="100" r="22" fill="${colors[i]}" fill-opacity="0.2" stroke="${colors[i]}" stroke-width="1.5"/>
      <text x="${x}" y="105" text-anchor="middle" fill="${colors[i]}" font-size="13" font-weight="700" font-family="Inter,sans-serif">${i+1}</text>
      ${i < 8 ? `<line x1="${x+22}" y1="100" x2="${x+58}" y2="100" stroke="url(#cg)" stroke-width="2" opacity="0.5"/>` : ""}
    `;
  }).join("")}
  <text x="400" y="170" text-anchor="middle" fill="#64748b" font-size="11" font-family="Inter,sans-serif" letter-spacing="3">NINE AGENTS · ONE PIPELINE · ZERO BUSYWORK</text>
</svg>
`;

/* ── HTML TEMPLATE ────────────────────────────────────────────────────── */

const css = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, system-ui, sans-serif;
    color: #0f172a; line-height: 1.6; font-size: 11pt;
    margin: 0; padding: 0; background: white;
  }
  .page { padding: 18mm 16mm; }
  h1 { color: #0e7490; font-size: 24pt; border-bottom: 3px solid #06b6d4; padding-bottom: 8px; margin-top: 28px; }
  h2 { color: #0891b2; font-size: 16pt; margin-top: 30px; border-left: 4px solid #06b6d4; padding-left: 12px; page-break-after: avoid; }
  h3 { color: #0f172a; font-size: 12.5pt; margin-top: 22px; page-break-after: avoid; }
  h4 { color: #475569; font-size: 11pt; margin-top: 16px; text-transform: uppercase; letter-spacing: 0.5px; }
  p, li { font-size: 10.5pt; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0; font-size: 9.5pt; page-break-inside: avoid; }
  th { background: #ecfeff; color: #0e7490; text-align: left; padding: 8px 10px; border-bottom: 2px solid #06b6d4; }
  td { padding: 7px 10px; border-bottom: 1px solid #e2e8f0; vertical-align: top; }
  blockquote { background: #f0fdfa; border-left: 4px solid #14b8a6; padding: 12px 16px; color: #134e4a; margin: 16px 0; border-radius: 4px; font-style: italic; }
  blockquote p { font-size: 11pt; }
  code { background: #f1f5f9; padding: 1px 5px; border-radius: 3px; font-size: 9.5pt; color: #0f766e; }
  pre { background: #0f172a; color: #e2e8f0; padding: 12px 16px; border-radius: 6px; font-size: 9.5pt; overflow-x: auto; page-break-inside: avoid; }
  pre code { background: transparent; color: inherit; padding: 0; }
  hr { border: none; border-top: 1px dashed #cbd5e1; margin: 28px 0; }
  .figure { width: 100%; height: auto; margin: 18px 0; border-radius: 12px; page-break-inside: avoid; display: block; }
  .figure-caption { text-align: center; font-size: 9pt; color: #64748b; margin-top: -8px; margin-bottom: 18px; font-style: italic; }
  .cover { text-align: center; padding: 80px 0 40px; page-break-after: always; }
  .cover h1 { border: none; font-size: 56pt; color: #06b6d4; margin: 0; letter-spacing: -2px; font-weight: 800; }
  .cover .subtitle { font-size: 14pt; color: #475569; margin-top: 12px; letter-spacing: 2px; text-transform: uppercase; font-weight: 500; }
  .cover .tag { display:inline-block; margin-top: 30px; background: #06b6d4; color:white; padding: 8px 20px; border-radius: 999px; font-size: 11pt; font-weight: 600; letter-spacing: 1px; }
  .cover .tag.dark { background: #0f172a; color: #06b6d4; border: 1px solid #06b6d4; }
  .cover-svg { max-width: 720px; margin: 50px auto 0; display: block; }
  .nda { background: #fef2f2; border: 1px solid #fecaca; color: #991b1b; padding: 16px 20px; border-radius: 8px; margin: 30px 0; font-size: 10pt; line-height: 1.5; }
  .nda strong { display: block; margin-bottom: 6px; font-size: 11pt; }
`;

function buildHtml(mdPath, title, opts = {}) {
  const raw = readFileSync(mdPath, "utf8");
  let html = md.render(stripFrontMatter(raw));

  // Inject SVG figures at marker comments in the markdown.
  html = html.replace("&lt;!--PIPELINE--&gt;", PIPELINE_SVG + '<div class="figure-caption">Figure 1 — The L3xy 9-stage autonomous hiring pipeline</div>');
  html = html.replace("&lt;!--SCORING--&gt;", SCORING_SVG + '<div class="figure-caption">Figure 2 — Composite score weights feeding the Hire Probability gauge</div>');
  html = html.replace("&lt;!--NBA--&gt;", NBA_SVG + '<div class="figure-caption">Figure 3 — Next Best Action waterfall (first match wins)</div>');
  html = html.replace("&lt;!--ENGINE--&gt;", ENGINE_SVG + '<div class="figure-caption">Figure 4 — Signal flow from agents through the Intelligence Engine to recruiter outputs</div>');
  html = html.replace("&lt;!--COVER--&gt;", COVER_GRAPHIC);
  html = html.replace("&lt;!--CANDIDATE--&gt;", CANDIDATE_GRAPH_SVG + '<div class="figure-caption">The Living Talent Graph — every candidate is a node that grows richer over time</div>');

  // Plain-comment fallback (markdown-it sometimes preserves HTML comments).
  html = html.replace("<!--PIPELINE-->", PIPELINE_SVG + '<div class="figure-caption">Figure 1 — The L3xy 9-stage autonomous hiring pipeline</div>');
  html = html.replace("<!--SCORING-->", SCORING_SVG + '<div class="figure-caption">Figure 2 — Composite score weights feeding the Hire Probability gauge</div>');
  html = html.replace("<!--NBA-->", NBA_SVG + '<div class="figure-caption">Figure 3 — Next Best Action waterfall (first match wins)</div>');
  html = html.replace("<!--ENGINE-->", ENGINE_SVG + '<div class="figure-caption">Figure 4 — Signal flow from agents through the Intelligence Engine to recruiter outputs</div>');
  html = html.replace("<!--COVER-->", COVER_GRAPHIC);
  html = html.replace("<!--CANDIDATE-->", CANDIDATE_GRAPH_SVG + '<div class="figure-caption">The Living Talent Graph — every candidate is a node that grows richer over time</div>');
  html = html.replace("<!--USERCOVER-->", USERCOVER_SVG);
  html = html.replace("<!--DASHBOARD-->", DASHBOARD_SVG + '<div class="figure-caption">Mockup — the Recruiter Dashboard at a glance</div>');
  html = html.replace("<!--CARD-->", CARD_SVG + '<div class="figure-caption">Mockup — a Candidate Card with the Intelligence tab open</div>');
  html = html.replace("<!--ECONCOVER-->", ECONCOVER_SVG);
  html = html.replace("<!--FUNNEL-->", FUNNEL_SVG + '<div class="figure-caption">Per-hire cost waterfall — cold-start tenant, all sourcing via paid Tier-3 APIs</div>');
  html = html.replace("<!--TRAJECTORY-->", TRAJECTORY_SVG + '<div class="figure-caption">Cost-per-hire trajectory — the financial expression of the Living Talent Graph</div>');
  html = html.replace("<!--LIVING-->", LIVING_SVG + '<div class="figure-caption">Six always-on background workers keep the pool alive 24/7</div>');
  html = html.replace("<!--REGIONS-->", REGIONS_SVG + '<div class="figure-caption">Customer cost-per-hire range by region (log scale) — our flat ~$50 cost vs. 20× global variance</div>');
  html = html.replace("<!--ATTRIBUTION-->", ATTRIBUTION_SVG + '<div class="figure-caption">Multi-signal hire attribution — confidence triangulated from many independent sources</div>');
  html = html.replace("<!--PARTNERS-->", PARTNERS_SVG + '<div class="figure-caption">L3xy Partner Network — partners bring distribution and pool depth in exchange for 20-40% of attributed revenue</div>');

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/>
<title>${title}</title>
<style>${css}</style>
</head><body><div class="page">${html}</div></body></html>`;
}

/* ── PDF GENERATION ───────────────────────────────────────────────────── */

async function buildPdf(mdPath, htmlOut, pdfOut, title, headerText, footerText) {
  const html = buildHtml(mdPath, title);
  writeFileSync(htmlOut, html);

  const browser = await puppeteer.launch({
    executablePath: "/nix/store/qa9cnw4v5xkxyip6mb9kxqfq1z4x2dx1-chromium-138.0.7204.100/bin/chromium",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });
    await page.pdf({
      path: pdfOut,
      format: "Letter",
      printBackground: true,
      margin: { top: "20mm", bottom: "20mm", left: "0", right: "0" },
      displayHeaderFooter: true,
      headerTemplate: `<style>section{margin:0 auto;font-family:Inter,system-ui,sans-serif;font-size:8.5pt;color:#64748b;width:100%;padding:0 18mm;display:flex;justify-content:space-between;}</style><section><span>${headerText}</span><span>L3xy Inc.</span></section>`,
      footerTemplate: `<style>section{margin:0 auto;font-family:Inter,system-ui,sans-serif;font-size:8.5pt;color:#64748b;width:100%;padding:0 18mm;display:flex;justify-content:space-between;}</style><section><span>${footerText}</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></section>`,
    });
    console.log(`✓ ${pdfOut}`);
  } finally {
    await browser.close();
  }
}

await buildPdf(
  "docs/L3xy_Guidebook_Public.md",
  "docs/L3xy_Guidebook_Public.html",
  "docs/L3xy_Guidebook_Public.pdf",
  "L3xy — Overview Guidebook",
  "L3xy · The Autonomous AI Hiring Platform",
  "© 2026 L3xy Inc. — Public overview, distribute freely",
);

await buildPdf(
  "docs/L3xy_Guidebook_Full.md",
  "docs/L3xy_Guidebook_Full.html",
  "docs/L3xy_Guidebook_Full.pdf",
  "L3xy — Technical Guidebook (NDA)",
  "L3xy · Technical Guidebook · CONFIDENTIAL",
  "© 2026 L3xy Inc. — NDA-restricted distribution",
);

await buildPdf(
  "docs/L3xy_Recruiter_User_Guide.md",
  "docs/L3xy_Recruiter_User_Guide.html",
  "docs/L3xy_Recruiter_User_Guide.pdf",
  "L3xy — Recruiter User Guide",
  "L3xy · Recruiter User Guide",
  "© 2026 L3xy Inc. — Your day-to-day playbook",
);

await buildPdf(
  "docs/L3xy_Unit_Economics_and_Pricing.md",
  "docs/L3xy_Unit_Economics_and_Pricing.html",
  "docs/L3xy_Unit_Economics_and_Pricing.pdf",
  "L3xy — Unit Economics & Pricing",
  "L3xy · Unit Economics & Pricing · CONFIDENTIAL",
  "© 2026 L3xy Inc. — Internal & Board use only",
);
