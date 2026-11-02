(() => {
"use strict";
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ls = {
  get(k, d) { try { const v = localStorage.getItem("pc:" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("pc:" + k, JSON.stringify(v)); } catch {} }
};
const CATS = ["Food crimes", "Friendship matters", "Group chat drama", "Roommate disputes", "Relationship", "Sibling rivalry", "Money matters", "Other"];
const PHASES = [
  ["assembling", "Assembling"], ["opening", "Opening statements"], ["evidence", "Evidence"],
  ["arguments", "Arguments"], ["deliberation", "Jury deliberation"], ["verdict", "Verdict"]
];
const PHASE_IDX = Object.fromEntries(PHASES.map(([k], i) => [k, i]));
const ROLES = {
  petitioner: { label: "Petitioner", c: "var(--pet)" },
  defendant: { label: "Defendant", c: "var(--def)" },
  judge: { label: "Judge", c: "var(--judge)" },
  jury: { label: "Jury", c: "var(--jury)" },
  gallery: { label: "Gallery", c: "var(--muted)" }
};
const SPEAKING = ["petitioner", "defendant", "judge"];
const GROUNDS = ["Hearsay", "Irrelevant", "Badgering the witness", "Speculation", "Leading the witness", "That's just petty", "Screenshot is cropped", "Emotional damage"];
const SENTENCES = [
  "Buy the other side a full plate of fries",
  "Let the other side pick your profile picture for 24 hours",
  "Reply within 5 minutes, every time, for a week",
  "Post a 50-word apology in the group chat",
  "Treat the whole jury to chai",
  "Hand over your last packet of Maggi",
  "Give three sincere compliments before midnight",
  "No leaving anyone on seen for 72 hours",
  "Carry their bag for a full day",
  "Sing one song of their choosing in a voice note",
  "Do their share of the dishes for 3 days",
  "Case dismissed. Both of you go get ice cream together"
];

// ---------- identity & connection ----------
let key = ls.get("key", "");
if (!/^[a-f0-9]{32}$/.test(key)) {
  const b = new Uint8Array(16); crypto.getRandomValues(b);
  key = [...b].map(x => x.toString(16).padStart(2, "0")).join(""); ls.set("key", key);
}
let nick = ls.get("nick", "");
const socket = io({ auth: { key } });

const S = {
  view: "home", filter: "All", tab: "hearing",
  uid: null, realUid: null, aiAvailable: false, connected: false,
  cases: [], docketLoaded: false,
  caseId: null, kase: null, members: [], msgs: [], evidence: [], marks: [], votes: [],
  voiceState: { muted: {}, floor: {}, hands: {}, participants: [] },
  demo: false, pendingImg: null, caseMissing: false
};

const voice = new CourtVoice(socket, {
  onChange: () => { renderDock(); if (S.view === "case") renderBench(); },
  canSpeak: uid => canSpeakUid(uid),
  me: () => S.uid,
  participants: () => S.voiceState.participants || [],
  toast: t => toast(t)
});

socket.on("connect", () => {
  S.connected = true; setConn();
  if (S.view === "case" && !S.demo && S.caseId) openCase(S.caseId, { keepTab: true });
});
socket.on("disconnect", () => { S.connected = false; setConn(); });
socket.on("connect_error", () => { S.connected = false; setConn(); });
socket.on("hello", h => {
  S.uid = S.realUid = h.uid; S.aiAvailable = h.aiJudge;
  if (S.view === "file") render();
});
socket.on("docket", list => { S.cases = list; S.docketLoaded = true; if (S.view === "home") renderDocket(); });
socket.on("case:state", v => { if (!S.demo && v.kase.code === S.caseId) applyState(v); });
socket.on("gavel", () => gavelFx());

function setConn() { $("#conn").textContent = S.connected ? "" : "Reconnecting…"; }

function emit(event, payload) {
  return new Promise((resolve, reject) => {
    if (!socket.connected) { toast("You're offline. Reconnecting…"); return reject(new Error("offline")); }
    socket.timeout(20000).emit(event, payload, (err, res) => {
      if (err) { toast("The court didn't answer. Check your connection."); return reject(err); }
      if (res && res.error) { toast(res.error); return reject(new Error(res.error)); }
      resolve(res || {});
    });
  });
}
const quiet = p => p.catch(() => {});

function applyState(v) {
  const prev = S.kase?.status;
  S.kase = v.kase; S.members = v.members; S.msgs = v.msgs; S.evidence = v.evidence; S.marks = v.marks; S.votes = v.votes;
  S.voiceState = v.voice; S.caseMissing = false;
  if (prev && prev !== S.kase.status) {
    if (S.kase.status === "verdict") S.tab = "verdict";
    else if (S.kase.status === "deliberation") S.tab = "jury";
    else if (S.kase.status === "evidence") S.tab = "evidence";
  }
  if (prev !== "verdict" && S.kase.verdict && S.tab !== "verdict" && S.kase.status === "verdict") S.tab = "verdict";
  remember(S.caseId, S.kase.title);
  renderCaseFrame(); renderCasePanels(); renderDock();
  voice.sync();
  maybeOfferInvite();
}

// ---------- local actions for the practice hearing; server calls otherwise ----------
const api = {
  addMsg(m) {
    if (S.demo) { S.msgs.push({ id: "m" + Math.random(), at: Date.now(), uid: S.uid, phase: S.kase.status, nick: me()?.nick, role: me()?.role, ...m }); return refreshDemo(); }
    return emit("msg:add", { code: S.caseId, ...m });
  },
  rule(id, ruling) {
    if (S.demo) { Object.assign(S.msgs.find(x => x.id === id), { ruling }); return refreshDemo(); }
    return emit("msg:rule", { code: S.caseId, id, ruling });
  },
  phase(dir) {
    if (S.demo) {
      const i = PHASE_IDX[S.kase.status] + (dir === "back" ? -1 : 1);
      S.kase.status = PHASES[i][0];
      S.msgs.push({ id: "s" + Math.random(), kind: "system", text: `The court moves to ${PHASES[i][1].toLowerCase()}.`, at: Date.now() });
      return refreshDemo();
    }
    return emit("phase:set", { code: S.caseId, dir });
  },
  gavel() {
    if (S.demo) {
      S.msgs.push({ id: "g" + Math.random(), kind: "gavel", text: "Order! Order in the court!", nick: me().nick, role: "judge", at: Date.now() });
      S.msgs.push({ id: "s" + Math.random(), kind: "system", text: "The judge silenced the courtroom. Only the judge can speak.", at: Date.now() });
      S.voiceState.muted = Object.fromEntries(S.members.filter(m => m.id !== S.uid).map(m => [m.id, true]));
      gavelFx(); return refreshDemo();
    }
    return emit("gavel", { code: S.caseId });
  },
  unmuteAll() {
    if (S.demo) {
      S.voiceState.muted = {};
      S.msgs.push({ id: "s" + Math.random(), kind: "system", text: "The judge unmuted the courtroom.", at: Date.now() });
      return refreshDemo();
    }
    return emit("voice:unmute-all", { code: S.caseId });
  },
  addEvidence(e) {
    if (S.demo) {
      const ev = { id: "e" + Math.random(), exhibit: letter(S.evidence.length), nick: me().nick, role: me().role, at: Date.now(), ...e };
      S.evidence.push(ev);
      S.msgs.push({ id: "s" + Math.random(), kind: "system", text: `${ev.nick} enters Exhibit ${ev.exhibit} into evidence${ev.caption ? ": " + ev.caption : ""}.`, at: Date.now() });
      return refreshDemo();
    }
    return emit("evidence:add", { code: S.caseId, ...e });
  },
  mark(evid, val) {
    if (S.demo) { const id = S.uid + "_" + evid; S.marks = S.marks.filter(x => x.id !== id); if (val) S.marks.push({ id, evid, uid: S.uid, val }); return refreshDemo(); }
    return emit("mark:set", { code: S.caseId, evid, val });
  },
  vote(side) { return emit("vote:set", { code: S.caseId, side }); },
  verdict(v) {
    if (S.demo) { S.kase.verdict = { ...v, by: "judge", judgeNick: me().nick, at: Date.now() }; gavelFx(); return refreshDemo(); }
    return emit("verdict:set", { code: S.caseId, verdict: v });
  },
  clearVerdict() {
    if (S.demo) { S.kase.verdict = null; return refreshDemo(); }
    return emit("verdict:clear", { code: S.caseId });
  }
};
function refreshDemo() { renderCaseFrame(); renderCasePanels(); return Promise.resolve({}); }

// ---------- helpers ----------
function initials(n) { return (n || "?").trim().split(/\s+/).map(w => w[0]).join("").slice(0, 2).toUpperCase(); }
function ago(t) {
  const s = Math.max(1, Math.round((Date.now() - t) / 1000));
  if (s < 60) return s + "s ago"; if (s < 3600) return Math.round(s / 60) + "m ago";
  if (s < 86400) return Math.round(s / 3600) + "h ago"; return Math.round(s / 86400) + "d ago";
}
function letter(i) { let s = ""; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }
function toast(t) {
  document.querySelectorAll(".toast").forEach(x => x.remove());
  const el = document.createElement("div"); el.className = "toast"; el.textContent = t; el.setAttribute("role", "status");
  document.body.appendChild(el); setTimeout(() => el.remove(), 3200);
}
function me() { return S.members.find(m => m.id === S.uid); }
function seated(role) { return S.members.find(m => m.role === role && m.state === "seated"); }
function isCreator() { return !!S.kase && S.kase.createdBy === S.uid; }
// Only the seated judge runs the hearing. With an AI judge, the case creator acts as court clerk.
function canPreside() { if (!S.kase) return false; return S.kase.aiJudge ? isCreator() : seated("judge")?.id === S.uid; }
function phaseIdx() { return PHASE_IDX[S.kase?.status] ?? 0; }
function canSpeakUid(uid) {
  const m = S.members.find(x => x.id === uid);
  if (!m || m.state !== "seated" || S.voiceState.muted?.[uid]) return false;
  return SPEAKING.includes(m.role) || !!S.voiceState.floor?.[uid];
}
function remember(code, title) {
  if (!code || !title) return;
  const list = ls.get("mine", []).filter(x => x.code !== code);
  list.unshift({ code, title, at: Date.now() }); ls.set("mine", list.slice(0, 20));
}
function canOrganize() { return !S.demo && (isCreator() || canPreside()); }
function fmtWhen(ts, tz) {
  return new Date(ts).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", ...(tz ? { timeZoneName: "short" } : {}) });
}
function untilText(ts) {
  const m = Math.round((ts - Date.now()) / 60000);
  if (m > 0) {
    const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
    return "in " + (d ? `${d} day${d > 1 ? "s" : ""}${h ? ` ${h} h` : ""}` : h ? `${h} h${mm ? ` ${mm} min` : ""}` : `${mm} min`);
  }
  return m > -2 ? "starting now" : `started ${-m < 60 ? -m + " min" : Math.round(-m / 60) + " h"} ago`;
}
// "2026-11-08T20:00" in the viewer's own time zone, for <input type="datetime-local">
function toLocalInput(ts) {
  const d = new Date(ts), p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function caseLink(invite) { return `${location.origin}/#${S.caseId}${invite ? `.${invite.role}.${invite.token}` : ""}`; }
function parseHash() {
  const m = /^([A-Za-z0-9]{6})(?:\.(petitioner|defendant|judge|jury|gallery)\.([a-f0-9]{16}))?$/.exec(location.hash.slice(1));
  return m ? { code: m[1].toUpperCase(), invite: m[2] ? { role: m[2], token: m[3] } : null } : null;
}
function calendarLinks(k) {
  const start = new Date(k.scheduledAt), end = new Date(k.scheduledAt + 3600e3);
  const z = d => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const title = `Petty Court: ${k.title}`, details = `Join the hearing: ${caseLink()}`;
  const google = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(title)}&dates=${z(start)}/${z(end)}&details=${encodeURIComponent(details)}`;
  const icsEsc = s => s.replace(/[\\;,]/g, m => "\\" + m).replace(/\n/g, "\\n");
  const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Petty Court//EN", "BEGIN:VEVENT",
    `UID:${S.caseId}-${k.scheduledAt}@pettycourt`, `DTSTAMP:${z(new Date())}`, `DTSTART:${z(start)}`, `DTEND:${z(end)}`,
    `SUMMARY:${icsEsc(title)}`, `DESCRIPTION:${icsEsc(details)}`, `URL:${caseLink()}`, "END:VEVENT", "END:VCALENDAR"].join("\r\n");
  return { google, ics };
}
// While the page is open, announce the hearing when its time arrives.
setInterval(() => {
  const k = S.kase;
  if (S.view !== "case" || S.demo || !k?.scheduledAt) return;
  const el = $("#sched-when"); if (el) el.textContent = untilText(k.scheduledAt);
  if (Date.now() >= k.scheduledAt && Date.now() - k.scheduledAt < 5 * 60e3 && S.alertedFor !== k.scheduledAt) {
    S.alertedFor = k.scheduledAt;
    gavelFx();
    toast(voice.joined ? "The hearing is starting now." : "The hearing is starting now. Join voice at the bottom of the screen.");
  }
}, 15000);
function gavelFx() {
  window.courtKnock(voice.audioCtx());
  document.querySelectorAll(".msg.gavel").forEach(el => { el.classList.remove("gavelhit"); void el.offsetWidth; el.classList.add("gavelhit"); });
}
// Unlock audio on the first tap anywhere, so the gavel can be heard.
document.addEventListener("pointerdown", () => voice.audioCtx(), { once: true });

// ---------- top-level render ----------
function render() {
  const app = $("#app");
  if (S.view === "home") { app.innerHTML = homeHTML(); bindHome(); renderDocket(); }
  else if (S.view === "file") { app.innerHTML = fileHTML(); bindFile(); }
  else if (S.view === "case") { app.innerHTML = caseShellHTML(); bindCaseShell(); renderCaseFrame(); renderCasePanels(); }
  renderDock();
  window.scrollTo(0, 0);
}

// ---------- home ----------
function homeHTML() {
  const mine = ls.get("mine", []);
  return `
  <section class="hero">
    <div>
      <div class="eyebrow">Unofficial court for official nonsense</div>
      <h1>Small crimes.<br>Full trial.</h1>
      <p class="lede">Someone ate your fries, left you on seen, or "borrowed" your charger in 2023. Open a courtroom, argue it out loud in live voice, bring the receipts as photo evidence, and let the jury decide.</p>
      <div class="ctas">
        <button class="btn primary" id="h-file" type="button">File a case</button>
        <form class="joinbox" id="joinform">
          <input type="text" id="joincode" maxlength="6" placeholder="CODE" aria-label="Room code" autocomplete="off">
          <button class="btn" type="submit">Join</button>
        </form>
      </div>
    </div>
    <div class="docket-card" aria-label="Example case">
      <span class="stamp">EXAMPLE</span>
      <div class="eyebrow">Case #FR1ES8 · Food crimes</div>
      <h3 style="margin-block:6px 10px">The People v. the guy who "just tasted one" fry</h3>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        <span class="pill voice">5 in voice</span><span class="pill">Exhibit A · empty box photo</span><span class="pill live">Jury 3–1</span>
      </div>
      <p class="muted" style="margin:12px 0 0;font-size:14px">Sentence: buy the other side a full plate of fries.</p>
      <button class="btn small" id="h-demo" type="button" style="margin-top:12px">Try it as the judge</button>
    </div>
  </section>
  <section class="steps" aria-label="How a hearing runs">
    <div class="step"><b>1. File</b><span>Describe what happened and pick a category.</span></div>
    <div class="step"><b>2. Summon</b><span>Share the invite link. Friends take seats as defendant, judge or jury.</span></div>
    <div class="step"><b>3. Argue</b><span>Talk it out in live voice. Object, rule, and enter photo exhibits.</span></div>
    <div class="step"><b>4. Verdict</b><span>Jury votes, then the judge rules and spins the punishment wheel.</span></div>
  </section>
  ${mine.length ? `<section style="margin-bottom:28px"><div class="sechead"><h2>Your cases</h2></div>
    <div class="chips">${mine.map(m => `<button class="chip" type="button" data-open="${esc(m.code)}"><span class="mono">#${esc(m.code)}</span> ${esc(m.title.slice(0, 40))}</button>`).join("")}</div></section>` : ""}
  <section>
    <div class="sechead"><div><div class="eyebrow">Public cases · open seats</div><h2>The docket</h2></div></div>
    <div class="chips" id="filters">${["All", ...CATS].map(c => `<button type="button" class="chip ${S.filter === c ? "on" : ""}" data-f="${esc(c)}">${esc(c)}</button>`).join("")}</div>
    <div id="docket"></div>
  </section>`;
}
function bindHome() {
  $("#h-file").onclick = () => go("file");
  $("#h-demo").onclick = startDemo;
  $("#joinform").onsubmit = e => {
    e.preventDefault();
    const c = $("#joincode").value.trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(c)) return toast("Room codes are 6 letters or numbers.");
    openCase(c);
  };
  $("#filters").onclick = e => { const b = e.target.closest("[data-f]"); if (!b) return; S.filter = b.dataset.f; document.querySelectorAll("#filters .chip").forEach(x => x.classList.toggle("on", x === b)); renderDocket(); };
  document.querySelectorAll("[data-open]").forEach(b => b.onclick = () => openCase(b.dataset.open));
}
function renderDocket() {
  const el = $("#docket"); if (!el) return;
  if (!S.docketLoaded) { el.innerHTML = `<div class="empty">Calling the docket…</div>`; return; }
  let list = S.cases;
  if (S.filter !== "All") list = list.filter(c => c.category === S.filter);
  list = [...list].sort((a, b) => (b.live > 0) - (a.live > 0) || (a.status === "verdict") - (b.status === "verdict") || b.createdAt - a.createdAt);
  if (!list.length) { el.innerHTML = `<div class="empty">No public cases ${S.filter === "All" ? "yet" : "in " + esc(S.filter)}. File the first one and the jury will come.</div>`; return; }
  el.innerHTML = `<div class="grid-cases">${list.map(caseCard).join("")}</div>`;
  el.querySelectorAll("[data-open]").forEach(b => b.onclick = () => openCase(b.dataset.open));
}
function caseCard(c) {
  const s = c.summary || {};
  const open = ["petitioner", "defendant", "judge"].filter(r => !s[r] && !(r === "judge" && c.aiJudge));
  const juryLeft = Math.max(0, (c.juryMax || 0) - (s.jury || 0));
  const st = c.status === "verdict" ? `<span class="pill done">Verdict in</span>` : c.status === "assembling" ? `<span class="pill">Assembling</span>` : `<span class="pill live">${esc((PHASES[PHASE_IDX[c.status]] || [])[1] || "Live")}</span>`;
  return `<article class="case-card">
    <div class="row"><span class="mono muted" style="font-size:12px">#${esc(c.id)}</span><span class="eyebrow">${esc(c.category)}</span>${st}${c.live ? `<span class="pill voice">${c.live} in voice</span>` : ""}${c.scheduledAt && c.scheduledAt > Date.now() - 3600e3 && c.status !== "verdict" ? `<span class="pill">Hearing ${esc(fmtWhen(c.scheduledAt))}</span>` : ""}</div>
    <div class="t">${esc(c.title)}</div>
    <div class="row">${open.map(r => `<span class="pill open">${ROLES[r].label} open</span>`).join("")}${c.aiJudge ? `<span class="pill">AI judge</span>` : ""}<span class="pill">${juryLeft} jury seat${juryLeft === 1 ? "" : "s"} open</span></div>
    <div><button class="btn small" type="button" data-open="${esc(c.id)}">${c.status === "verdict" ? "Read the verdict" : "Enter courtroom"}</button></div>
  </article>`;
}

// ---------- file a case ----------
function fileHTML() {
  return `
  <section style="padding-block:28px">
    <div class="eyebrow">New petition</div><h2 style="margin-bottom:18px">File a case</h2>
    <form class="form panel" id="fileform">
      <label for="f-title">What's the case?<input type="text" id="f-title" maxlength="90" required placeholder="My roommate finished my Nutella and put the empty jar back"></label>
      <label for="f-cat">Category<select id="f-cat">${CATS.map(c => `<option>${esc(c)}</option>`).join("")}</select></label>
      <label for="f-story">Your side of the story <span class="hint">Shown at the top of the hearing record.</span><textarea id="f-story" maxlength="1200" placeholder="On Tuesday at roughly 11:40 pm…"></textarea></label>
      <label for="f-nick">Your nickname in court<input type="text" id="f-nick" maxlength="24" required value="${esc(nick)}" placeholder="What the court calls you"></label>
      <div><div style="font-weight:600;font-size:14px;margin-bottom:6px">Your seat</div>
        <div class="radios">${["petitioner", "defendant", "judge"].map((r, i) => `<label><input type="radio" name="f-role" value="${r}" ${i === 0 ? "checked" : ""}> ${ROLES[r].label}</label>`).join("")}</div></div>
      <div><div style="font-weight:600;font-size:14px;margin-bottom:6px">Who judges?</div>
        <div class="radios">
          <label><input type="radio" name="f-judge" value="friend" checked> A friend takes the judge's seat</label>
          ${S.aiAvailable ? `<label><input type="radio" name="f-judge" value="ai"> AI judge reads the record and the photos</label>` : ""}
        </div></div>
      <label for="f-jury">Jury seats <span class="hint">0 to 12. With no jury, the judge decides alone.</span><input type="text" inputmode="numeric" id="f-jury" value="5"></label>
      <div class="radios"><label><input type="checkbox" id="f-public" checked> List on the public docket</label></div>
      <p class="muted" style="margin:0;font-size:13px">Public cases: anyone can join the jury, and speaking seats need your approval. Private cases: only people with the code get in, and they take free seats directly.</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn primary" type="submit" id="f-submit">Open the courtroom</button><button class="btn ghost" type="button" id="f-cancel">Cancel</button></div>
    </form>
  </section>`;
}
function bindFile() {
  $("#f-cancel").onclick = () => go("home");
  $("#fileform").onsubmit = async e => {
    e.preventDefault();
    const title = $("#f-title").value.trim(), n = $("#f-nick").value.trim();
    if (!title || !n) return toast("Add a case title and your nickname.");
    nick = n; ls.set("nick", nick);
    const p = {
      title, nick, category: $("#f-cat").value, story: $("#f-story").value.trim(),
      role: document.querySelector("[name=f-role]:checked").value,
      aiJudge: document.querySelector("[name=f-judge]:checked")?.value === "ai",
      juryMax: parseInt($("#f-jury").value, 10) || 0, public: $("#f-public").checked
    };
    $("#f-submit").disabled = true;
    try { const r = await emit("case:create", p); remember(r.code, title); openCase(r.code); }
    catch { const b = $("#f-submit"); if (b) b.disabled = false; }
  };
}

// ---------- case room ----------
async function openCase(code, { keepTab, invite } = {}) {
  code = String(code).toUpperCase();
  if (S.demo || S.caseId !== code) voice.leave();
  Object.assign(S, { view: "case", demo: false, uid: S.realUid, caseId: code, pendingImg: null, caseMissing: false });
  if (!keepTab) S.invite = invite || null;
  if (!keepTab) Object.assign(S, { kase: null, members: [], msgs: [], evidence: [], marks: [], votes: [], voiceState: { muted: {}, floor: {}, hands: {}, participants: [] }, tab: "hearing" });
  try { history.replaceState(null, "", "#" + code); } catch {}
  if (!keepTab) render();
  if (!socket.connected) return;
  try {
    const r = await emit("case:open", { code });
    if (S.caseId === code) applyState(r.state);
  } catch { if (S.caseId === code) { S.caseMissing = true; renderCaseFrame(); renderCasePanels(); } }
}

function caseShellHTML() {
  return `${S.demo ? `<div class="banner">Practice hearing. You're the judge. Nothing here is saved or shared, and voice is off.</div>` : ""}
  <div id="case-frame"></div>
  <div class="room">
    <aside class="bench" id="bench" aria-label="Seats"></aside>
    <section style="min-width:0">
      <div class="tabs" role="tablist" id="tabs"></div>
      <div id="panel"></div>
    </section>
  </div>`;
}
function bindCaseShell() {
  $("#tabs").onclick = e => { const b = e.target.closest("[data-tab]"); if (!b) return; S.tab = b.dataset.tab; renderCasePanels(); };
}

function renderCaseFrame() {
  const el = $("#case-frame"); if (!el) return;
  if (S.caseMissing && !S.kase) { el.innerHTML = `<div class="empty" style="margin-top:24px">No courtroom with code <b class="mono">${esc(S.caseId)}</b>. Check the code with whoever filed it.<br><br><button class="btn" type="button" id="back">Back to the docket</button></div>`; $("#back").onclick = () => go("home"); return; }
  if (!S.kase) { el.innerHTML = `<div class="empty" style="margin-top:24px">Unlocking courtroom #${esc(S.caseId)}…</div>`; return; }
  const k = S.kase, pi = phaseIdx(), settled = k.status === "settled";
  el.innerHTML = `
  <div class="case-top">
    <div class="title">
      <div class="eyebrow">Case #${esc(S.caseId)} · ${esc(k.category)} · ${k.public ? "Public" : "Private"}${k.aiJudge ? " · AI judge" : ""}</div>
      <h2>${esc(k.title)}</h2>
      <div class="muted" style="font-size:13.5px;margin-top:4px">Filed by ${esc(k.creatorNick || "someone")} ${k.createdAt ? ago(k.createdAt) : ""}</div>
    </div>
    <div style="display:grid;gap:8px;justify-items:end">
      <div class="codebox"><span class="eyebrow">Room code</span><span class="code">${esc(S.caseId)}</span>${S.demo ? "" : `<button class="btn small" id="copy" type="button">Copy invite link</button>`}${canOrganize() && !settled && k.status !== "verdict" ? `<button class="btn small brass" id="plan" type="button">Schedule &amp; invite</button>` : ""}</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:end">${presideControls()}</div>
    </div>
  </div>
  ${settled ? `<div class="banner">Settled out of court. The parties made peace. The record stays open to read.</div>` :
  `<div class="phases" aria-label="Hearing phase">${PHASES.map(([, lab], i) => `<div class="phase ${i === pi ? "cur" : i < pi ? "past" : ""}"><span class="n">${i + 1}</span>${lab}</div>`).join("")}</div>`}
  ${k.scheduledAt && !settled && k.status !== "verdict" && !S.demo ? `<div class="sched">
    <div class="when"><span class="eyebrow">Hearing scheduled</span><b>${esc(fmtWhen(k.scheduledAt, true))}</b><span class="muted" id="sched-when">${esc(untilText(k.scheduledAt))}</span></div>
    <div class="acts"><a class="btn small" href="${esc(calendarLinks(k).google)}" target="_blank" rel="noopener">Google Calendar</a><button class="btn small" type="button" id="ics">Download calendar file</button></div>
  </div>` : ""}`;
  const plan = $("#plan"); if (plan) plan.onclick = planBox;
  const icsBtn = $("#ics");
  if (icsBtn) icsBtn.onclick = () => {
    const url = URL.createObjectURL(new Blob([calendarLinks(k).ics], { type: "text/calendar" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: `petty-court-${S.caseId}.ics` });
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
  };
  const cp = $("#copy");
  if (cp) cp.onclick = async () => {
    const link = `${location.origin}/#${S.caseId}`;
    try { await navigator.clipboard.writeText(link); toast("Invite link copied"); }
    catch { toast(link); }
  };
  el.querySelectorAll("[data-act]").forEach(b => b.onclick = () => presideAct(b.dataset.act));
}
function presideControls() {
  if (S.kase.status === "settled") return "";
  const pi = phaseIdx(), out = [];
  const settle = pi < PHASES.length - 1 && isCreator() && !S.demo ? `<button class="btn ghost small" type="button" data-act="settle">Settle out of court</button>` : "";
  if (!canPreside()) {
    if (pi < PHASES.length - 1) out.push(`<span class="muted" style="font-size:13px;align-self:center">${seated("judge") || S.kase.aiJudge ? "Only the judge moves the hearing along." : "Waiting for a judge to take the seat."}</span>`);
    return out.join("") + settle;
  }
  if (pi < PHASES.length - 2) out.push(`<button class="btn primary small" type="button" data-act="next">Move to ${PHASES[pi + 1][1].toLowerCase()}</button>`);
  if (pi === PHASES.length - 2) out.push(`<button class="btn primary small" type="button" data-act="next">Go to verdict</button>`);
  if (pi > 0 && !(pi === PHASES.length - 1 && S.kase.verdict)) out.push(`<button class="btn small" type="button" data-act="back">Back a phase</button>`);
  if (pi < PHASES.length - 1) out.push(`<button class="btn brass small" type="button" data-act="gavel" title="Bang the gavel and mute everyone except you">Order! Order!</button>`);
  if (Object.keys(S.voiceState.muted || {}).length) out.push(`<button class="btn small" type="button" data-act="unmute-all">Unmute everyone</button>`);
  return out.join("") + settle;
}
function presideAct(a) {
  if (a === "settle") return confirmBox("Settle out of court?", "The hearing ends with no verdict. Everyone can still read the record.", "Settle", () => quiet(emit("settle", { code: S.caseId })));
  if (!canPreside()) return toast("Only the judge can do that.");
  if (a === "next") {
    if (phaseIdx() === 0 && !seated("defendant") && !S.demo) toast("Heads up: nobody has the defendant's seat yet.");
    quiet(api.phase("next"));
  } else if (a === "back") quiet(api.phase("back"));
  else if (a === "gavel") quiet(api.gavel());
  else if (a === "unmute-all") quiet(api.unmuteAll());
}

// ---------- bench / seats ----------
function micBadge(m) {
  const vs = S.voiceState, inVoice = vs.participants?.includes(m.id);
  if (vs.muted?.[m.id]) return `<span class="mic off">Muted by judge</span>`;
  if (vs.hands?.[m.id] && !canSpeakUid(m.id)) return `<span class="mic hand">Hand raised</span>`;
  if (!inVoice) return "";
  if (canSpeakUid(m.id)) return `<span class="mic on">${vs.floor?.[m.id] ? "Has the floor" : "Mic"}</span>`;
  return `<span class="mic">Listening</span>`;
}
function judgeTools(m) {
  if (S.demo || !canPreside() || m.id === S.uid || m.state !== "seated") return "";
  const vs = S.voiceState, out = [];
  if (SPEAKING.includes(m.role)) out.push(vs.muted?.[m.id] ? `<button class="btn small" type="button" data-vmute="${esc(m.id)}:0">Unmute</button>` : `<button class="btn ghost small" type="button" data-vmute="${esc(m.id)}:1">Mute</button>`);
  else out.push(vs.floor?.[m.id] ? `<button class="btn ghost small" type="button" data-vfloor="${esc(m.id)}:0">Take the floor back</button>` : `<button class="btn small ${vs.hands?.[m.id] ? "brass" : "ghost"}" type="button" data-vfloor="${esc(m.id)}:1">Give the floor</button>`);
  return out.join("");
}
function person(m, color) {
  const inVoice = S.voiceState.participants?.includes(m.id);
  return `<div class="person"><span class="av ${inVoice ? "invoice" : ""}" data-speaker="${esc(m.id)}" style="--c:${color}" title="${esc(m.nick)}">${esc(initials(m.nick))}</span><span class="nm">${esc(m.nick)}${m.id === S.uid ? ` <span class="muted">(you)</span>` : ""}</span>${micBadge(m)}${judgeTools(m)}</div>`;
}
function renderBench() {
  const el = $("#bench"); if (!el) return;
  if (!S.kase) { el.innerHTML = ""; return; }
  const k = S.kase, mine = me(), closed = ["verdict", "settled"].includes(k.status);
  const parts = ["petitioner", "defendant", "judge"].map(r => {
    if (r === "judge" && k.aiJudge) return `<div class="seat" style="--c:${ROLES.judge.c}"><div class="lab">Judge</div><div class="who">AI judge</div><div class="muted" style="font-size:13px">Reads the full record and every photo exhibit at verdict time. ${esc(k.creatorNick)} runs the hearing as court clerk.</div></div>`;
    const m = seated(r);
    const reqs = S.members.filter(x => x.role === r && x.state === "requested");
    const canAsk = !m && (!mine || !SPEAKING.includes(mine.role) || mine.state === "requested") && !closed && !(mine && mine.state === "requested");
    return `<div class="seat" style="--c:${ROLES[r].c}">
      <div class="lab">${ROLES[r].label}</div>
      ${m ? person(m, ROLES[r].c) : `<div class="who"><span class="muted">Seat open</span></div>`}
      ${canAsk ? `<div><button class="btn small" type="button" data-claim="${r}">${k.public && !isCreator() ? "Request this seat" : "Take this seat"}</button></div>` : ""}
      ${reqs.length ? `<div class="reqs">${reqs.map(q => `<div class="req"><span><b>${esc(q.nick)}</b> wants this seat</span>${isCreator() ? `<button class="btn small" type="button" data-approve="${esc(q.id)}">Approve</button><button class="btn ghost small" type="button" data-deny="${esc(q.id)}">Deny</button>` : q.id === S.uid ? `<span class="muted">Waiting for approval</span>` : ""}</div>`).join("")}</div>` : ""}
    </div>`;
  });
  const jurors = S.members.filter(m => m.role === "jury" && m.state === "seated");
  const gallery = S.members.filter(m => m.role === "gallery" && m.state === "seated");
  parts.push(`<div class="seat" style="--c:${ROLES.jury.c}">
    <div class="lab">Jury · ${jurors.length}/${k.juryMax || 0}</div>
    <div class="people">${jurors.map(j => person(j, "var(--jury)")).join("") || `<span class="muted" style="font-size:13px">${k.juryMax ? "No jurors yet" : "No jury in this case"}</span>`}</div>
    ${!mine && k.juryMax && jurors.length < k.juryMax && !closed ? `<div><button class="btn small" type="button" data-claim="jury">Join the jury</button></div>` : ""}
  </div>`);
  parts.push(`<div class="seat" style="--c:var(--muted)"><div class="lab">Gallery · ${gallery.length}</div>
    <div class="people">${gallery.map(g => person(g, "#6b7385")).join("") || `<span class="muted" style="font-size:13px">Empty benches</span>`}</div>
    ${!mine && !closed ? `<div><button class="btn small" type="button" data-claim="gallery">Watch from the gallery</button></div>` : ""}
    ${mine && !isCreator() && !S.demo ? `<div><button class="btn ghost small" type="button" id="leave">Leave my seat</button></div>` : ""}
  </div>`);
  el.innerHTML = parts.join("");
  el.querySelectorAll("[data-claim]").forEach(b => b.onclick = () => claimSeat(b.dataset.claim));
  el.querySelectorAll("[data-approve]").forEach(b => b.onclick = () => quiet(emit("seat:decide", { code: S.caseId, uid: b.dataset.approve, ok: true })));
  el.querySelectorAll("[data-deny]").forEach(b => b.onclick = () => quiet(emit("seat:decide", { code: S.caseId, uid: b.dataset.deny, ok: false })));
  el.querySelectorAll("[data-vmute]").forEach(b => b.onclick = () => { const [uid, v] = b.dataset.vmute.split(":"); quiet(emit("voice:mute", { code: S.caseId, uid, muted: v === "1" })); });
  el.querySelectorAll("[data-vfloor]").forEach(b => b.onclick = () => { const [uid, v] = b.dataset.vfloor.split(":"); quiet(emit("voice:floor", { code: S.caseId, uid, on: v === "1" })); });
  const lv = $("#leave"); if (lv) lv.onclick = () => quiet(emit("seat:leave", { code: S.caseId }));
}
function claimSeat(role) {
  askNick(async n => {
    try {
      const r = await emit("seat:claim", { code: S.caseId, role, nick: n });
      if (r.state === "requested") toast("Request sent. The case creator approves speaking seats.");
    } catch {}
  });
}

// ---------- panels ----------
function renderCasePanels() {
  if (S.view !== "case") return;
  renderBench();
  const tabs = $("#tabs"), panel = $("#panel"); if (!tabs || !panel) return;
  if (!S.kase) { tabs.innerHTML = ""; panel.innerHTML = ""; return; }
  const n = { hearing: S.msgs.filter(m => m.kind !== "system").length, evidence: S.evidence.length, jury: S.votes.length };
  const T = [["hearing", "Hearing"], ["evidence", "Evidence"], ["jury", "Jury room"], ["verdict", "Verdict"]];
  tabs.innerHTML = T.map(([k, l]) => `<button class="tab ${S.tab === k ? "on" : ""}" role="tab" aria-selected="${S.tab === k}" type="button" data-tab="${k}">${l}${n[k] ? `<span class="count">${n[k]}</span>` : ""}</button>`).join("");
  // keep drafts and focus across live updates
  const draft = $("#c-text")?.value, caption = $("#ev-cap")?.value, focused = document.activeElement?.id;
  const vform = S.tab === "verdict" && $("#vform") ? { h: $("#v-h").value, r: $("#v-r").value, sc: $("#v-sc").value, s: $("#v-s").textContent, w: document.querySelector("[name=v-w]:checked")?.value } : null;
  if (S.tab === "hearing") renderHearing(panel);
  else if (S.tab === "evidence") renderEvidence(panel);
  else if (S.tab === "jury") renderJury(panel);
  else renderVerdict(panel);
  if (draft != null && $("#c-text")) $("#c-text").value = draft;
  if (caption != null && $("#ev-cap")) $("#ev-cap").value = caption;
  if (vform && $("#vform")) { $("#v-h").value = vform.h; $("#v-r").value = vform.r; $("#v-sc").value = vform.sc; $("#v-s").textContent = vform.s; const w = document.querySelector(`[name=v-w][value="${vform.w}"]`); if (w) w.checked = true; }
  if (focused && document.getElementById(focused)) document.getElementById(focused).focus();
}

function roleOf(m) { return ROLES[m.role] || ROLES.gallery; }
function msgHTML(m) {
  const R = roleOf(m);
  if (m.kind === "system") return `<div class="msg system">${esc(m.text)}</div>`;
  if (m.kind === "gavel") return `<div class="msg gavel" style="--c:var(--judge)"><div class="body">${esc(m.text)}</div><div class="meta" style="justify-content:center">${esc(m.nick)} bangs the gavel</div></div>`;
  const ruling = m.ruling ? `<span class="ruling ${m.ruling}">${m.ruling === "sustained" ? "Sustained" : "Overruled"}</span>` : "";
  const canRule = m.kind === "objection" && !m.ruling && canPreside() && !["verdict", "settled"].includes(S.kase.status);
  const evRef = m.exhibit ? ` <span class="pill">re: Exhibit ${esc(m.exhibit)}</span>` : "";
  return `<div class="msg ${m.kind === "objection" ? "objection" : ""}" style="--c:${R.c}">
    <div class="meta"><b>${esc(m.nick)}</b><span>${R.label}</span>${m.phase ? `<span>· ${esc((PHASES[PHASE_IDX[m.phase]] || [])[1] || "")}</span>` : ""}<span>· ${m.at ? ago(m.at) : ""}</span>${evRef}</div>
    <div class="body">${m.kind === "objection" ? `Objection! ${esc(m.grounds || "")}${m.text ? ". " + esc(m.text) : ""}` : esc(m.text)}</div>
    ${ruling}${canRule ? `<div style="display:flex;gap:6px;margin-top:6px"><button class="btn small" type="button" data-rule="${esc(m.id)}:sustained">Sustain</button><button class="btn small" type="button" data-rule="${esc(m.id)}:overruled">Overrule</button></div>` : ""}
  </div>`;
}

function renderHearing(panel) {
  const k = S.kase, mine = me(), pi = phaseIdx();
  const closed = ["verdict", "settled"].includes(k.status);
  let composer;
  if (!mine) composer = `<div class="composer"><span class="muted">Take a seat on the bench to post. You can listen to the voice hearing from the bar below.</span></div>`;
  else if (mine.state === "requested") composer = `<div class="composer"><span class="muted">Your seat request is waiting for the case creator.</span></div>`;
  else if (closed) composer = `<div class="composer"><span class="muted">The record is closed.</span></div>`;
  else {
    const party = ["petitioner", "defendant"].includes(mine.role);
    composer = `<form class="composer" id="composer">
      <label for="c-text" class="eyebrow">${party ? (pi === 0 ? "The hearing starts once the judge opens it. Drafting is fine." : "Put it on the record") : mine.role === "judge" ? "From the bench" : "Whisper from the " + roleOf(mine).label.toLowerCase()}</label>
      <textarea id="c-text" maxlength="800" placeholder="${party ? "Your Honor, the timeline proves…" : mine.role === "judge" ? "The court will hear the defendant now." : "Honestly the fries thing is unforgivable"}"></textarea>
      <div class="row">
        ${party ? `<select id="c-kind" aria-label="Message type"><option value="statement">Statement</option><option value="objection">Objection</option></select>
        <select id="c-grounds" aria-label="Grounds">${GROUNDS.map(g => `<option>${esc(g)}</option>`).join("")}</select>` : ""}
        ${S.evidence.length ? `<select id="c-ex" aria-label="Refer to exhibit"><option value="">No exhibit</option>${S.evidence.map(e => `<option value="${esc(e.exhibit)}">Exhibit ${esc(e.exhibit)}</option>`).join("")}</select>` : ""}
        <button class="btn primary" type="submit" style="margin-left:auto">${party ? "Submit" : "Post"}</button>
      </div>
    </form>`;
  }
  const feedEl = $("#feed");
  const atBottom = !feedEl || feedEl.scrollHeight - feedEl.scrollTop - feedEl.clientHeight < 40;
  panel.innerHTML = `<div class="feed" id="feed" aria-live="polite">${S.msgs.length ? S.msgs.map(msgHTML).join("") : `<div class="empty">The courtroom is quiet. Statements, objections and rulings appear here.</div>`}</div>${composer}`;
  const feed = $("#feed"); if (atBottom) feed.scrollTop = feed.scrollHeight;
  feed.querySelectorAll("[data-rule]").forEach(b => b.onclick = () => { const [id, r] = b.dataset.rule.split(":"); quiet(api.rule(id, r)); });
  const f = $("#composer");
  if (!f) return;
  const kind = $("#c-kind"), grounds = $("#c-grounds");
  const sync = () => { if (grounds) grounds.hidden = kind.value !== "objection"; };
  if (kind) { kind.onchange = sync; sync(); }
  f.onsubmit = async e => {
    e.preventDefault();
    const text = $("#c-text").value.trim(), isObj = kind && kind.value === "objection";
    if (!text && !isObj) return;
    const m = { kind: isObj ? "objection" : SPEAKING.includes(mine.role) ? "statement" : "gallery", text };
    if (isObj) m.grounds = grounds.value;
    const ex = $("#c-ex")?.value; if (ex) m.exhibit = ex;
    try { await api.addMsg(m); if ($("#c-text")) $("#c-text").value = ""; const fd = $("#feed"); if (fd) fd.scrollTop = fd.scrollHeight; } catch {}
  };
  $("#c-text").onkeydown = e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) f.requestSubmit(); };
}

// ---------- evidence ----------
function renderEvidence(panel) {
  const mine = me(), k = S.kase;
  const canSubmit = mine && mine.state === "seated" && SPEAKING.includes(mine.role) && !["verdict", "settled", "deliberation"].includes(k.status);
  const counts = id => { const ms = S.marks.filter(x => x.evid === id); return { c: ms.filter(x => x.val === "credible").length, s: ms.filter(x => x.val === "sus").length, mine: ms.find(x => x.uid === S.uid)?.val }; };
  const canMark = mine && mine.state === "seated";
  panel.innerHTML = `
  ${canSubmit ? `<div class="drop" id="drop">
    <div><b>Submit photo evidence</b> <span class="muted" style="font-size:13px">Screenshots, receipts, crime-scene photos. Drop, paste, or pick a file.</span></div>
    ${S.pendingImg ? `<img class="prev" src="${S.pendingImg.preview}" alt="Preview of the photo you're submitting">` : ""}
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <label class="btn small" for="ev-file" style="cursor:pointer">${S.pendingImg ? "Choose a different photo" : "Choose photo"}</label>
      <input type="file" id="ev-file" accept="image/*" hidden>
      <input type="text" id="ev-cap" maxlength="160" placeholder="What does this prove? e.g. the empty fries box, 11:52 pm" style="flex:1 1 220px">
      <button class="btn primary small" type="button" id="ev-submit" ${S.pendingImg ? "" : "disabled"}>Enter as Exhibit ${letter(S.evidence.length)}</button>
    </div>
  </div>` : `<p class="muted" style="margin-top:0">${["verdict", "settled", "deliberation"].includes(k.status) ? "Evidence is closed. The jury weighs what's here." : "Only the petitioner, defendant and judge can enter exhibits. Anyone seated can mark them credible or sus."}</p>`}
  ${S.evidence.length ? `<div class="ev-grid">${S.evidence.map(e => {
    const R = ROLES[e.role] || ROLES.gallery, ct = counts(e.id);
    return `<article class="ev">
      <button class="img" type="button" data-zoom="${esc(e.id)}" aria-label="Open Exhibit ${esc(e.exhibit)} full size"><img src="${esc(e.url)}" alt="Exhibit ${esc(e.exhibit)}: ${esc(e.caption || "photo evidence")}" loading="lazy"></button>
      <div class="in">
        <div style="display:flex;justify-content:space-between;gap:6px;align-items:baseline"><span class="tag">EXHIBIT ${esc(e.exhibit)}</span><span style="font-size:12px;color:${R.c};font-weight:600">${esc(e.nick)} · ${R.label}</span></div>
        <div class="cap">${esc(e.caption || "No caption")}</div>
        <div class="marks">
          <button class="btn small ${ct.mine === "credible" ? "brass" : ""}" type="button" ${canMark ? "" : "disabled"} data-mark="${esc(e.id)}:credible" aria-pressed="${ct.mine === "credible"}">Credible ${ct.c}</button>
          <button class="btn small ${ct.mine === "sus" ? "brass" : ""}" type="button" ${canMark ? "" : "disabled"} data-mark="${esc(e.id)}:sus" aria-pressed="${ct.mine === "sus"}">Sus ${ct.s}</button>
        </div>
      </div></article>`;
  }).join("")}</div>` : `<div class="empty">No exhibits yet. A picture of the crime scene is worth a thousand objections.</div>`}`;
  panel.querySelectorAll("[data-zoom]").forEach(b => b.onclick = () => { const e = S.evidence.find(x => x.id === b.dataset.zoom); if (e) lightbox(e); });
  panel.querySelectorAll("[data-mark]").forEach(b => b.onclick = () => { const [id, v] = b.dataset.mark.split(":"); quiet(api.mark(id, counts(id).mine === v ? null : v)); });
  if (canSubmit) {
    const drop = $("#drop");
    $("#ev-file").onchange = e => pickImage(e.target.files[0]);
    drop.ondragover = e => { e.preventDefault(); drop.classList.add("over"); };
    drop.ondragleave = () => drop.classList.remove("over");
    drop.ondrop = e => { e.preventDefault(); drop.classList.remove("over"); pickImage(e.dataTransfer.files[0]); };
    $("#ev-submit").onclick = submitEvidence;
  }
}
document.addEventListener("paste", e => {
  if (S.view !== "case" || S.tab !== "evidence" || !$("#drop")) return;
  const f = [...(e.clipboardData?.files || [])].find(x => x.type.startsWith("image/"));
  if (f) { e.preventDefault(); pickImage(f); }
});
function shrink(file, max, q) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => {
      const s = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement("canvas"); c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
      c.toBlob(b => b ? res({ blob: b, dataUrl: c.toDataURL("image/jpeg", q) }) : rej(new Error("encode")), "image/jpeg", q);
    };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error("decode")); };
    img.src = url;
  });
}
async function pickImage(file) {
  if (!file) return;
  if (!file.type.startsWith("image/")) return toast("Evidence has to be an image file.");
  try { const r = await shrink(file, 1600, 0.85); S.pendingImg = { blob: r.blob, preview: r.dataUrl }; renderCasePanels(); }
  catch { toast("Couldn't read that image. Try a JPG or PNG."); }
}
async function submitEvidence() {
  const p = S.pendingImg; if (!p) return;
  const btn = $("#ev-submit"); btn.disabled = true; btn.textContent = "Entering into the record…";
  const caption = $("#ev-cap").value.trim();
  try {
    let url = p.preview;
    if (!S.demo) {
      const r = await fetch("/api/upload", { method: "POST", headers: { "content-type": "image/jpeg", "x-court-key": key }, body: p.blob });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "Upload failed.");
      url = j.url;
    }
    await api.addEvidence({ url, caption });
    S.pendingImg = null; if ($("#ev-cap")) $("#ev-cap").value = ""; renderCasePanels(); toast("Exhibit entered");
  } catch (e) {
    if (e.message && e.message !== "offline") toast(e.message);
    const b = $("#ev-submit"); if (b) { b.disabled = false; b.textContent = `Enter as Exhibit ${letter(S.evidence.length)}`; }
  }
}
function lightbox(e) {
  const L = $("#layer");
  L.innerHTML = `<div class="lightbox" id="lb" role="dialog" aria-label="Exhibit ${esc(e.exhibit)}"><figure><img src="${esc(e.url)}" alt="Exhibit ${esc(e.exhibit)}"><figcaption style="margin-top:10px"><b class="mono">EXHIBIT ${esc(e.exhibit)}</b> · ${esc(e.caption || "")} <span style="opacity:.7">(submitted by ${esc(e.nick)})</span></figcaption></figure></div>`;
  const close = () => { L.innerHTML = ""; document.removeEventListener("keydown", k); };
  const k = ev => { if (ev.key === "Escape") close(); };
  $("#lb").onclick = close; document.addEventListener("keydown", k);
}

