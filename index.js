// Time Tracker — projects, tags, a pausable timer, history and statistics.
// Everything is stored in this browser's localStorage.

const STORE_KEY = "timetracker.v2";
const DAY_MS = 86400000;
const COLORS = ["#e53935", "#ff7a1a", "#ffd60a", "#2bd52b", "#1ec8a0", "#1ea7ff", "#5b6cff", "#a35bff", "#ff5bd1", "#ff5577", "#9e9e9e"];

// Tags come in two kinds: "activity" tags (what you're doing) are listed first and
// lead the auto-filled task name; "content" tags (what you're doing it with) follow.
const DEFAULT_TAGS = [
  ["Watching", "#5b6cff", "activity"], ["Listening", "#1ea7ff", "activity"], ["Reading", "#2bd52b", "activity"],
  ["Mining", "#e53935", "activity"], ["OCR Mining", "#ff5bd1", "activity"],
  ["YouTube", "#e53935", "content"], ["Anime", "#ff5577", "content"], ["Podcast", "#1ec8a0", "content"],
  ["Audiobook", "#ff7a1a", "content"], ["Book", "#ffd60a", "content"], ["Manga", "#a35bff", "content"],
];
const ACTIVITY_NAMES = new Set(DEFAULT_TAGS.filter((t) => t[2] === "activity").map((t) => t[0].toLowerCase()));

// ---------- state ----------
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

function freshState() {
  const projectId = uid();
  return {
    projects: [{ id: projectId, name: "Learning Japanese", color: "#e53935" }],
    tags: DEFAULT_TAGS.map(([name, color, kind]) => ({ id: uid(), projectId, name, color, kind })),
    entries: [], // {id, projectId, title, tagIds, start, end, pausedMs}
    running: null, // {id, projectId, title, tagIds, start, pausedMs, pausedAt}
    currentProjectId: projectId,
    draftTagIds: [],
  };
}

function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s && Array.isArray(s.projects) && s.projects.length) {
      // Older saves have no tag kinds: treat the known activity words as activities.
      for (const t of s.tags) if (!t.kind) t.kind = ACTIVITY_NAMES.has(t.name.toLowerCase()) ? "activity" : "content";
      if (s.running && !s.running.id) s.running.id = uid(); // recorded before running timers had ids
      return s;
    }
  } catch { /* fall through */ }
  return freshState();
}

let state = loadState();
// Returns false if the data couldn't be stored.
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); return true; } catch { return false; }
}

let activeTab = "timer";
let visibleDays = 14;

// ---------- helpers ----------
const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, "0");
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const project = () => state.projects.find((p) => p.id === state.currentProjectId) || state.projects[0];
const isActivity = (t) => t.kind === "activity";
// Activities first, then content; otherwise keep the order the tags were created in.
const byKind = (a, b) => isActivity(b) - isActivity(a);
const projectTags = (pid = state.currentProjectId) => state.tags.filter((t) => t.projectId === pid).sort(byKind);
const tagById = (id) => state.tags.find((t) => t.id === id);
const projectEntries = (pid = state.currentProjectId) => state.entries.filter((e) => e.projectId === pid);

function startOfDay(t) { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); }
function addDays(t, n) { const d = new Date(t); d.setDate(d.getDate() + n); return d.getTime(); }

// Active (non-paused) duration of an entry.
const activeMs = (e) => Math.max(0, e.end - e.start - (e.pausedMs || 0));

function runningElapsed(r = state.running) {
  if (!r) return 0;
  const now = r.pausedAt || Date.now();
  return Math.max(0, now - r.start - r.pausedMs);
}

// "1 h 46 min", "40 min 4 sec", "17 sec"
function fmtDur(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h) return `${h} h ${m} min`;
  if (m) return `${m} min ${sec} sec`;
  return `${sec} sec`;
}
function fmtClock(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 3600)}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}
const fmtHM = (t) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fmtDate = (t) => new Date(t).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
const fmtShortDate = (t) => new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const toDateInput = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
function fromInputs(date, time) {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  return new Date(y, mo - 1, d, h, mi).getTime();
}

// ---------- daily goals ----------
// p.goals = [{from: dayStart, minutes}]; the goal for a day is the entry with the latest `from` on or before it
// (not array order, so a clock moved backwards can't scramble it).
function goalFor(p, day) {
  let best = null;
  for (const g of p.goals || []) if (g.from <= day && (!best || g.from >= best.from)) best = g;
  return best ? best.minutes : 0;
}
function setGoal(p, minutes) {
  const today = startOfDay(Date.now());
  if (goalFor(p, today) === minutes) return;
  p.goals = p.goals || [];
  const same = p.goals.find((g) => g.from === today);
  if (same) same.minutes = minutes; // same-day edit replaces
  else p.goals.push({ from: today, minutes });
}
// A streak day: the goal was met, or (with no goal) any time was tracked.
const dayOk = (p, day, ms) => { const g = goalFor(p, day); return g ? ms >= g * 60000 : ms > 0; };

// Sessions of a project, plus the running one if it belongs to it. Each gets `ms`.
function projectSpans(pid = state.currentProjectId) {
  const spans = projectEntries(pid).map((e) => ({ ...e, ms: activeMs(e) }));
  const r = state.running;
  if (r && r.projectId === pid) spans.push({ ...r, end: Date.now(), ms: runningElapsed(r) });
  return spans;
}
// Per-day totals; sessions count toward the day they started.
function perDayTotals(pid) {
  const perDay = new Map();
  for (const e of projectSpans(pid)) { const k = startOfDay(e.start); perDay.set(k, (perDay.get(k) || 0) + e.ms); }
  return perDay;
}
// One day's total for one project. Runs every second (ring, goal toast), so no copies or Dates per entry.
function dayTotal(pid, day) {
  const next = addDays(day, 1), r = state.running;
  let ms = 0;
  for (const e of state.entries) if (e.projectId === pid && e.start >= day && e.start < next) ms += activeMs(e);
  if (r && r.projectId === pid && r.start >= day && r.start < next) ms += runningElapsed(r);
  return ms;
}

function streakInfo(p, perDay) {
  const today = startOfDay(Date.now());
  let current = 0, best = 0, run = 0;
  for (let d = dayOk(p, today, perDay.get(today) || 0) ? today : addDays(today, -1); dayOk(p, d, perDay.get(d) || 0); d = addDays(d, -1)) current++;
  const first = Math.min(...perDay.keys(), today);
  for (let d = first; d <= today; d = addDays(d, 1)) {
    if (dayOk(p, d, perDay.get(d) || 0)) best = Math.max(best, ++run); else if (d !== today) run = 0;
  }
  return { current, best: Math.max(best, current) };
}

const pillsHtml = (tagIds) =>
  (tagIds || []).map(tagById).filter(Boolean).sort(byKind)
    .map((t) => `<span class="pill" style="--c:${t.color}">${esc(t.name)}</span>`).join("");

