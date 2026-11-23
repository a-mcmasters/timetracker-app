// Regression tests for editing a running timer, CSV export and unreadable saves.
// Run: TZ=Europe/Berlin node tests/bugs.test.mjs (the clock-change cases only bite in a zone with DST).
// Loads index.js against a stub DOM (same approach as goals.test.mjs), one fresh app per test.
import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";

const src = readFileSync(new URL("../index.js", import.meta.url), "utf8");
// stored: the saved text; full(key) -> true makes setItem throw for that key; bridge: window.AndroidBridge.
function app({ stored = null, full = () => false, getThrows = false, bridge } = {}) {
  const any = new Proxy(function () {}, { get: (_, k) => (k === Symbol.toPrimitive ? () => "" : any), apply: () => any, set: () => true });
  const el = () => { const s = {}; return new Proxy(function () {}, { get: (_, k) => (k in s ? s[k] : any), set: (_, k, v) => ((s[k] = v), true), apply: () => any }); };
  const els = new Map();
  const document = new Proxy({}, { get: (_, k) => (k === "getElementById" ? (id) => els.get(id) || els.set(id, el()).get(id) : any) });
  const store = new Map(stored == null ? [] : [["timetracker.v2", stored]]);
  const localStorage = {
    getItem: (k) => { if (getThrows) throw new Error("SecurityError"); return store.get(k) ?? null; },
    setItem: (k, v) => { if (full(k)) throw new Error("QuotaExceededError"); store.set(k, String(v)); },
  };
  const ctx = vm.createContext({ document, window: { addEventListener() {}, AndroidBridge: bridge }, localStorage, setInterval() {}, setTimeout() {}, clearTimeout() {}, console });
  vm.runInContext(src, ctx);
  return { run: (code) => vm.runInContext(code, ctx), store };
}
const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi).getTime();
// Opens "Edit running session" for a timer, types a start time, saves. Returns what onOk returned.
function editStart(run, { now, start, pausedMs = 0, pausedAt = null, time }) {
  run(`Date.now = () => ${now};
       state.running = { id: "r1", projectId: project().id, title: "t", tagIds: [], start: ${start}, pausedMs: ${pausedMs}, pausedAt: ${pausedAt} };
       editRunning(); $("m-title").value = "renamed"; $("m-start").value = ${JSON.stringify(time ?? run(`fmtHM(${start})`))}`);
  return run(`modalHandlers.onOk()`);
}

// An empty "Started at" keeps the dialog open and the start time.
{
  const { run } = app();
  const start = at(2026, 11, 23, 10, 0);
  assert.equal(editStart(run, { now: at(2026, 11, 23, 11, 0), start, time: "" }), false, "dialog stays open");
  assert.equal(run(`state.running.start`), start);
}

// A timer that crossed midnight: 23:00 yesterday, edited at 01:00 to 00:30, starts 00:30 today.
{
  const { run } = app();
  editStart(run, { now: at(2026, 11, 23, 1, 0), start: at(2026, 11, 22, 23, 0), time: "00:30" });
  assert.equal(run(`state.running.start`), at(2026, 11, 23, 0, 30));
}
// ...and a time later than now means yesterday.
{
  const { run } = app();
  editStart(run, { now: at(2026, 11, 23, 1, 0), start: at(2026, 11, 22, 23, 0), time: "22:15" });
  assert.equal(run(`state.running.start`), at(2026, 11, 22, 22, 15));
}

// Renaming a timer that has run for over a day leaves its start alone.
{
  const { run } = app();
  const start = at(2026, 11, 22, 18, 0);
  editStart(run, { now: at(2026, 11, 23, 19, 0), start });
  assert.equal(run(`state.running.start`), start, "untouched start must not move to today");
  assert.equal(run(`state.running.title`), "renamed");
}