// ---------- jury ----------
function renderJury(panel) {
  const k = S.kase, mine = me();
  const p = S.votes.filter(v => v.side === "petitioner").length, d = S.votes.filter(v => v.side === "defendant").length, tot = p + d;
  const myVote = S.votes.find(v => v.id === S.uid)?.side;
  const isJuror = mine && mine.role === "jury" && mine.state === "seated";
  const open = k.status === "deliberation";
  const pn = seated("petitioner")?.nick || "Petitioner", dn = seated("defendant")?.nick || "Defendant";
  const showTally = !open || !isJuror || !!myVote || canPreside();
  const jurorCount = S.members.filter(m => m.role === "jury" && m.state === "seated").length;
  panel.innerHTML = `
  <div class="panel" style="display:grid;gap:12px">
    <div><div class="eyebrow">Jury room</div><h3 style="margin-top:4px">${k.juryMax ? "Who's in the right?" : "This case has no jury"}</h3></div>
    ${!k.juryMax ? `<p class="muted" style="margin:0">The judge decides alone.</p>` : `
    <p class="muted" style="margin:0">${open ? (isJuror ? "Vote once. You can change it until the verdict." : "Jurors are voting now.") : phaseIdx() < 4 ? "Voting opens at jury deliberation. Until then, listen to the hearing and mark the evidence." : "Voting is closed."}</p>
    ${isJuror && open ? `<div class="votebtns">
      <button class="btn ${myVote === "petitioner" ? "primary" : ""}" type="button" data-vote="petitioner" aria-pressed="${myVote === "petitioner"}">${esc(pn)} is right</button>
      <button class="btn ${myVote === "defendant" ? "primary" : ""}" type="button" data-vote="defendant" aria-pressed="${myVote === "defendant"}">${esc(dn)} is right</button>
    </div>` : ""}
    ${showTally && tot ? `<div><div class="tally" aria-label="Vote tally">
        <div style="flex:${p || 0.0001};background:var(--pet)">${p ? esc(pn) + " " + p : ""}</div>
        <div style="flex:${d || 0.0001};background:var(--def)">${d ? esc(dn) + " " + d : ""}</div></div>
        <div class="muted" style="font-size:13px">${tot} of ${jurorCount} jurors have voted.</div></div>`
      : !showTally ? `<div class="muted" style="font-size:13px">Cast your vote to see the tally.</div>` : `<div class="muted" style="font-size:13px">No votes yet.</div>`}`}
  </div>`;
  panel.querySelectorAll("[data-vote]").forEach(b => b.onclick = () => quiet(api.vote(b.dataset.vote)));
}