// ---------- auto-filled task names ----------
// "Watching" + "YouTube"   -> "Watching YouTube"
// "Reading" + "Book"       -> "Reading a book"
// "Listening" + "Audiobook" -> "Listening to an audiobook"
// "Reading" + "News"       -> "Reading the news"
// "Watching" + "Mining" + "TV Series" -> "Watching & mining a TV series"
const joinNames = (names) =>
  names.length <= 1 ? names.join("") : names.slice(0, -1).join(", ") + " & " + names[names.length - 1];

// The wording is worked out from the tag names alone, using a few English rules:
//
// Word after an activity: verbs that need a preposition before an object get one,
// judged by the activity's last word ("OCR Mining" -> "mining").
const PREPOSITION_VERBS = { listening: "to", talking: "to", looking: "at", chatting: "with", speaking: "with" };
const joinerFor = (activityName) => PREPOSITION_VERBS[activityName.trim().split(/\s+/).pop().toLowerCase()] || "";

// Article before a content tag:
//  - names with a capital inside a word (YouTube, iTunes) or known services -> none
//  - plurals (comics, videos) and uncountable things (anime, music) -> none
//  - news, radio -> "the"
//  - everything else is a countable thing -> "a" or "an", by its first sound
const SERVICES = new Set(["netflix", "twitch", "spotify", "duolingo", "anki", "reddit", "discord", "tiktok", "instagram", "twitter", "facebook", "disney+", "hbo", "prime video", "google"]);
const UNCOUNTABLE = new Set(["anime", "manga", "music", "tv", "television", "media", "content", "homework", "grammar", "vocabulary", "news", "radio", "reading", "audio", "netflix"]);
const THE_NOUNS = new Set(["news", "radio"]);
const SINGULAR_S = /(series|news|ss|us|is|chess)$/; // look plural but aren't

function articleKind(name) {
  const lower = name.trim().toLowerCase();
  const last = lower.split(/\s+/).pop();
  if (THE_NOUNS.has(last)) return "the";
  if (/[a-z][A-Z]/.test(name) || SERVICES.has(lower)) return "none"; // a brand or name
  if (UNCOUNTABLE.has(last)) return "none";
  if (/s$/.test(last) && !SINGULAR_S.test(last)) return "none"; // plural
  return "a";
}

// "an" before a vowel sound: "an audiobook", "an hour", "an NHK show"; "a" for
// a consonant sound even if spelled with a vowel: "a user guide", "a one-shot".
function aOrAn(phrase) {
  const w = phrase.split(/\s+/)[0];
  if (/^[A-Z]{2,}$/.test(w)) return /^[AEFHILMNORSX]/.test(w) ? "an" : "a"; // acronym, read letter by letter
  const l = w.toLowerCase();
  if (/^(hour|honest|honou?r|heir)/.test(l)) return "an";
  if (/^(uni|use|usu|ute|euro|eu|one|once|ur)/.test(l)) return "a";
  return /^[aeiou]/.test(l) ? "an" : "a";
}

// Lower-case ordinary capitalised words ("Book" -> "book") but keep names and
// acronyms as they are ("YouTube", "TV").
const softLower = (text) => text.replace(/\b[A-Z][a-z]+\b/g, (w) => w.toLowerCase());

function withArticle(tag) {
  const name = tag.name.trim();
  const kind = articleKind(name);
  const isName = /[a-z][A-Z]/.test(name) || SERVICES.has(name.toLowerCase());
  const noun = isName ? name : softLower(name);
  if (kind === "none") return noun;
  if (kind === "the") return "the " + noun;
  return aOrAn(noun) + " " + noun;
}

function autoTitle(tagIds) {
  const order = state.tags; // keep tags in picker order regardless of click order
  const tags = tagIds.map(tagById).filter(Boolean).sort((a, b) => byKind(a, b) || order.indexOf(a) - order.indexOf(b));
  const actTags = tags.filter(isActivity);
  const acts = actTags.map((t, i) => (i === 0 ? t.name : softLower(t.name)));
  const things = tags.filter((t) => !isActivity(t));
  if (!acts.length) return joinNames(things.map((t) => t.name));
  if (!things.length) return joinNames(acts);
  const joiner = joinerFor(actTags[actTags.length - 1].name);
  return joinNames(acts) + " " + (joiner ? joiner + " " : "") + joinNames(things.map(withArticle));
}

// Fill a title box from the chosen tags, but only if it is empty or still holds
// the previous automatic name, so text you typed yourself is never overwritten.
function applyAutoTitle(input, prevTagIds, nextTagIds) {
  const current = input.value.trim();
  if (current === "" || current === autoTitle(prevTagIds)) input.value = autoTitle(nextTagIds);
}

// ---------- timer ----------
function startTimer(title, tagIds) {
  applyNotificationActions(); // a notification press not yet applied happened first
  if (state.running) stopTimer();
  state.running = {
    id: uid(), // identifies this recording to the Android notification's buttons
    projectId: state.currentProjectId,
    title: title.trim() || "Untitled",
    tagIds: [...tagIds],
    start: Date.now(),
    pausedMs: 0,
    pausedAt: null,
  };
  save();
  render();
}

function togglePause() {
  // What the tapped button showed, before queued notification presses change the timer under it.
  const shown = state.running, wantPause = !shown?.pausedAt;
  applyNotificationActions();
  const r = state.running;
  if (!r || r.id !== shown.id || !r.pausedAt !== wantPause) return; // already done from the notification
  if (r.pausedAt) { r.pausedMs += Date.now() - r.pausedAt; r.pausedAt = null; }
  else r.pausedAt = Date.now();
  save();
  renderRunning();
}

// `recap`: show the session recap card (an explicit Stop, not a timer replaced by a new one).
function stopTimer(recap = false, at = Date.now()) {
  const r = state.running;
  if (!r) return;
  const end = r.pausedAt || at;
  let entry = null;
  if (end - r.start - r.pausedMs >= 1000) {
    entry = { id: uid(), projectId: r.projectId, title: r.title, tagIds: r.tagIds, start: r.start, end, pausedMs: r.pausedMs };
    state.entries.push(entry);
  }
  state.running = null;
  $("title-input").value = "";
  save();
  render();
  if (recap && entry) showRecap(entry, true);
}

function tick() {
  renderGoal();
  checkGoals();
  const r = state.running;
  if (!r) { document.title = "Time Tracker"; return; }
  const txt = fmtClock(runningElapsed());
  $("running-time").textContent = txt;
  $("mini-time").textContent = txt;
  document.title = `${r.pausedAt ? "❚❚" : "▶"} ${txt} · ${r.title}`;
}
setInterval(tick, 1000);

// ---------- rendering: project bar ----------
function renderProjectBar() {
  const p = project();
  $("project-dot").style.background = p.color;
  document.documentElement.style.setProperty("--accent", p.color); // theme stats in the project's colour
  $("project-name").textContent = p.name;
  $("project-menu").innerHTML = state.projects
    .map((x) => `<button data-pid="${x.id}" class="${x.id === p.id ? "current" : ""}"><span class="dot" style="background:${x.color}"></span>${esc(x.name)}</button>`)
    .join("");
}