// A start that leaves no active time is refused: Stop would otherwise throw the session away.
{
  const { run } = app();
  const start = at(2026, 11, 23, 10, 0);
  const ok = editStart(run, { now: at(2026, 11, 23, 11, 0), start, pausedAt: at(2026, 11, 23, 10, 20), time: "10:30" });
  assert.equal(ok, false, "start after the pause is refused");
  assert.equal(run(`state.running.start`), start);
}
{
  const { run } = app(); // running again, but a 30 min pause ate the time after 10:45
  const ok = editStart(run, { now: at(2026, 11, 23, 11, 0), start: at(2026, 11, 23, 10, 0), pausedMs: 30 * 60000, time: "10:45" });
  assert.equal(ok, false, "start inside the paused time is refused");
}

// Spring clock change (Berlin, 29 March 2026: 02:00 -> 03:00). At 01:00, "02:30" means yesterday 02:30, not 03:30.
{
  const { run } = app();
  editStart(run, { now: at(2026, 3, 29, 1, 0), start: at(2026, 3, 28, 1, 0), time: "02:30" });
  assert.equal(run(`state.running.start`), at(2026, 3, 28, 2, 30));
}

// CSV: local date first, with the offset, so every time maps back to the exact moment.
{
  const { run } = app();
  const fallBack = Date.UTC(2026, 9, 25, 0, 50); // Berlin 02:50 summer time; ends 02:10 winter time, after it
  const entries = [[fallBack, fallBack + 20 * 60000], [at(2026, 11, 23, 0, 30), at(2026, 11, 23, 1, 15)]]; // in export order
  run(`var csv; window.AndroidBridge = { peekNotificationEvents: () => "", saveFile: (f, c) => { csv = c; } };
       state.entries = ${JSON.stringify(entries)}.map(([start, end], i) => ({ id: "e" + i, projectId: project().id, title: "t", tagIds: [], start, end, pausedMs: 0 }));
       exportCsv()`);
  const rows = run(`csv`).split("\n").slice(1).map((r) => r.split('","'));
  rows.forEach((r, i) => {
    assert.equal(Date.parse(r[2]), entries[i][0], `start round-trips: ${r[2]}`);
    assert.equal(Date.parse(r[3]), entries[i][1], `end round-trips: ${r[3]}`);
    assert.equal(r[2].slice(0, 10), run(`toDateInput(${entries[i][0]})`), "local date, like the app");
  });
}

// Unreadable saves (projects but no tags makes loadState throw).
const broken = (n) => JSON.stringify({ projects: [{ id: "p", name: "Dutch" }], entries: [{ id: "keep-" + n }] });
const backups = (store) => [...store].filter(([k]) => k.startsWith("timetracker.v2.broken")).map(([, v]) => v);
{
  const files = [];
  const { run, store } = app({ stored: broken(1), bridge: new Proxy({ saveFile: (f, c) => files.push(c) }, { get: (o, k) => o[k] || (() => "") }) });
  assert.deepEqual(backups(store), [broken(1)], "copy kept in storage");
  assert.deepEqual(files, [broken(1)], "Android: copy saved as a file the user can reach");
  assert.match(run(`$("toast").textContent`), /couldn't be read/, "user is told");
}
{
  const { run, store } = app({ stored: broken(1) });
  store.set("timetracker.v2", broken(2)); // a later save breaks too, and is loaded a moment later
  run(`const realNow = Date.now; Date.now = () => realNow() + 1000; loadState()`);
  assert.deepEqual(backups(store).sort(), [broken(1), broken(2)].sort(), "second failure keeps the first copy");
}
{
  const { run, store } = app({ stored: broken(1), full: (k) => k.includes(".broken") });
  assert.equal(store.get("timetracker.v2"), broken(1), "no room for a copy: the original is not overwritten");
  assert.match(run(`$("toast").textContent`), /too full/, "startup warns");
  run(`$("toast").textContent = ""; state.entries.push({ id: "x" }); save()`);
  assert.equal(store.get("timetracker.v2"), broken(1), "...not by later saves either");
  assert.match(run(`$("toast").textContent`), /Not saved/, "every blocked save warns again");
}
// A browser that blocks storage still opens the app.
assert.doesNotThrow(() => app({ getThrows: true }));

console.log("bugs: all tests passed");
