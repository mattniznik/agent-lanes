import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { checkConfig } from "../src/config.mjs";
import { summarize } from "../src/parse.mjs";
import { afterLane, claudeArgs, codexArgs, knownOut, pickLane, routeFlags, routeOrder, runRoute } from "../src/routing.mjs";

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const claudeRun = (name) => summarize(fixture(name), { cli: "claude" });

// Run results read from the recorded streams, so the lane loop is tested on what the parser makes.
const OK = claudeRun("claude-ok.jsonl");
const LIMITED_BEFORE_TOOL = claudeRun("claude-rate-limited.jsonl");
const LIMITED_AFTER_TOOL = claudeRun("claude-rate-limited-after-tool.jsonl");
const LOGIN_REFUSED = claudeRun("claude-login-refused.jsonl");
const CODEX_FAILED = summarize(fixture("codex-failed.jsonl"), { cli: "codex" });

const SIGNED_IN = { ok: true, line: "ready" };
const SIGNED_OUT = { ok: false, signedOut: true, line: "not signed in" };
const MISSING = { ok: false, missing: true, line: "codex is not installed" };
const WRONG_LOGIN = { ok: false, line: "signed in with api_key, but the lane is set to subscription" };

const CONFIG = {
  lanes: {
    primary: { cli: "claude", home: "~/.claude", auth: "subscription" },
    secondary: { cli: "claude", home: "~/.claude-secondary", auth: "subscription" },
    codex: { cli: "codex", home: "~/.codex", auth: "subscription" },
  },
  routes: {
    jobs: { lane: "primary", fallback: ["secondary", "codex"] },
    single: { lane: "primary", fallback: "secondary" },
    review: { lane: "codex" },
    fix: { lane: "primary", fallback: ["secondary", "codex"], denyCommands: ["git push*"] },
  },
};

/** Drive the real lane loop: lanes[id] = { status, outUntil, result }. */
async function drive(order, lanes) {
  const started = [];
  const notes = [];
  const out = await runRoute(order, {
    inspect: (id) => ({ status: lanes[id].status ?? SIGNED_IN, outUntil: lanes[id].outUntil ?? null }),
    exec: async (id) => (started.push(id), { ...lanes[id].result, lane: id }),
    note: (e) => notes.push(`${e.kind}:${e.id}`),
  });
  return { ...out, started, notes };
}

test("routeOrder: a route's lane then its fallback (a list or one lane); a lane named alone; anything else null", () => {
  assert.deepEqual(routeOrder(CONFIG, "jobs"), ["primary", "secondary", "codex"]);
  assert.deepEqual(routeOrder(CONFIG, "single"), ["primary", "secondary"]);
  assert.deepEqual(routeOrder(CONFIG, "review"), ["codex"]);
  assert.deepEqual(routeOrder(CONFIG, "secondary"), ["secondary"]);
  assert.equal(routeOrder(CONFIG, "nope"), null);
});

test("routeOrder: a guarded route never reaches Codex, which would run it without the deny rules", () => {
  assert.deepEqual(routeOrder(CONFIG, "fix"), ["primary", "secondary"]);
});

test("routeFlags: denied commands become rules for both shells; tool rules pass as written; MCP can be shut off", () => {
  assert.deepEqual(routeFlags({ denyCommands: ["git push*", "gh *"], denyTools: ["Read(./.env)"], strictMcp: true }), [
    "--strict-mcp-config",
    "--disallowedTools",
    "Bash(git push*)",
    "PowerShell(git push*)",
    "Bash(gh *)",
    "PowerShell(gh *)",
    "Read(./.env)",
  ]);
  assert.deepEqual(routeFlags({ lane: "primary" }), []);
  assert.deepEqual(routeFlags(null), []);
});