// Goal ring: today's minutes against the current project's goal. Hidden (dot shown) with no goal.
function renderGoal() {
  const p = project(), today = startOfDay(Date.now());
  const goal = goalFor(p, today);
  $("goal-ring").classList.toggle("hidden", !goal);
  $("project-dot").classList.toggle("hidden", !!goal);
  $("goal-label").classList.toggle("hidden", !goal);
  if (!goal) return;
  const mins = Math.floor(dayTotal(p.id, today) / 60000);
  const met = mins >= goal;
  $("goal-ring").classList.toggle("met", met);
  const arc = Math.min(mins / goal, 1), lap = Math.min(Math.max(mins / goal - 1, 0), 1);
  $("goal-arc").setAttribute("stroke-dasharray", `${arc * 100} 100`);
  $("goal-lap").setAttribute("stroke-dasharray", `${lap * 100} 100`);
  // a zero-length dash with round caps still draws a dot
  $("goal-arc").style.display = arc ? "" : "none";
  $("goal-lap").style.display = lap ? "" : "none";
  $("goal-mins").textContent = met ? "✓" : mins;
  $("goal-label").textContent = `${mins} / ${goal} min ${met ? "· goal met" : "today"}`;
  $("goal-ring").setAttribute("aria-label", `${mins} of ${goal} minutes today${met ? ", goal met" : ""}. Open Statistics`);
}

// Fire the goal-met toast once per project per day, and again if the goal is raised and met (p.goalMetOn/goalMetMins).
function checkGoals() {
  const today = startOfDay(Date.now());
  for (const p of state.projects) {
    const goal = goalFor(p, today);
    if (!goal || (p.goalMetOn === today && p.goalMetMins >= goal) || dayTotal(p.id, today) < goal * 60000) continue;
    p.goalMetOn = today;
    p.goalMetMins = goal;
    save();
    toast(`Daily goal met: ${goal} min of ${p.name}`);
    if (p.id === state.currentProjectId) {
      const ring = $("goal-ring");
      ring.classList.remove("pulse");
      void ring.offsetWidth; // restart the animation
      ring.classList.add("pulse");
    }
  }
}

let toastTimer = 0;
function toast(text) {
  $("toast").classList.remove("hidden"); // unhide before filling, or screen readers may skip the live region
  $("toast").textContent = text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("toast").classList.add("hidden"), 4000);
}

// ---------- rendering: timer tab ----------
function renderTagPicker() {
  const selected = new Set(state.draftTagIds);
  const tags = projectTags();
  const firstContent = tags.findIndex((t) => !isActivity(t));
  $("tag-picker").innerHTML =
    tags.map((t, i) => (i === firstContent && i > 0 ? `<span class="tag-break"></span>` : "") + `
      <span class="chip ${selected.has(t.id) ? "on" : ""}" style="--c:${t.color}">
        <button type="button" class="chip-main" data-tag="${t.id}">${esc(t.name)}</button>
        <button type="button" class="chip-edit" data-edit-tag="${t.id}" title="Edit tag">✎</button>
      </span>`).join("") +
    `<button type="button" id="new-tag" class="link-btn">+ New tag</button>`;
}

function renderRunning() {
  const r = state.running;
  const showRunning = !!r && r.projectId === state.currentProjectId;
  $("start-form").classList.toggle("hidden", showRunning);
  $("running").classList.toggle("hidden", !showRunning);
  $("entry-card").classList.toggle("is-running", showRunning);
  if (r) {
    $("running-title").textContent = r.title;
    $("running-tags").innerHTML = pillsHtml(r.tagIds);
    $("running-clock").classList.toggle("paused", !!r.pausedAt);
    $("pause-btn").textContent = r.pausedAt ? "▶" : "❚❚";
    $("pause-btn").title = r.pausedAt ? "Resume" : "Pause";
    $("mini-title").textContent = r.title;
  }
  // Mini timer: visible when running and the full timer isn't on screen.
  $("mini-timer").classList.toggle("hidden", !r || (activeTab === "timer" && showRunning));
  syncNotification();
  tick();
}

// Android app: mirror the running timer in an ongoing notification with Pause/Resume and Stop buttons.
function syncNotification() {
  const bridge = window.AndroidBridge, r = state.running;
  if (!bridge) return;
  if (r) bridge.showRunning(r.id, r.title, r.start + r.pausedMs, r.pausedAt || 0);
  else bridge.clearRunning();
}

// Replays notification button presses (possibly made while the app was closed) at the times they happened.
// Presses leave the native queue only once the result is saved; `notifSeq` (saved with the timer)
// makes a replay after a crash in between skip the presses already applied.
function applyNotificationActions() {
  const bridge = window.AndroidBridge, events = bridge?.peekNotificationEvents();
  if (!events) return;
  for (const ev of events.split(",")) {
    const [kind, time, timerId, seqText] = ev.split(":"), t = Number(time), seq = Number(seqText);
    if (!(seq > (state.notifSeq || 0))) continue;
    state.notifSeq = seq;
    const r = state.running;
    if (!r || r.id !== timerId || !t) continue; // meant for a timer that has since ended
    if (kind === "p" && !r.pausedAt) r.pausedAt = t;
    else if (kind === "r" && r.pausedAt) { r.pausedMs += Math.max(0, t - r.pausedAt); r.pausedAt = null; }
    else if (kind === "s") stopTimer(true, Math.max(t, r.start));
  }
  if (save()) bridge.ackNotificationEvents(events); // not saved: keep them queued, retry on next resume
  render();
}

function renderHistory() {
  const list = projectEntries().sort((a, b) => b.start - a.start);
  const groups = new Map();
  for (const e of list) {
    const k = startOfDay(e.start);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }

  const html = [];
  let n = 0;
  for (const [day, items] of groups) {
    if (n++ >= visibleDays) break;
    const total = items.reduce((s, e) => s + activeMs(e), 0);
    html.push(`<div class="day"><div class="day-head"><span>${fmtDate(day)}</span><span class="day-total">${fmtDur(total)}</span></div><div class="day-list">`);
    for (const e of items) {
      const paused = e.pausedMs >= 1000 ? `<span class="entry-paused">| Paused time: ${fmtDur(e.pausedMs)}</span>` : "";
      html.push(`
        <div class="entry" data-id="${e.id}">
          <div class="entry-main">
            <div class="entry-title">${esc(e.title)}</div>
            <div class="entry-meta">
              <span class="entry-dur">${fmtDur(activeMs(e))}</span>
              <span class="entry-range">${fmtHM(e.start)} – ${fmtHM(e.end)}</span>${paused}
              ${pillsHtml(e.tagIds)}
            </div>
          </div>
          <div class="entry-actions">
            <button class="icon-btn" data-act="continue" title="Continue">▶</button>
            <button class="icon-btn" data-act="edit" title="Edit">✎</button>
            <button class="icon-btn" data-act="delete" title="Delete">✕</button>
          </div>
        </div>`);
    }
    html.push(`</div></div>`);
  }
  if (groups.size > visibleDays) html.push(`<button id="more-btn" class="btn btn-ghost more-btn">Show older days</button>`);
  $("history").innerHTML = html.join("");
  $("history-empty").classList.toggle("hidden", list.length > 0);
}

