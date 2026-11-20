// Goal, streak and recap-highlight logic. Run: node tests/goals.test.mjs
// Loads index.js against a stub DOM: every element accepts any call, and remembers what is assigned to it.
import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";

const any = new Proxy(function () {}, { get: (_, k) => (k === Symbol.toPrimitive ? () => "" : any), apply: () => any, set: () => true });
const el = () => { const s = {}; return new Proxy(function () {}, { get: (_, k) => (k in s ? s[k] : any), set: (_, k, v) => ((s[k] = v), true), apply: () => any }); };
const els = new Map();
const document = new Proxy({}, { get: (_, k) => (k === "getElementById" ? (id) => els.get(id) || els.set(id, el()).get(id) : any) });
const ctx = vm.createContext({ document, window: { addEventListener() {} }, localStorage: { getItem: () => null, setItem() {} }, setInterval() {}, setTimeout() {}, clearTimeout() {}, console });
vm.runInContext(readFileSync(new URL("../index.js", import.meta.url), "utf8"), ctx);
const run = (code) => vm.runInContext(code, ctx);

run(`
  var today = startOfDay(Date.now()), P = project();
  var mk = (off, mins) => { const s = addDays(today, off) + 3600000; return { id: uid(), projectId: P.id, title: "t", tagIds: [], start: s, end: s + mins * 60000, pausedMs: 0 }; };
`);

// Goal history: the latest `from` on or before a day wins, whatever the array order.
run(`P.goals = [{ from: addDays(today, -1), minutes: 45 }, { from: addDays(today, -9), minutes: 30 }]`);
assert.equal(run(`goalFor(P, addDays(today, -5))`), 30);
assert.equal(run(`goalFor(P, today)`), 45);
assert.equal(run(`goalFor(P, addDays(today, -10))`), 0);
run(`setGoal(P, 60); setGoal(P, 50)`); // two edits today -> one entry
assert.equal(run(`P.goals.filter((g) => g.from === today).length`), 1);
assert.equal(run(`goalFor(P, today)`), 50);

// Streaks count goal-met days; days before any goal count if tracked at all; an unfinished today doesn't break it.
run(`P.goals = [{ from: addDays(today, -10), minutes: 30 }];
     state.entries = [mk(-12, 5), mk(-4, 20), mk(-3, 30), mk(-2, 45), mk(-1, 31), mk(0, 10)]`);
assert.deepEqual({ ...run(`streakInfo(P, perDayTotals(P.id))`) }, { current: 3, best: 3 });
assert.equal(run(`dayTotal(P.id, today)`), 10 * 60000);

// "New day record" only on the session that crosses the old record, never on a project's first day.
const recap = () => els.get("recap").innerHTML;
run(`state.entries = [mk(0, 5)]; var a = mk(0, 5); state.entries.push(a); showRecap(a, true)`);
assert.ok(!recap().includes("day record"), "first day is not a record");
run(`state.entries = [mk(-1, 20), mk(0, 15)]; var b = mk(0, 10); state.entries.push(b); showRecap(b, true)`);
assert.ok(recap().includes("New day record") && !recap().includes("Busiest"), "record on crossing, without busiest-day");
run(`var c = mk(0, 5); state.entries.push(c); showRecap(c, true)`);
assert.ok(!recap().includes("day record"), "no repeat after the record");

console.log("goals: all tests passed");