// ---------- verdict ----------
function renderVerdict(panel) {
  const k = S.kase, v = k.verdict;
  const pn = seated("petitioner")?.nick || "the petitioner", dn = seated("defendant")?.nick || "the defendant";
  if (v) {
    const who = { petitioner: `In favour of ${pn}`, defendant: `In favour of ${dn}`, both: "Both parties share the blame", neither: "Nobody wins this one" }[v.winner] || "";
    panel.innerHTML = `<div class="cert">
      <div class="eyebrow">Petty Court · Case #${esc(S.caseId)} · ${v.by === "ai" ? "Ruling of the AI judge" : "Ruling of Judge " + esc(v.judgeNick || "")}</div>
      <div class="h">${esc(v.headline || "The court has ruled")}</div>
      <div class="winner">${esc(who)}</div>
      ${v.reasoning ? `<div class="reason">${esc(v.reasoning)}</div>` : ""}
      ${v.sentence ? `<div><div class="eyebrow" style="margin-top:10px">Sentence</div><div class="sentence">${esc(v.sentence)}</div></div>` : ""}
      ${v.jury && (v.jury.p || v.jury.d) ? `<p class="muted" style="font-size:13px;margin-bottom:0">Jury voted ${v.jury.p}–${v.jury.d}.</p>` : ""}
    </div>
    ${canPreside() ? `<div style="margin-top:10px"><button class="btn ghost small" type="button" id="redo">Withdraw ruling and reconsider</button></div>` : ""}`;
    const r = $("#redo"); if (r) r.onclick = () => quiet(api.clearVerdict());
    return;
  }
  if (k.status !== "verdict") {
    panel.innerHTML = `<div class="empty">The verdict comes after jury deliberation. ${canPreside() ? "Use the buttons up top to move the hearing along." : "The judge moves the hearing along."}</div>`; return;
  }
  const p = S.votes.filter(x => x.side === "petitioner").length, d = S.votes.filter(x => x.side === "defendant").length;
  if (k.aiJudge) {
    const canAsk = isCreator() || ["petitioner", "defendant"].includes(me()?.role);
    panel.innerHTML = `<div class="panel" style="display:grid;gap:10px">
      <div class="eyebrow">AI judge</div><h3>The record is ready for the bench</h3>
      <p class="muted" style="margin:0">The AI judge reads every statement, objection and ruling, looks at the photo exhibits, and weighs the jury vote (${p}–${d}). It can't hear the voice hearing, so put key arguments in writing.</p>
      ${canAsk ? `<div><button class="btn primary" type="button" id="ai-rule" ${k.aiBusy ? "disabled" : ""}>${k.aiBusy ? "The judge is deliberating…" : "Ask the AI judge to rule"}</button></div>`
        : `<p class="muted" style="margin:0">${k.aiBusy ? "The judge is deliberating…" : "The parties call the AI judge in."}</p>`}
    </div>`;
    const b = $("#ai-rule"); if (b) b.onclick = () => quiet(emit("verdict:ai", { code: S.caseId }));
    return;
  }
  if (seated("judge")?.id !== S.uid) {
    panel.innerHTML = `<div class="empty">Waiting for ${seated("judge") ? "Judge " + esc(seated("judge").nick) : "the judge"} to rule. Jury voted ${p}–${d}.</div>`; return;
  }
  panel.innerHTML = `<form class="form panel" id="vform">
    <div><div class="eyebrow">From the bench</div><h3 style="margin-top:4px">Deliver the verdict</h3><p class="muted" style="margin:6px 0 0">Jury voted ${esc(pn)} ${p} – ${d} ${esc(dn)}.</p></div>
    <div class="radios">
      <label><input type="radio" name="v-w" value="petitioner" ${p >= d ? "checked" : ""}> ${esc(pn)} wins</label>
      <label><input type="radio" name="v-w" value="defendant" ${d > p ? "checked" : ""}> ${esc(dn)} wins</label>
      <label><input type="radio" name="v-w" value="both"> Both to blame</label>
      <label><input type="radio" name="v-w" value="neither"> Case dismissed</label>
    </div>
    <label for="v-h">Headline<input type="text" id="v-h" maxlength="80" placeholder="Guilty of first-degree fry theft"></label>
    <label for="v-r">Reasoning<textarea id="v-r" maxlength="1000" placeholder="Exhibit A shows an empty box. The defendant's 'just one fry' defence collapses under the jury's own eyes."></textarea></label>
    <div><div style="font-weight:600;font-size:14px;margin-bottom:6px">Sentence</div>
      <div class="wheel"><output id="v-s" aria-live="polite">${esc(SENTENCES[0])}</output><button class="btn brass small" type="button" id="spin">Spin the punishment wheel</button></div>
      <label for="v-sc" style="margin-top:8px">Or write your own<input type="text" id="v-sc" maxlength="140" placeholder="Leave empty to use the wheel"></label></div>
    <div><button class="btn primary" type="submit">Bang the gavel</button></div>
  </form>`;
  $("#spin").onclick = () => {
    const o = $("#v-s"); let i = 0;
    const end = SENTENCES[Math.floor(Math.random() * SENTENCES.length)];
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) { o.textContent = end; return; }
    const t = setInterval(() => { o.textContent = SENTENCES[i++ % SENTENCES.length]; if (i > 14) { clearInterval(t); o.textContent = end; } }, 70);
  };
  $("#vform").onsubmit = e => {
    e.preventDefault();
    quiet(api.verdict({
      winner: document.querySelector("[name=v-w]:checked").value, headline: $("#v-h").value.trim() || "The court has ruled",
      reasoning: $("#v-r").value.trim(), sentence: $("#v-sc").value.trim() || $("#v-s").textContent, jury: { p, d }
    }));
  };
}