// "45 min", "2 h 05 min" — whole minutes, for recaps.
const fmtMins = (ms) => { const m = Math.round(ms / 60000); return m >= 60 ? `${Math.floor(m / 60)} h ${pad(m % 60)} min` : `${m} min`; };
const sum = (xs) => xs.reduce((s, x) => s + x, 0);

// ---------- session recap card ----------
let recapEntry = null, recapTimer = 0;

function showRecap(e, canRepeat) {
  const ms = activeMs(e);
  if (ms < 60000) return; // shorter sessions are saved but get no card
  const p = state.projects.find((x) => x.id === e.projectId);
  const today = startOfDay(Date.now()), eday = startOfDay(e.start);
  // Totals after the entry; "before" = the same minus this entry.
  const after = perDayTotals(p.id);
  const dayAfter = after.get(eday) || 0, dayBefore = dayAfter - ms;

  const hl = [];
  const others = projectEntries(p.id).filter((x) => x.id !== e.id).map(activeMs);
  if (others.length && ms > Math.max(...others)) hl.push("New longest session");
  // Records fire only on the session that crosses them, not on every later one that day.
  const prevRecord = Math.max(0, ...[...after].filter(([d]) => d !== eday).map(([, v]) => v));
  const mon = mondayOf(eday);
  const weekOthers = Math.max(0, ...[0, 1, 2, 3, 4, 5, 6].map((i) => addDays(mon, i)).filter((d) => d !== eday).map((d) => after.get(d) || 0));
  if (prevRecord > 0 && dayAfter > prevRecord && dayBefore <= prevRecord) hl.push("New day record");
  else if (weekOthers > 0 && dayAfter > weekOthers && dayBefore <= weekOthers) hl.push("Busiest day this week");
  const { current, best } = streakInfo(p, after);
  if (eday === today && dayOk(p, today, dayAfter) && current >= 2) hl.push(`Day ${current} in a row · best ${best}`);
  const total = sum([...after.values()]), TEN_H = 36e6;
  if (Math.floor(total / TEN_H) > Math.floor((total - ms) / TEN_H)) hl.push(`${Math.floor(total / TEN_H) * 10} hours total`);

  const goal = eday === today ? goalFor(p, today) : 0;
  let goalHtml = "";
  if (goal) {
    const done = Math.floor(dayAfter / 60000);
    const text = dayBefore < goal * 60000 && done >= goal ? "Goal met!"
      : done >= goal ? `${done} / ${goal} min today · goal met` : `${done} / ${goal} min today, ${goal - done} min to go`;
    goalHtml = `<div class="recap-goal"><div class="track"><div class="fill" style="width:${Math.min(done / goal, 1) * 100}%"></div></div><span>${text}</span></div>`;
  }

  recapEntry = e;
  $("recap").classList.remove("hidden"); // unhide before filling, or screen readers may skip the live region
  $("recap").innerHTML = `
    <div class="recap-head"><span class="recap-plus">+${fmtMins(ms)}</span><span class="recap-title">${esc(e.title)}</span></div>
    <div class="pill-row">${pillsHtml(e.tagIds)}</div>
    ${goalHtml}
    ${hl.slice(0, 2).map((h) => `<div class="recap-hl">★ ${esc(h)}</div>`).join("")}
    <div class="recap-actions">
      ${canRepeat ? `<button type="button" class="btn btn-start" data-act="again">▶ Do it again</button>` : ""}
      <button type="button" class="btn btn-ghost" data-act="edit">Edit</button>
    </div>`;
  clearTimeout(recapTimer);
  recapTimer = setTimeout(closeRecap, 8000);
}
function closeRecap() { $("recap").classList.add("hidden"); clearTimeout(recapTimer); recapEntry = null; }

// ---------- weekly recap ----------
let weeklyForced = false; // opened from the "Last week" link on Statistics

function weekSummary(p, monday) {
  const pid = p.id, perDay = perDayTotals(pid);
  const next = addDays(monday, 7);
  const days = [0, 1, 2, 3, 4, 5, 6].map((i) => {
    const d = addDays(monday, i), ms = perDay.get(d) || 0, goal = goalFor(p, d);
    return { d, ms, goal, met: !!goal && dayOk(p, d, ms) };
  });
  const total = sum(days.map((x) => x.ms));
  const prev = sum([1, 2, 3, 4, 5, 6, 7].map((i) => perDay.get(addDays(monday, -i)) || 0));
  const weeks = new Map(); // earlier weeks' totals
  for (const [d, ms] of perDay) if (d < monday) weeks.set(mondayOf(d), (weeks.get(mondayOf(d)) || 0) + ms);
  const sessions = projectSpans(pid).filter((e) => e.start >= monday && e.start < next);
  const order = projectTags(pid), groups = new Map();
  for (const e of sessions) { const g = groupOf(e, order); groups.set(g, (groups.get(g) || 0) + e.ms); }
  const top = [...groups].sort((a, b) => b[1] - a[1])[0];
  return {
    total, prev, days, sessions: sessions.length,
    bestDay: days.reduce((a, b) => (b.ms > a.ms ? b : a)),
    top: top && { tag: top[0], ms: top[1] },
    bestEver: weeks.size > 0 && total > Math.max(...weeks.values()),
  };
}

