import assert from "node:assert/strict";
import { test } from "node:test";

import { decideFix, decisionNotice, fixPrompt, needsPerson, notice, planFixes, subjectOf } from "../src/fix.mjs";

const NOW = new Date("2026-03-02T21:50:00Z");
const tries = (n, key, at) => Array.from({ length: n }, (_, i) => ({ key: typeof key === "function" ? key(i) : key, at }));

test("needsPerson: sign-ins, low disk, the fixer itself and listed keys never get a fix run", () => {
  assert.equal(needsPerson("signin:secondary"), "sign-in");
  assert.equal(needsPerson("disk"), "disk");
  assert.equal(needsPerson("fixer"), "self");
  assert.equal(needsPerson("run:fix"), "self", "a failed fix run is the fixer");
  assert.equal(needsPerson("run:repair", { route: "repair" }), "self", "whatever the fix route is called");
  assert.equal(needsPerson("task:publish-newsletter", { humanOnly: ["task:publish-*"] }), "listed");
  for (const k of ["task:nightly-build", "run:jobs", "task:publish", "diskette"]) assert.equal(needsPerson(k, { humanOnly: ["task:publish-*"] }), null, k);
});

test("decideFix: caps per problem and in all, over the last 24 hours", () => {
  assert.deepEqual(decideFix("task:build", [], NOW), { ok: true });
  const three = tries(3, "task:build", "2026-03-02T18:00:00Z");
  assert.equal(decideFix("task:build", three, NOW).why, "key-cap");
  assert.equal(decideFix("task:report", three, NOW).ok, true, "another problem has its own count");
  assert.equal(decideFix("task:build", tries(3, "task:build", "2026-03-01T21:00:00Z"), NOW).ok, true, "older than 24 hours");
  assert.equal(decideFix("task:build", tries(8, (i) => `task:job-${i}`, "2026-03-02T20:00:00Z"), NOW).why, "day-cap");
  assert.deepEqual(decideFix("signin:primary", [], NOW), { ok: false, why: "needs-person", reason: "sign-in" });
  assert.equal(decideFix("task:build", tries(1, "task:build", "2026-03-02T18:00:00Z"), NOW, { capPerKey: 1 }).why, "key-cap", "caps come from the config");
});

test("decideFix: midnight does not reset the caps; only 24 hours does", () => {
  const evening = tries(3, "task:build", "2026-03-02T23:50:00Z");
  assert.equal(decideFix("task:build", evening, new Date("2026-03-02T23:55:00Z")).why, "key-cap");
  assert.equal(decideFix("task:build", evening, new Date("2026-03-03T00:05:00Z")).why, "key-cap", "just past midnight");
  assert.equal(decideFix("task:build", evening, new Date("2026-03-03T23:50:01Z")).ok, true, "24 hours later");
});

test("decideFix: a history row with no readable time is ignored, not a crash", () => {
  assert.equal(decideFix("task:build", [{ key: "task:build", at: "yesterday" }, null, {}], NOW).ok, true);
});

test("planFixes: one batch cannot pass a cap; only approved attempts are recorded", () => {
  const problems = Array.from({ length: 10 }, (_, i) => ({ key: `task:job-${i}`, subject: `Job ${i}` }));
  const { plan, attempts } = planFixes(problems, [], NOW);
  assert.deepEqual(plan.map((p) => p.decision.ok), [true, true, true, true, true, true, true, true, false, false]);
  assert.equal(plan[8].decision.why, "day-cap");
  assert.equal(attempts.length, 8);
  assert.ok(attempts.every((a) => a.at === NOW.toISOString()));

  const same = planFixes(tries(4, "task:build").map((p) => ({ key: p.key })), tries(1, "task:build", "2026-03-02T21:00:00Z"), NOW);
  assert.deepEqual(same.plan.map((p) => p.decision.why ?? "ok"), ["ok", "ok", "key-cap", "key-cap"], "the same problem twice in a batch counts twice");
  assert.equal(planFixes([{ key: "disk", subject: "Disk" }], [], NOW).attempts.length, 0, "no attempt for a problem that needs a person");
});

test("notices: fixed phrases with the subject only; the problem's detail never appears", () => {
  const problem = { key: "task:build", subject: "Nightly\n build", detail: "RAW-DETAIL-7f3a from the log" };
  const subject = subjectOf(problem);
  assert.equal(subject, "Nightly build");
  const lines = [
    decisionNotice({ ok: true }, subject),
    decisionNotice({ ok: false, why: "key-cap" }, subject),
    decisionNotice({ ok: false, why: "day-cap" }, subject),
    decisionNotice({ ok: false, why: "needs-person", reason: "sign-in" }, subject),
    notice("done", subject),
    notice("failed", subject),
  ];
  assert.deepEqual(lines, [
    "Nightly build: an automatic fix is starting.",
    "Nightly build: the automatic fix already ran 3 times in the last 24 hours, so this one needs a person.",
    "Nightly build: the automatic fixes reached their limit of 8 in 24 hours, so this one needs a person.",
    "Nightly build needs a person: only a person can sign in.",
    "Nightly build: the automatic fix finished. The details are in the local log.",
    "Nightly build: the automatic fix could not finish, so this one needs a person.",
  ]);
  assert.ok(lines.every((l) => !l.includes("RAW-DETAIL")));
  assert.throws(() => notice("whatever the run said", subject));
  assert.equal(subjectOf({ key: "task:x", subject: "a".repeat(200) }).length, 80);
});

test("fixPrompt: the model gets the detail, the key, the log and the rules", () => {
  const p = fixPrompt({ key: "task:build", subject: "Nightly build", detail: "exited 1 at 02:00", log: "logs/build.log" });
  assert.match(p, /^# Automatic fix: Nightly build/);
  assert.match(p, /Problem: Nightly build - exited 1 at 02:00/);
  assert.match(p, /Key: task:build/);
  assert.match(p, /Log: logs\/build\.log/);
  assert.match(p, /Never push, publish, deploy or send anything\. Do not commit/);
  assert.match(p, /do not look for another way to run it/);
  assert.match(fixPrompt({ key: "task:x" }), /Log: none recorded/);
});