// ---------- voice dock ----------
function renderDock() {
  const d = $("#dock");
  if (S.view !== "case" || !S.kase) { d.hidden = true; return; }
  d.hidden = false;
  if (S.demo) {
    d.className = "dock";
    d.innerHTML = `<div class="in"><div class="state"><span class="dot"></span><div class="txt"><b>Voice is off in practice</b><span>Real courtrooms have live voice. File a case and invite a friend to try it.</span></div></div></div>`;
    return;
  }
  const n = S.voiceState.participants?.length || 0, mine = me();
  const allowed = canSpeakUid(S.uid), mutedByJudge = !!S.voiceState.muted?.[S.uid], hand = !!S.voiceState.hands?.[S.uid];
  d.className = "dock" + (voice.joined ? " on" : "");
  let title, sub, acts = [];
  if (!voice.joined) {
    title = n ? `${n} ${n === 1 ? "person is" : "people are"} talking in this courtroom` : "Voice courtroom";
    sub = mine && SPEAKING.includes(mine.role) && mine.state === "seated" ? "You hold a speaking seat. Join to argue out loud." : "Join to listen. The judge gives the floor to jurors and the gallery.";
    acts.push(`<button class="btn live" type="button" id="v-join" ${voice.joining ? "disabled" : ""}>${voice.joining ? "Joining…" : "Join voice"}</button>`);
  } else {
    if (mutedByJudge) { title = "The judge muted you"; sub = "You can still hear the hearing."; }
    else if (allowed && voice.selfMuted) { title = "You're muted"; sub = "Unmute when it's your turn to speak."; }
    else if (allowed) { title = S.voiceState.floor?.[S.uid] ? "You have the floor" : "You're live"; sub = `${n} in voice. Everyone in voice can hear you.`; }
    else { title = "Listening"; sub = mine?.state === "seated" ? (hand ? "Hand raised. Waiting for the judge." : "Raise your hand to ask the judge for the floor.") : "Take a seat to raise your hand."; }
    const L = voice.links(), others = L.direct + L.relay + L.connecting;
    if (!others) sub = "Nobody else is in voice yet. Share the invite link.";
    else {
      const parts = [];
      if (L.direct + L.relay) parts.push(`Connected to ${L.direct + L.relay} of ${others}`);
      if (L.connecting) parts.push(`connecting to ${L.connecting}…`);
      if (L.relay) parts.push(`${L.relay === L.direct + L.relay ? "all" : L.relay} through the server. Headphones stop echo`);
      sub = (allowed && !voice.selfMuted && !mutedByJudge ? "" : sub + " ") + parts.join(" · ") + ".";
    }
    if (allowed) acts.push(`<button class="btn ${voice.selfMuted ? "primary" : ""}" type="button" id="v-mute">${voice.selfMuted ? "Unmute" : "Mute"}</button>`);
    else if (mine?.state === "seated" && !mutedByJudge) acts.push(`<button class="btn ${hand ? "brass" : ""}" type="button" id="v-hand">${hand ? "Lower hand" : "Raise hand"}</button>`);
    acts.push(`<button class="btn ghost" type="button" id="v-leave">Leave voice</button>`);
  }
  d.innerHTML = `<div class="in"><div class="state"><span class="dot" aria-hidden="true"></span>${voice.joined && S.uid ? `<span class="av" data-speaker="${esc(S.uid)}" style="--c:var(--live)">${esc(initials(mine?.nick || nick || "You"))}</span>` : ""}<div class="txt"><b>${esc(title)}</b><span>${esc(sub)}</span></div></div><div class="acts">${acts.join("")}</div></div>`;
  const j = $("#v-join"); if (j) j.onclick = () => voice.join(S.caseId);
  const m = $("#v-mute"); if (m) m.onclick = () => voice.toggleSelfMute();
  const h = $("#v-hand"); if (h) h.onclick = () => quiet(emit("voice:hand", { code: S.caseId, up: !hand }));
  const l = $("#v-leave"); if (l) l.onclick = () => voice.leave();
}