function renderWeekly() {
  const p = project(), monday = addDays(mondayOf(Date.now()), -7);
  // shortcut: a project with no sessions before this week gets no card (nothing to recap yet).
  const hasHistory = projectEntries().some((e) => e.start < addDays(monday, 7));
  const show = weeklyForced || (p.recapSeenWeek !== monday && hasHistory);
  $("weekly").classList.toggle("hidden", !show);
  if (!show) return;
  const w = weekSummary(p, monday);
  const close = `<button type="button" class="icon-btn" data-act="weekly-close" title="Dismiss">✕</button>`;
  if (!w.total) {
    $("weekly").innerHTML = `<div class="weekly-head"><h2>Last week</h2>${close}</div>
      <p>No time tracked last week. Start with 10 minutes today?</p>
      ${state.running ? "" : `<button type="button" class="btn btn-start" data-act="weekly-start">▶ Start</button>`}`;
    return;
  }
  const diff = w.total - w.prev;
  const delta = w.prev ? `<span class="delta ${diff >= 0 ? "up" : "down"}">${diff >= 0 ? "+" : "−"}${fmtMins(Math.abs(diff))} (${diff >= 0 ? "+" : "−"}${Math.abs(Math.round((diff / w.prev) * 100))}%)</span>` : "";
  const goalDays = w.days.filter((x) => x.goal);
  const rows = [
    goalDays.length && ["Goal days", `${goalDays.filter((x) => x.met).length} / ${goalDays.length}`],
    ["Best day", `${new Date(w.bestDay.d).toLocaleDateString("en-US", { weekday: "long" })}, ${fmtMins(w.bestDay.ms)}`],
    w.top && ["Top activity", `${w.top.tag ? esc(w.top.tag.name) : "No tag"}, ${fmtMins(w.top.ms)} (${Math.round((w.top.ms / w.total) * 100)}%)`],
    ["Sessions", `${w.sessions}, average ${fmtMins(w.total / w.sessions)}`],
  ].filter(Boolean);
  $("weekly").innerHTML = `
    <div class="weekly-head"><h2>Last week · ${fmtShortDate(monday)} – ${fmtShortDate(addDays(monday, 6))}</h2>${close}</div>
    <div class="weekly-total">${fmtMins(w.total)} ${delta}</div>
    <div class="weekly-dots">${w.days.map((x) => `<span><i class="${x.ms ? "on" : ""} ${x.met ? "met" : ""}"></i>${"MTWTFSS"[(new Date(x.d).getDay() + 6) % 7]}</span>`).join("")}</div>
    <dl class="weekly-rows">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
    ${w.bestEver ? `<p class="weekly-best">★ Your best week ever</p>` : ""}`;
}

function dismissWeekly() {
  project().recapSeenWeek = addDays(mondayOf(Date.now()), -7);
  weeklyForced = false;
  save();
  renderWeekly();
}

// ---------- rendering: statistics tab ----------
// The tag a session is grouped under: its first activity, else its first tag, else null (untagged).
function groupOf(e, order = projectTags()) {
  const tags = (e.tagIds || []).map(tagById).filter(Boolean).sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return tags.find(isActivity) || tags[0] || null;
}

function renderStats() {
  const spans = projectSpans();
  const total = spans.reduce((s, e) => s + e.ms, 0);
  $("s-total").textContent = fmtDur(total);
  $("s-sessions").textContent = spans.length;

  const longest = spans.reduce((a, b) => (b.ms > (a?.ms || 0) ? b : a), null);
  $("s-longest").textContent = longest ? fmtDur(longest.ms) : "—";
  $("s-longest-sub").textContent = longest ? longest.title : "";

  const perDay = perDayTotals(state.currentProjectId);
  let record = null;
  for (const [day, ms] of perDay) if (!record || ms > record.ms) record = { day, ms };
  $("s-record").textContent = record ? fmtDur(record.ms) : "—";
  $("s-record-sub").textContent = record ? fmtShortDate(record.day) + ", " + new Date(record.day).getFullYear() : "";

  renderHeatmap(perDay);

  // Last 30 days chart, each bar stacked by activity (or content tag if it has no activity)
  const today = startOfDay(Date.now());
  const order = projectTags(); // activities first, in the same order as the tag picker
  const perDayGroup = new Map(); // day -> Map(tag|null -> ms)
  for (const e of spans) {
    const k = startOfDay(e.start);
    if (!perDayGroup.has(k)) perDayGroup.set(k, new Map());
    const g = perDayGroup.get(k), tag = groupOf(e, order);
    g.set(tag, (g.get(tag) || 0) + e.ms);
  }
  const rank = (tag) => (tag ? order.indexOf(tag) : order.length);
  const days = [];
  for (let i = 29; i >= 0; i--) { const d = addDays(today, -i); days.push({ d, ms: perDay.get(d) || 0, groups: perDayGroup.get(d) || new Map() }); }
  const max = Math.max(...days.map((x) => x.ms), 1);
  const used = new Set();
  $("chart").innerHTML = days
    .map(({ d, ms, groups }) => {
      const parts = [...groups].sort((a, b) => rank(a[0]) - rank(b[0]));
      parts.forEach(([tag]) => used.add(tag));
      const segs = parts.map(([tag, t]) =>
        `<div class="seg" style="flex:${t};background:${tag ? tag.color : "#777"}"></div>`).join("");
      const detail = parts.map(([tag, t]) => `${tag ? tag.name : "No tag"} ${fmtDur(t)}`).join(" · ");
      const tip = `${fmtShortDate(d)} — ${ms ? fmtDur(ms) : "nothing"}${parts.length > 1 ? "\n" + detail : ""}`;
      return `<div class="chart-col" data-tip="${esc(tip)}"><div class="chart-bar" style="height:${ms ? Math.max(2, (ms / max) * 100) : 0}%">${segs}</div></div>`;
    })
    .join("");
  $("chart-from").textContent = fmtShortDate(days[0].d);

  // Goal days in the same 30 days: met out of days with a goal (today only once met). Hidden if none.
  const p = project();
  const goalDays = days.filter(({ d, ms }) => goalFor(p, d) && (d !== today || dayOk(p, d, ms)));
  $("s-goal-card").classList.toggle("hidden", !goalDays.length);
  $("s-goal").textContent = `${goalDays.filter(({ d, ms }) => dayOk(p, d, ms)).length} / ${goalDays.length}`;
  $("chart-legend").innerHTML = [...used].sort((a, b) => rank(a) - rank(b))
    .map((tag) => `<span><i style="background:${tag ? tag.color : "#777"}"></i>${tag ? esc(tag.name) : "No tag"}</span>`).join("");

  // Time per tag
  const perTag = new Map();
  for (const e of spans) for (const id of e.tagIds || []) perTag.set(id, (perTag.get(id) || 0) + e.ms);
  const rows = projectTags().map((t) => ({ t, ms: perTag.get(t.id) || 0 })).sort((a, b) => b.ms - a.ms);
  const tagMax = Math.max(...rows.map((r) => r.ms), 1);
  $("tag-stats").innerHTML = rows.length
    ? rows.map(({ t, ms }) => `
        <span class="name" style="--c:${t.color}">${esc(t.name)}</span>
        <div class="track"><div class="fill" style="--c:${t.color};width:${(ms / tagMax) * 100}%"></div></div>
        <span class="val">${fmtDur(ms)}</span>`).join("")
    : `<span class="muted">No tags in this project yet.</span>`;
}

// ---------- activity heatmap (GitHub-style calendar) ----------
// Colour levels by time tracked that day.
const HEAT_LEVELS = [30 * 60000, 60 * 60000, 2 * 3600000]; // <30 min, <1 h, <2 h, 2 h+
const heatLevel = (ms) => (!ms ? 0 : ms < HEAT_LEVELS[0] ? 1 : ms < HEAT_LEVELS[1] ? 2 : ms < HEAT_LEVELS[2] ? 3 : 4);
const mondayOf = (t) => addDays(startOfDay(t), -((new Date(t).getDay() + 6) % 7)); // weeks start on Monday
let heatRange = "last"; // "last" = past 12 months, or a year like "2026"