test("claudeArgs: stream-json, the route's permission mode, the guards last; the prompt is never an argument", () => {
  const args = claudeArgs({ permissionMode: "acceptEdits", denyCommands: ["gh *"] }, { model: "opus" });
  assert.deepEqual(args, ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits", "--model", "opus", "--disallowedTools", "Bash(gh *)", "PowerShell(gh *)"]);
  assert.deepEqual(claudeArgs(null), ["-p", "--output-format", "stream-json", "--verbose"], "a lane named directly gets the CLI's own defaults");
});

test("codexArgs: JSON events, the route's sandbox, stdin; a Claude model name is not passed to Codex", () => {
  assert.deepEqual(codexArgs({ sandbox: "workspace-write" }, { model: "opus" }), ["exec", "--json", "--sandbox", "workspace-write", "-"]);
  assert.deepEqual(codexArgs(null, { model: "gpt-x" }), ["exec", "--json", "--model", "gpt-x", "-"]);
});

test("signed out first lane: the job runs on the secondary, and the first lane is never started", async () => {
  const r = await drive(["primary", "secondary"], { primary: { status: SIGNED_OUT, result: OK }, secondary: { result: OK } });
  assert.deepEqual(r.started, ["secondary"]);
  assert.deepEqual(r.notes, ["skip:primary"]);
  assert.equal(r.res.ok, true);
});

test("a CLI that is not installed is skipped like a signed-out lane", async () => {
  const r = await drive(["codex", "primary"], { codex: { status: MISSING }, primary: { result: OK } });
  assert.deepEqual(r.started, ["primary"]);
});

test("rate limited before any tool (recorded stream): hands over, and the job's result is the secondary's", async () => {
  const r = await drive(["primary", "secondary"], { primary: { result: LIMITED_BEFORE_TOOL }, secondary: { result: OK } });
  assert.deepEqual(r.started, ["primary", "secondary"]);
  assert.deepEqual(r.notes, ["handover:primary"]);
  assert.deepEqual([r.res.lane, r.res.ok], ["secondary", true]);
});

test("a refused login before any tool (recorded stream): hands over too", async () => {
  const r = await drive(["primary", "secondary"], { primary: { result: LOGIN_REFUSED }, secondary: { result: OK } });
  assert.deepEqual(r.started, ["primary", "secondary"]);
  assert.equal(r.res.ok, true);
});

test("rate limited after an edit (recorded stream): stays on that lane, so the task is not done twice", async () => {
  const r = await drive(["primary", "secondary"], { primary: { result: LIMITED_AFTER_TOOL }, secondary: { result: OK } });
  assert.deepEqual(r.started, ["primary"]);
  assert.deepEqual(r.notes, ["kept:primary"]);
  assert.equal(r.res.ok, false);
});

test("a run that failed for another reason is not retried on the secondary", async () => {
  const r = await drive(["primary", "secondary"], { primary: { result: { ok: false, error: "exit 1", didWork: false, limited: null, authFailed: false } }, secondary: { result: OK } });
  assert.deepEqual(r.started, ["primary"]);
});

test("a Codex failure never hands over: Codex has no documented rate-limit event", async () => {
  const r = await drive(["codex", "primary"], { codex: { result: CODEX_FAILED }, primary: { result: OK } });
  assert.deepEqual(r.started, ["codex"]);
  assert.equal(r.res.ok, false);
});

test("a login of a different kind than the lane declares stops the run, even with a good secondary", async () => {
  const r = await drive(["primary", "secondary"], { primary: { status: WRONG_LOGIN, result: OK }, secondary: { result: OK } });
  assert.deepEqual(r.started, []);
  assert.deepEqual(r.stop, { id: "primary", why: WRONG_LOGIN.line });
});

test("the last lane signed out too: nothing runs and the reason is the last lane's", async () => {
  const r = await drive(["primary", "secondary"], { primary: { status: SIGNED_OUT }, secondary: { status: SIGNED_OUT } });
  assert.deepEqual(r.started, []);
  assert.deepEqual(r.stop, { id: "secondary", why: "not signed in" });
});

test("known to be rate limited: skipped without a start; the last lane still runs, the limit may have lifted", async () => {
  const until = Date.parse("2026-03-02T12:00:00Z");
  const skip = await drive(["primary", "secondary"], { primary: { outUntil: until, result: OK }, secondary: { result: OK } });
  assert.deepEqual(skip.started, ["secondary"]);
  const last = await drive(["primary", "secondary"], { primary: { outUntil: until, result: OK }, secondary: { outUntil: until, result: OK } });
  assert.deepEqual(last.started, ["secondary"]);
  const alone = await drive(["primary"], { primary: { outUntil: until, result: OK } });
  assert.deepEqual(alone.started, ["primary"]);
});

test("both lanes refused before any tool: both are tried once, the run fails, it does not loop", async () => {
  const r = await drive(["primary", "secondary"], { primary: { result: LIMITED_BEFORE_TOOL }, secondary: { result: LOGIN_REFUSED } });
  assert.deepEqual(r.started, ["primary", "secondary"]);
  assert.equal(r.res.ok, false);
});

test("pickLane: checks lanes only until one can run, and says why each before it was skipped", () => {
  const asked = [];
  const statuses = { primary: SIGNED_OUT, secondary: SIGNED_IN, codex: SIGNED_IN };
  const pick = pickLane(["primary", "secondary", "codex"], (id) => (asked.push(id), { status: statuses[id] }));
  assert.deepEqual(pick, { id: "secondary", index: 1, skipped: [{ id: "primary", why: "not signed in", until: null, next: "secondary" }] });
  assert.deepEqual(asked, ["primary", "secondary"], "codex's sign-in is not checked while secondary can run");
});

test("afterLane: only a refusal before any tool moves on", () => {
  assert.deepEqual(afterLane(OK), { step: "done", why: "ok" });
  assert.deepEqual(afterLane(LIMITED_BEFORE_TOOL), { step: "next", why: "rate limited" });
  assert.deepEqual(afterLane(LOGIN_REFUSED), { step: "next", why: "login refused" });
  assert.deepEqual(afterLane(LIMITED_AFTER_TOOL), { step: "done", why: "refused after a tool ran" });
});

test("knownOut: the newest refusal with its reset still ahead; a later good run, a passed reset or another lane say no", () => {
  const reset = Date.parse("2026-03-02T12:00:00Z");
  const now = Date.parse("2026-03-02T11:30:00Z");
  const row = (at, lane, extra) => ({ at, lane, ok: true, limited: null, ...extra });
  const refused = (at, lane) => row(at, lane, { ok: false, limited: { resetsAt: reset } });
  const rows = [row("2026-03-02T09:00:00Z", "primary"), refused("2026-03-02T10:57:00Z", "primary"), row("2026-03-02T10:58:00Z", "secondary")];
  assert.equal(knownOut(rows, "primary", now), reset);
  assert.equal(knownOut(rows, "secondary", now), null);
  assert.equal(knownOut(rows, "primary", reset + 1), null, "the reset has passed");
  assert.equal(knownOut([...rows, row("2026-03-02T11:10:00Z", "primary")], "primary", now), null, "it worked again after the refusal");
  assert.equal(knownOut([...rows, row("2026-03-02T11:10:00Z", "primary", { ok: false, error: "exit 1" })], "primary", now), reset, "another failure says nothing");
  assert.equal(knownOut([], "primary", now), null);
});

test("the shipped lanes.example.json is a valid config: jobs fall back across CLIs, the guarded fix route stays on Claude", () => {
  const example = JSON.parse(readFileSync(new URL("../lanes.example.json", import.meta.url), "utf8"));
  assert.deepEqual(checkConfig(example), []);
  const jobs = routeOrder(example, "jobs");
  assert.ok(jobs.length >= 2 && new Set(jobs.map((id) => example.lanes[id].cli)).size >= 2, `jobs: ${jobs.join(" -> ")}`);
  for (const id of routeOrder(example, example.fix.route)) assert.equal(example.lanes[id].cli, "claude", id);
});