// ---------- schedule & invite ----------
function planBox() {
  const k = S.kase, L = $("#layer");
  const roles = ["defendant", "petitioner", "judge", "jury", "gallery"].filter(r =>
    (r !== "judge" || !k.aiJudge) && (r !== "jury" || k.juryMax) && (!SPEAKING.includes(r) || !seated(r)));
  const first = roles[0];
  L.innerHTML = `<div class="modal-bg"><div class="modal plan" role="dialog" aria-label="Schedule and invite">
    <div style="display:flex;justify-content:space-between;align-items:start;gap:10px"><div><div class="eyebrow">Case #${esc(S.caseId)}</div><h3 style="margin-top:4px">Schedule &amp; invite</h3></div><button class="btn ghost small" type="button" id="pl-x">Close</button></div>
    <form class="form" id="sch-form">
      <label for="sch-at">Hearing date and time <span class="hint">Everyone sees it in their own time zone.</span>
        <input type="datetime-local" id="sch-at" required value="${k.scheduledAt ? toLocalInput(k.scheduledAt) : ""}" min="${toLocalInput(Date.now())}"></label>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn primary small" type="submit">${k.scheduledAt ? "Update time" : "Schedule hearing"}</button>${k.scheduledAt ? `<button class="btn ghost small" type="button" id="sch-clear">Clear time</button>` : ""}</div>
    </form>
    <hr>
    ${roles.length ? `<div class="form">
      <div><div style="font-weight:600;font-size:14px;margin-bottom:6px">Invite someone as</div>
        <div class="radios" id="inv-roles">${roles.map(r => `<label><input type="radio" name="inv-role" value="${r}" ${r === first ? "checked" : ""}> ${ROLES[r].label}</label>`).join("")}</div></div>
      <label for="inv-name">Their name <span class="hint">Optional. Used in the message.</span><input type="text" id="inv-name" maxlength="24" placeholder="Kabir"></label>
      <label for="inv-msg">Invite message<textarea id="inv-msg" rows="7" readonly>Making the invite link…</textarea></label>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn primary small" type="button" id="inv-copy">Copy message</button>
        <a class="btn small" id="inv-wa" href="#" target="_blank" rel="noopener">Send on WhatsApp</a>
        <a class="btn small" id="inv-mail" href="#">Send by email</a>
        ${navigator.share ? `<button class="btn small" type="button" id="inv-share">Share…</button>` : ""}
      </div>
      <p class="muted" style="margin:0;font-size:13px">Whoever opens this link is offered the ${"<b id=\"inv-rolename\"></b>"} seat directly${k.public ? ", without waiting for your approval" : ""}. Speaking seats go to the first person who takes them.</p>
    </div>` : `<p class="muted">Every speaking seat is taken and there's no room left to invite into. Share the room code for people to watch.</p>`}
  </div></div>`;
  $("#pl-x").onclick = () => L.innerHTML = "";
  $("#sch-form").onsubmit = async e => {
    e.preventDefault();
    const at = new Date($("#sch-at").value).getTime();
    if (!at) return toast("Pick a date and time.");
    try { await emit("case:schedule", { code: S.caseId, at }); toast("Hearing scheduled for " + fmtWhen(at)); L.innerHTML = ""; } catch {}
  };
  const clr = $("#sch-clear"); if (clr) clr.onclick = async () => { try { await emit("case:schedule", { code: S.caseId, at: null }); toast("Hearing time cleared"); L.innerHTML = ""; } catch {} };
  if (!roles.length) return;
  S.inviteTokens ||= {};
  let current = { text: "", link: "" };
  const build = async () => {
    const role = document.querySelector("[name=inv-role]:checked").value;
    $("#inv-rolename").textContent = ROLES[role].label.toLowerCase();
    let token = S.inviteTokens[S.caseId + role];
    if (!token) {
      try { token = (await emit("invite:create", { code: S.caseId, role })).token; S.inviteTokens[S.caseId + role] = token; }
      catch { $("#inv-msg").value = "Couldn't make the invite link. Check your connection and try again."; return; }
    }
    const name = $("#inv-name").value.trim();
    const link = caseLink({ role, token });
    const seat = role === "jury" ? "a seat on the jury" : role === "gallery" ? "a seat in the gallery" : `the ${ROLES[role].label.toLowerCase()}'s seat`;
    const text = [
      `${name ? name + ", you're" : "You're"} summoned to Petty Court!`,
      ``,
      `Case: "${k.title}" (#${S.caseId})`,
      `Your seat: ${seat}`,
      k.scheduledAt ? `Hearing: ${fmtWhen(k.scheduledAt, true)}` : `Hearing: as soon as everyone's in`,
      ``,
      `Take your seat here: ${link}`
    ].join("\n");
    current = { text, link };
    $("#inv-msg").value = text;
    $("#inv-wa").href = "https://wa.me/?text=" + encodeURIComponent(text);
    $("#inv-mail").href = `mailto:?subject=${encodeURIComponent(`You're summoned to Petty Court: ${k.title}`)}&body=${encodeURIComponent(text)}`;
  };
  $("#inv-roles").onchange = build;
  $("#inv-name").oninput = build;
  $("#inv-copy").onclick = async () => {
    try { await navigator.clipboard.writeText(current.text); toast("Invite copied. Paste it into any chat."); }
    catch { $("#inv-msg").select(); toast("Select the message and copy it."); }
  };
  const sh = $("#inv-share");
  if (sh) sh.onclick = () => navigator.share({ title: "Petty Court summons", text: current.text }).catch(() => {});
  build();
}