function renderHeatRange(perDay) {
  const years = new Set([new Date().getFullYear()]);
  for (const d of perDay.keys()) years.add(new Date(d).getFullYear());
  const opts = [["last", "Last 12 months"], ...[...years].sort((a, b) => b - a).map((y) => [String(y), String(y)])];
  if (!opts.some(([v]) => v === heatRange)) heatRange = "last";
  $("heat-range").innerHTML = opts.map(([v, l]) => `<option value="${v}" ${v === heatRange ? "selected" : ""}>${l}</option>`).join("");
}

function renderHeatmap(perDay) {
  renderHeatRange(perDay);
  const today = startOfDay(Date.now()), p = project();
  let from, to; // inclusive day range shown
  if (heatRange === "last") { to = today; from = addDays(addDays(today, 1), -365); }
  else { const y = Number(heatRange); from = new Date(y, 0, 1).getTime(); to = Math.min(new Date(y, 11, 31).getTime(), today); }

  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const cols = [];
  let lastMonth = -1;
  for (let week = mondayOf(from); week <= to; week = addDays(week, 7)) {
    const cells = [];
    let label = "";
    for (let i = 0; i < 7; i++) {
      const d = addDays(week, i);
      if (d < from || d > to) { cells.push(`<i class="out"></i>`); continue; }
      const date = new Date(d);
      if (date.getDate() <= 7 && date.getMonth() !== lastMonth && !label) { label = months[date.getMonth()]; lastMonth = date.getMonth(); }
      const ms = perDay.get(d) || 0;
      const when = date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
      const met = goalFor(p, d) && dayOk(p, d, ms) ? " · goal met" : "";
      cells.push(`<i data-l="${heatLevel(ms)}" data-tip="${ms ? fmtDur(ms) : "No time"} on ${when}${met}"${d === today ? ' class="today"' : ""}></i>`);
    }
    cols.push(`<div class="heat-col"><span class="heat-month">${label}</span>${cells.join("")}</div>`);
  }
  $("heatmap").innerHTML = cols.join("");

  // Summary: total, active days, and streaks (goal days, see dayOk). The 12-month view shows the
  // all-time best so a reset never hides the record; a year view shows that year's longest.
  let total = 0, active = 0, longest = 0, run = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const ms = perDay.get(d) || 0;
    total += ms;
    if (ms) active++;
    if (dayOk(p, d, ms)) longest = Math.max(longest, ++run); else if (d !== today) run = 0;
  }
  const { current, best } = streakInfo(p, perDay);
  if (heatRange === "last") longest = best;
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const label = heatRange === "last" ? "in the last 12 months" : `in ${heatRange}`;
  $("heat-summary").innerHTML =
    `<b>${fmtDur(total)}</b> ${label} · ${plural(active, "active day")} · ` +
    (heatRange === "last" ? `current streak <b>${plural(current, "day")}</b> · ` : "") +
    `longest streak <b>${plural(longest, "day")}</b>`;

  // Show the most recent weeks first on narrow screens
  const sc = $("heat-scroll");
  sc.scrollLeft = sc.scrollWidth;
}

function render() {
  renderProjectBar();
  renderTagPicker();
  renderRunning();
  if (activeTab === "timer") { renderHistory(); renderWeekly(); }
  else renderStats();
}

// ---------- modal ----------
let modalHandlers = null;

function openModal({ title, body, okText = "Save", onOk, onDelete, onOpen }) {
  $("modal-title").textContent = title;
  $("modal-body").innerHTML = body;
  $("modal-ok").textContent = okText;
  $("modal-delete").classList.toggle("hidden", !onDelete);
  modalHandlers = { onOk, onDelete };
  $("modal").showModal();
  onOpen?.();
  $("modal-body").querySelector("input")?.focus();
}
function closeModal() { $("modal").close(); modalHandlers = null; }

$("modal-form").addEventListener("submit", (ev) => {
  ev.preventDefault();
  if (modalHandlers?.onOk?.() === false) return; // validation failed
  closeModal();
  save();
  render();
});
$("modal-cancel").addEventListener("click", closeModal);
$("modal-delete").addEventListener("click", () => {
  if (modalHandlers?.onDelete?.() === false) return;
  closeModal();
  save();
  render();
});

const swatchHtml = (current) =>
  `<div class="swatches" id="m-swatches">${COLORS.map((c) => `<button type="button" class="swatch ${c === current ? "on" : ""}" data-color="${c}" style="background:${c}"></button>`).join("")}</div>`;
function wireSwatches() {
  $("m-swatches").addEventListener("click", (ev) => {
    const b = ev.target.closest(".swatch");
    if (!b) return;
    $("m-swatches").querySelectorAll(".swatch").forEach((s) => s.classList.toggle("on", s === b));
  });
}
const pickedColor = () => $("m-swatches").querySelector(".swatch.on")?.dataset.color || COLORS[0];

function tagToggleHtml(selectedIds, pid) {
  const sel = new Set(selectedIds);
  return `<div class="tag-picker" id="m-tags">${projectTags(pid).map((t) => `
      <span class="chip ${sel.has(t.id) ? "on" : ""}" style="--c:${t.color}"><button type="button" class="chip-main" data-tag="${t.id}" style="padding-right:10px">${esc(t.name)}</button></span>`).join("")}</div>`;
}
function wireTagToggles() {
  $("m-tags").addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-tag]");
    if (!b) return;
    const prev = pickedTags();
    b.parentElement.classList.toggle("on");
    if ($("m-title")) applyAutoTitle($("m-title"), prev, pickedTags());
  });
}
const pickedTags = () => [...$("m-tags").querySelectorAll(".chip.on [data-tag]")].map((b) => b.dataset.tag);

const GOAL_PRESETS = [0, 15, 30, 45, 60, 90, 120];

function editProject(p) {
  const goal = p ? goalFor(p, startOfDay(Date.now())) : 0;
  const custom = !GOAL_PRESETS.includes(goal);
  openModal({
    title: p ? "Edit project" : "New project",
    okText: p ? "Save" : "Create",
    body: `<label class="field">Name <input id="m-name" class="input" maxlength="60" required value="${esc(p?.name || "")}"></label>
           <div class="field">Color ${swatchHtml(p?.color || COLORS[Math.floor(Math.random() * COLORS.length)])}</div>
           <div class="field">Daily goal
             <div class="row2">
               <select id="m-goal" class="input" aria-label="Daily goal">${GOAL_PRESETS.map((m) => `<option value="${m}" ${!custom && m === goal ? "selected" : ""}>${m ? m + " min" : "Off"}</option>`).join("")}
                 <option value="custom" ${custom ? "selected" : ""}>Custom…</option></select>
               <input id="m-goal-custom" aria-label="Daily goal in minutes" class="input ${custom ? "" : "hidden"}" type="number" min="5" max="720" step="1" required placeholder="Minutes (5–720)" value="${custom ? goal : ""}" ${custom ? "" : "disabled"}>
             </div>
           </div>`,
    onOpen: () => {
      wireSwatches();
      $("m-goal").addEventListener("change", () => {
        const on = $("m-goal").value === "custom";
        $("m-goal-custom").disabled = !on; // disabled inputs skip form validation
        $("m-goal-custom").classList.toggle("hidden", !on);
        if (on) $("m-goal-custom").focus();
      });
    },
    onOk: () => {
      const name = $("m-name").value.trim();
      if (!name) return false;
      const sel = $("m-goal").value;
      const minutes = sel === "custom" ? Number($("m-goal-custom").value) : Number(sel);
      if (sel === "custom" && !(Number.isInteger(minutes) && minutes >= 5 && minutes <= 720)) return false;
      if (p) { Object.assign(p, { name, color: pickedColor() }); setGoal(p, minutes); }
      else {
        const np = { id: uid(), name, color: pickedColor() };
        setGoal(np, minutes);
        state.projects.push(np);
        state.currentProjectId = np.id;
        state.draftTagIds = [];
      }
    },
    onDelete: p && state.projects.length > 1 ? () => {
      if (!confirm(`Delete project "${p.name}" and all of its sessions and tags?`)) return false;
      if (state.running?.projectId === p.id) state.running = null;
      state.projects = state.projects.filter((x) => x.id !== p.id);
      state.entries = state.entries.filter((e) => e.projectId !== p.id);
      state.tags = state.tags.filter((t) => t.projectId !== p.id);
      state.currentProjectId = state.projects[0].id;
      state.draftTagIds = [];
    } : null,
  });
}

function editTag(t) {
  openModal({
    title: t ? "Edit tag" : "New tag",
    okText: t ? "Save" : "Create",
    body: `<label class="field">Name <input id="m-name" class="input" maxlength="40" required value="${esc(t?.name || "")}"></label>
           <div class="field">Type
             <div class="kind-toggle" id="m-kind">
               <label><input type="radio" name="kind" value="activity" ${t?.kind === "activity" ? "checked" : ""}> Activity <span class="muted">(Watching, Listening…) — listed first</span></label>
               <label><input type="radio" name="kind" value="content" ${t?.kind === "activity" ? "" : "checked"}> Content <span class="muted">(YouTube, Audiobook…)</span></label>
             </div>
           </div>
           <div class="field">Color ${swatchHtml(t?.color || COLORS[Math.floor(Math.random() * COLORS.length)])}</div>`,
    onOpen: wireSwatches,
    onOk: () => {
      const name = $("m-name").value.trim();
      if (!name) return false;
      const kind = $("m-kind").querySelector("input:checked").value;
      if (t) { Object.assign(t, { name, kind, color: pickedColor() }); delete t.article; delete t.joiner; }
      else state.tags.push({ id: uid(), projectId: state.currentProjectId, name, kind, color: pickedColor() });
    },
    onDelete: t ? () => {
      if (!confirm(`Delete tag "${t.name}"? It will be removed from all sessions.`)) return false;
      state.tags = state.tags.filter((x) => x.id !== t.id);
      const strip = (o) => { if (o?.tagIds) o.tagIds = o.tagIds.filter((id) => id !== t.id); };
      state.entries.forEach(strip);
      strip(state.running);
      state.draftTagIds = state.draftTagIds.filter((id) => id !== t.id);
    } : null,
  });
}

// Edit an existing entry, or create one manually when `e` is null.
function editEntry(e) {
  const start = e?.start ?? Date.now() - 3600000;
  const end = e?.end ?? Date.now();
  openModal({
    title: e ? "Edit session" : "Add session",
    okText: e ? "Save" : "Add",
    body: `<label class="field">Title <input id="m-title" class="input" maxlength="120" value="${esc(e?.title || "")}"></label>
           <div class="field">Tags ${tagToggleHtml(e?.tagIds || [], e?.projectId || state.currentProjectId)}</div>
           <label class="field">Date <input id="m-date" class="input" type="date" required value="${toDateInput(start)}"></label>
           <div class="row2">
             <label class="field">Start <input id="m-start" class="input" type="time" required value="${fmtHM(start)}"></label>
             <label class="field">End <input id="m-end" class="input" type="time" required value="${fmtHM(end)}"></label>
           </div>
           <label class="field">Paused (minutes) <input id="m-paused" class="input" type="number" min="0" step="1" value="${Math.round((e?.pausedMs || 0) / 60000)}"></label>`,
    onOpen: wireTagToggles,
    onOk: () => {
      const s = fromInputs($("m-date").value, $("m-start").value);
      let en = fromInputs($("m-date").value, $("m-end").value);
      if (en <= s) en = addDays(en, 1); // crosses midnight
      const pausedMs = Math.min(Math.max(0, Number($("m-paused").value) || 0) * 60000, en - s);
      const data = { title: $("m-title").value.trim() || "Untitled", tagIds: pickedTags(), start: s, end: en, pausedMs };
      if (e) Object.assign(e, data);
      else {
        const ne = { id: uid(), projectId: state.currentProjectId, ...data };
        state.entries.push(ne);
        showRecap(ne, false);
      }
    },
    onDelete: e ? () => { state.entries = state.entries.filter((x) => x.id !== e.id); } : null,
  });
}

function editRunning() {
  applyNotificationActions();
  const r = state.running;
  if (!r) return;
  openModal({
    title: "Edit running session",
    body: `<label class="field">Title <input id="m-title" class="input" maxlength="120" value="${esc(r.title)}"></label>
           <div class="field">Tags ${tagToggleHtml(r.tagIds, r.projectId)}</div>
           <label class="field">Started at <input id="m-start" class="input" type="time" value="${fmtHM(r.start)}"></label>`,
    onOpen: wireTagToggles,
    onOk: () => {
      applyNotificationActions();
      if (state.running !== r) return toast("This session was stopped from the notification. Edit it in the history instead.");
      r.title = $("m-title").value.trim() || "Untitled";
      r.tagIds = pickedTags();
      let s = fromInputs(toDateInput(r.start), $("m-start").value);
      if (s > Date.now()) s = addDays(s, -1);
      r.start = s;
    },
  });
}

// ---------- CSV ----------
function exportCsv() {
  const p = project();
  const rows = [["title", "tags", "start", "end", "active_minutes", "paused_minutes"]];
  for (const e of projectEntries().sort((a, b) => a.start - b.start)) {
    rows.push([e.title, (e.tagIds || []).map((id) => tagById(id)?.name).filter(Boolean).join("; "),
      new Date(e.start).toISOString(), new Date(e.end).toISOString(),
      Math.round(activeMs(e) / 60000), Math.round((e.pausedMs || 0) / 60000)]);
  }
  const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
  const filename = `${p.name.replace(/\W+/g, "-").toLowerCase()}-${toDateInput(Date.now())}.csv`;
  if (window.AndroidBridge) return window.AndroidBridge.saveFile(filename, csv); // Android app
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------- events ----------
document.querySelectorAll(".tab").forEach((b) =>
  b.addEventListener("click", () => switchTab(b.dataset.tab)));

function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  $("tab-timer").classList.toggle("hidden", tab !== "timer");
  $("tab-stats").classList.toggle("hidden", tab !== "stats");
  render();
}