// Someone opened a role invite link: offer them that seat.
function maybeOfferInvite() {
  const inv = S.invite;
  if (!inv || !S.kase || S.invite.shown) return;
  if (me()) { S.invite = null; return; }
  inv.shown = true;
  const k = S.kase, L = $("#layer");
  const taken = SPEAKING.includes(inv.role) && seated(inv.role);
  const closed = ["verdict", "settled"].includes(k.status);
  const seat = inv.role === "jury" ? "on the jury" : inv.role === "gallery" ? "in the gallery" : `as the ${ROLES[inv.role].label.toLowerCase()}`;
  L.innerHTML = `<div class="modal-bg"><div class="modal" role="dialog" aria-label="Court summons">
    <div class="eyebrow">Court summons · Case #${esc(S.caseId)}</div>
    <h3 style="margin-block:6px 8px">You're invited to sit ${esc(seat)}</h3>
    <p style="margin:0 0 6px"><b>${esc(k.title)}</b></p>
    ${k.scheduledAt ? `<p class="muted" style="margin:0 0 12px">Hearing: ${esc(fmtWhen(k.scheduledAt, true))} (${esc(untilText(k.scheduledAt))})</p>` : ""}
    ${closed ? `<p class="muted">This hearing is already over. You can still read the record.</p>` : taken ? `<p class="muted">Someone already took that seat. You can still join the jury or watch from the gallery.</p>` : ""}
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
      ${!closed && !taken ? `<button class="btn primary" type="button" id="inv-take">Take the seat</button>` : ""}
      <button class="btn ghost" type="button" id="inv-later">${!closed && !taken ? "Just look around" : "OK"}</button>
    </div>
  </div></div>`;
  $("#inv-later").onclick = () => { L.innerHTML = ""; S.invite = null; };
  const take = $("#inv-take");
  if (take) take.onclick = () => {
    L.innerHTML = "";
    askNick(async n => {
      try {
        const r = await emit("seat:claim", { code: S.caseId, role: inv.role, nick: n, invite: inv.token });
        S.invite = null;
        toast(r.state === "requested" ? "Request sent. The case creator approves speaking seats." : "You're seated. Join voice at the bottom of the screen when the hearing starts.");
      } catch {}
    });
  };
}