$("project-select").addEventListener("click", (ev) => {
  ev.stopPropagation();
  $("project-menu").classList.toggle("hidden");
});
$("project-menu").addEventListener("click", (ev) => {
  const b = ev.target.closest("[data-pid]");
  if (!b) return;
  state.currentProjectId = b.dataset.pid;
  state.draftTagIds = [];
  visibleDays = 14;
  weeklyForced = false;
  $("project-menu").classList.add("hidden");
  save();
  render();
});
document.addEventListener("click", () => $("project-menu").classList.add("hidden"));
$("project-edit").addEventListener("click", () => editProject(project()));
$("project-new").addEventListener("click", () => editProject(null));

$("tag-picker").addEventListener("click", (ev) => {
  const edit = ev.target.closest("[data-edit-tag]");
  if (edit) return editTag(tagById(edit.dataset.editTag));
  if (ev.target.id === "new-tag") return editTag(null);
  const b = ev.target.closest("[data-tag]");
  if (!b) return;
  const id = b.dataset.tag;
  const prev = state.draftTagIds;
  state.draftTagIds = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
  applyAutoTitle($("title-input"), prev, state.draftTagIds);
  save();
  renderTagPicker();
});

$("start-form").addEventListener("submit", (ev) => {
  ev.preventDefault();
  startTimer($("title-input").value, state.draftTagIds);
});
$("pause-btn").addEventListener("click", togglePause);
$("stop-btn").addEventListener("click", () => { applyNotificationActions(); stopTimer(true); });
$("goal-ring").addEventListener("click", () => switchTab("stats"));

$("recap").addEventListener("click", (ev) => {
  const act = ev.target.closest("[data-act]")?.dataset.act, e = recapEntry;
  if (!act || !e) return;
  closeRecap();
  if (act === "again") startTimer(e.title, e.tagIds || []);
  else editEntry(e);
});
// Close on a tap outside (pointerdown, so the Stop click that opened it doesn't) or a swipe down.
document.addEventListener("pointerdown", (ev) => { if (!$("recap").contains(ev.target)) closeRecap(); });
let recapTouchY = 0;
$("recap").addEventListener("touchstart", (ev) => { recapTouchY = ev.touches[0].clientY; }, { passive: true });
$("recap").addEventListener("touchend", (ev) => { if (ev.changedTouches[0].clientY - recapTouchY > 40) closeRecap(); });
// Don't auto-close under someone reaching for a button; Escape closes it from the keyboard.
for (const t of ["focusin", "pointerenter"]) $("recap").addEventListener(t, () => clearTimeout(recapTimer));
document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") closeRecap(); });

$("weekly").addEventListener("click", (ev) => {
  const act = ev.target.closest("[data-act]")?.dataset.act;
  if (act === "weekly-close") dismissWeekly();
  else if (act === "weekly-start") { dismissWeekly(); startTimer($("title-input").value, state.draftTagIds); }
});
$("weekly-btn").addEventListener("click", () => { weeklyForced = true; switchTab("timer"); });
$("running-edit").addEventListener("click", editRunning);
$("manual-btn").addEventListener("click", () => editEntry(null));
$("export-btn").addEventListener("click", exportCsv);

$("mini-timer").addEventListener("click", () => {
  if (state.running) { state.currentProjectId = state.running.projectId; save(); }
  switchTab("timer");
});

$("history").addEventListener("click", (ev) => {
  if (ev.target.id === "more-btn") { visibleDays += 14; renderHistory(); return; }
  const b = ev.target.closest("[data-act]");
  if (!b) return;
  const e = state.entries.find((x) => x.id === b.closest(".entry").dataset.id);
  if (!e) return;
  if (b.dataset.act === "continue") startTimer(e.title, e.tagIds || []);
  else if (b.dataset.act === "edit") editEntry(e);
  else if (b.dataset.act === "delete" && confirm(`Delete "${e.title}"?`)) {
    state.entries = state.entries.filter((x) => x.id !== e.id);
    save();
    render();
  }
});

// Chart hover tooltip
$("chart").addEventListener("mousemove", (ev) => {
  const col = ev.target.closest(".chart-col");
  const tip = $("chart-tip");
  if (!col) return tip.classList.add("hidden");
  tip.textContent = col.dataset.tip;
  tip.classList.remove("hidden"); // must be visible before its width can be measured
  const half = tip.offsetWidth / 2, wrapW = $("chart").offsetWidth;
  tip.style.left = `${Math.min(Math.max(col.offsetLeft + col.offsetWidth / 2, half), wrapW - half)}px`;
});
$("chart").addEventListener("mouseleave", () => $("chart-tip").classList.add("hidden"));

// Heatmap tooltip: hover on desktop, tap on phones
function showHeatTip(ev) {
  const cell = ev.target.closest("i[data-tip]");
  const tip = $("heat-tip");
  if (!cell) return tip.classList.add("hidden");
  const wrap = $("heat-wrap").getBoundingClientRect();
  const r = cell.getBoundingClientRect();
  tip.textContent = cell.dataset.tip;
  const x = Math.min(Math.max(r.left - wrap.left + r.width / 2, 70), wrap.width - 70);
  tip.style.left = `${x}px`;
  tip.style.top = `${r.top - wrap.top - 4}px`;
  tip.classList.remove("hidden");
}
$("heatmap").addEventListener("mousemove", showHeatTip);
$("heatmap").addEventListener("click", showHeatTip);
$("heatmap").addEventListener("mouseleave", () => $("heat-tip").classList.add("hidden"));
$("heat-scroll").addEventListener("scroll", () => $("heat-tip").classList.add("hidden"));
$("heat-range").addEventListener("change", (ev) => { heatRange = ev.target.value; renderStats(); });

// Keep several open tabs in sync.
window.addEventListener("storage", (ev) => {
  if (ev.key !== STORE_KEY) return;
  state = loadState();
  render();
});

// Refresh statistics every 30 s while the timer runs.
setInterval(() => { if (state.running && activeTab === "stats") renderStats(); }, 30000);

// Android back button: close dialogs/menus, then return to the Timer tab. Returns true if handled.
function handleBack() {
  if ($("modal").open) { closeModal(); return true; }
  if (!$("recap").classList.contains("hidden")) { closeRecap(); return true; }
  if (!$("project-menu").classList.contains("hidden")) { $("project-menu").classList.add("hidden"); return true; }
  if (activeTab !== "timer") { switchTab("timer"); return true; }
  return false;
}

save(); // persist the default project/tags on first visit so their ids stay stable
applyNotificationActions();
render();