// ---------- modals ----------
function askNick(cb) {
  const L = $("#layer");
  L.innerHTML = `<div class="modal-bg"><form class="modal form" id="nickform" role="dialog" aria-label="Your court name">
    <div><div class="eyebrow">Before you sit</div><h3 style="margin-top:4px">What should the court call you?</h3></div>
    <label for="nick-in">Nickname<input type="text" id="nick-in" maxlength="24" required value="${esc(nick)}"></label>
    <div class="radios"><label><input type="checkbox" id="nick-ok" required> I'm here willingly and will keep the drama friendly.</label></div>
    <div style="display:flex;gap:8px"><button class="btn primary" type="submit">Take the seat</button><button class="btn ghost" type="button" id="nick-x">Cancel</button></div>
  </form></div>`;
  $("#nick-in").focus();
  $("#nick-x").onclick = () => L.innerHTML = "";
  $("#nickform").onsubmit = e => { e.preventDefault(); nick = $("#nick-in").value.trim(); if (!nick) return; ls.set("nick", nick); L.innerHTML = ""; cb(nick); };
}
function confirmBox(title, body, okLabel, onOk) {
  const L = $("#layer");
  L.innerHTML = `<div class="modal-bg"><div class="modal" role="dialog" aria-label="${esc(title)}"><h3>${esc(title)}</h3><p class="muted">${esc(body)}</p>
    <div style="display:flex;gap:8px"><button class="btn primary" type="button" id="cb-ok">${esc(okLabel)}</button><button class="btn ghost" type="button" id="cb-x">Cancel</button></div></div></div>`;
  $("#cb-x").onclick = () => L.innerHTML = "";
  $("#cb-ok").onclick = () => { L.innerHTML = ""; onOk(); };
}

// ---------- practice hearing ----------
function receiptImage() {
  const c = document.createElement("canvas"); c.width = 640; c.height = 480; const g = c.getContext("2d");
  g.fillStyle = "#6b4a2b"; g.fillRect(0, 0, 640, 480);
  g.fillStyle = "#d8322f"; g.beginPath(); g.moveTo(200, 140); g.lineTo(440, 140); g.lineTo(410, 400); g.lineTo(230, 400); g.closePath(); g.fill();
  g.fillStyle = "#f2c230"; g.font = "bold 44px Georgia"; g.textAlign = "center"; g.fillText("FRIES", 320, 290);
  g.fillStyle = "rgba(255,255,255,.9)"; g.font = "bold 22px monospace"; g.textAlign = "left"; g.fillText("11:52 PM  ·  0 fries remaining", 24, 452);
  return c.toDataURL("image/jpeg", 0.85);
}
function startDemo() {
  voice.leave();
  if (S.caseId && !S.demo) quiet(emit("case:close", {}));
  const now = Date.now(), t = n => now - n * 60000, uid = S.realUid || "me";
  try { history.replaceState(null, "", location.pathname); } catch {}
  Object.assign(S, {
    view: "case", demo: true, caseId: "FR1ES8", tab: "hearing", pendingImg: null, caseMissing: false, uid,
    kase: { title: "The People v. the guy who \"just tasted one\" fry", category: "Food crimes", public: false, aiJudge: false, juryMax: 5, status: "arguments", createdBy: "p1", creatorNick: "Riya", createdAt: t(40), verdict: null },
    voiceState: { muted: {}, floor: {}, hands: { j2: now }, participants: [] },
    members: [
      { id: "p1", nick: "Riya", role: "petitioner", state: "seated" },
      { id: "d1", nick: "Kabir", role: "defendant", state: "seated" },
      { id: uid, nick: nick || "You", role: "judge", state: "seated" },
      { id: "j1", nick: "Ananya", role: "jury", state: "seated" }, { id: "j2", nick: "Dev", role: "jury", state: "seated" },
      { id: "j3", nick: "Meher", role: "jury", state: "seated" }, { id: "j4", nick: "Arjun S", role: "jury", state: "seated" },
      { id: "g1", nick: "Tanvi", role: "gallery", state: "seated" }
    ],
    msgs: [
      { id: "a", kind: "statement", role: "petitioner", nick: "Riya", phase: "opening", at: t(30), text: "Your Honor, I went to wash my hands. I came back 90 seconds later to an empty box. Kabir was the only person at the table." },
      { id: "b", kind: "statement", role: "defendant", nick: "Kabir", phase: "opening", at: t(28), text: "I tasted ONE fry to check if they were cold. Quality control. A public service." },
      { id: "c", kind: "system", text: "Riya enters Exhibit A into evidence: the empty box, 11:52 pm.", at: t(22) },
      { id: "d", kind: "statement", role: "petitioner", nick: "Riya", phase: "arguments", exhibit: "A", at: t(15), text: "Exhibit A shows zero fries. One fry does not empty a medium box." },
      { id: "e", kind: "objection", role: "defendant", nick: "Kabir", grounds: "Speculation", phase: "arguments", at: t(14), text: "She doesn't know how many fries were in there to begin with" },
      { id: "f", kind: "gallery", role: "jury", nick: "Dev", phase: "arguments", at: t(12), text: "there's salt on his hoodie. just saying." },
      { id: "g", kind: "objection", role: "petitioner", nick: "Riya", grounds: "That's just petty", phase: "arguments", at: t(9), text: "He's calling it quality control" }
    ],
    evidence: [{ id: "ev1", exhibit: "A", caption: "The empty box, 11:52 pm. One ketchup packet survived.", nick: "Riya", role: "petitioner", url: receiptImage(), at: t(22) }],
    marks: [{ id: "x1", evid: "ev1", uid: "j1", val: "credible" }, { id: "x2", evid: "ev1", uid: "j2", val: "credible" }, { id: "x3", evid: "ev1", uid: "j3", val: "sus" }],
    votes: [{ id: "j1", side: "petitioner" }, { id: "j2", side: "petitioner" }, { id: "j3", side: "defendant" }, { id: "j4", side: "petitioner" }]
  });
  render();
}

// ---------- routing ----------
function go(v) {
  if (S.view === "case" && !S.demo) { voice.leave(); quiet(emit("case:close", {})); }
  Object.assign(S, { demo: false, uid: S.realUid, caseId: null, kase: null, view: v });
  try { history.replaceState(null, "", location.pathname); } catch {}
  render();
}
$("#brand").onclick = () => go("home");
$("#nav-home").onclick = () => go("home");
$("#nav-file").onclick = () => go("file");
$("#nav-demo").onclick = startDemo;
window.addEventListener("hashchange", () => {
  const h = parseHash();
  if (h && (h.code !== S.caseId || h.invite)) openCase(h.code, { invite: h.invite });
});

// Local debugging only.
if (["localhost", "127.0.0.1"].includes(location.hostname)) window.__court = { S, voice, emit };

const start = parseHash();
if (start) openCase(start.code, { invite: start.invite }); else render();
})();
