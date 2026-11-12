import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createLanes } from "../src/cli.mjs";
import { claudeStatusOf, summarize } from "../src/parse.mjs";
import { readJsonl } from "../src/store.mjs";

// The real commands on a temp folder. find, check and spawnRun are fakes: no CLI is ever started.
// Two Claude lanes here test the generic mechanism; one declares an API key, one a sign-in.
const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const CONFIG = {
  lanes: {
    primary: { cli: "claude", home: "~/.claude", auth: "apiKey", keyEnv: "ANTHROPIC_API_KEY" },
    secondary: { cli: "claude", home: "~/.claude-secondary", auth: "subscription" },
    codex: { cli: "codex", home: "~/.codex", auth: "apiKey", keyEnv: "OPENAI_API_KEY" },
  },
  routes: {
    jobs: { lane: "primary", fallback: ["secondary", "codex"] },
    fix: { lane: "primary", fallback: "secondary", denyCommands: ["git push*"] },
  },
  fix: { route: "fix", capPerKey: 3, capPerDay: 8 },
};
const READY = { ok: true, line: "ready" };
const ENV = { PATH: "/fake/bin", ANTHROPIC_API_KEY: "fake-anthropic", OPENAI_API_KEY: "fake-openai" };

function rig(t, { statuses = {}, check = null, results = {}, env = ENV, now = "2026-03-02T11:00:00Z", onSpawn } = {}) {
  const root = mkdtempSync(join(tmpdir(), "agent-lanes-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  const spawned = [];
  const checked = [];
  const out = [];
  const err = [];
  const make = () =>
    createLanes({
      config: CONFIG,
      stateDir,
      cwd: root,
      env,
      homeDir: join(root, "home"),
      clock: () => new Date(now),
      timeZone: "UTC",
      find: (cli) => `/fake/bin/${cli}`,
      check: (lane, exe, laneEnv) => (checked.push({ id: lane.id, env: laneEnv }), check ? check(lane) : (statuses[lane.id] ?? READY)),
      spawnRun: async (call) => {
        spawned.push(call);
        onSpawn?.(call);
        const queue = results[call.lane];
        const res = Array.isArray(queue) ? queue.shift() : queue;
        return { ...(res ?? summarize(fixture("claude-ok.jsonl"), { cli: "claude" })), lane: call.lane };
      },
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    });
  return { make, lanes: make(), root, stateDir, spawned, checked, out, err, runs: () => readJsonl(join(stateDir, "runs.jsonl")) };
}

const LIMITED = () => summarize(fixture("claude-rate-limited.jsonl"), { cli: "claude" });

test("run: a refusal before any tool hands over; one log row per lane run, never the prompt", async (t) => {
  const r = rig(t, { results: { primary: LIMITED() } });
  const prompt = "Summarize logs/nightly-build.log - PROMPT-MARKER-91c2";
  const { res, tried, stop } = await r.lanes.run("jobs", prompt);
  assert.deepEqual([tried, stop, res.lane, res.ok], [["primary", "secondary"], null, "secondary", true]);
  assert.deepEqual(r.spawned.map((c) => c.prompt), [prompt, prompt], "the prompt goes to the CLI on stdin");
  assert.ok(r.spawned.every((c) => !c.args.includes(prompt)), "and never as an argument");
  const rows = r.runs();
  assert.deepEqual(rows.map((x) => [x.lane, x.ok, !!x.limited]), [["primary", false, true], ["secondary", true, false]]);
  assert.ok(!readFileSync(join(r.stateDir, "runs.jsonl"), "utf8").includes("PROMPT-MARKER"));
  assert.deepEqual(r.err, ["primary: rate limited before it used any tool. Moving to secondary."]);
});

test("run: each child keeps only its own lane's credential, and gets its own folder", async (t) => {
  const r = rig(t, { results: { primary: LIMITED() } });
  await r.lanes.run("jobs", "x");
  const [keyed, signedIn] = r.spawned;
  assert.equal(keyed.env.ANTHROPIC_API_KEY, "fake-anthropic", "the apiKey lane keeps its keyEnv");
  assert.equal(keyed.env.OPENAI_API_KEY, undefined, "and nothing else");
  assert.equal(keyed.env.CLAUDE_CONFIG_DIR, undefined, "the default folder runs as plain `claude`");
  assert.equal(signedIn.env.ANTHROPIC_API_KEY, undefined, "the subscription lane never sees a key");
  assert.equal(signedIn.env.OPENAI_API_KEY, undefined);
  assert.equal(signedIn.env.CLAUDE_CONFIG_DIR, join(r.root, "home", ".claude-secondary"));
  assert.equal(signedIn.env.PATH, "/fake/bin", "everything else is passed on");
  assert.deepEqual(r.checked.map((c) => [c.id, c.env.ANTHROPIC_API_KEY]), [["primary", "fake-anthropic"], ["secondary", undefined]], "the sign-in check sees the same environment as the run");
});

test("run: an apiKey lane whose key is not set is skipped without a check or a start", async (t) => {
  const r = rig(t, { env: { PATH: "/fake/bin", OPENAI_API_KEY: "fake-openai" } });
  const { tried } = await r.lanes.run("jobs", "x");
  assert.deepEqual(tried, ["secondary"]);
  assert.deepEqual(r.checked.map((c) => c.id), ["secondary"]);
  assert.deepEqual(r.err, ["primary: ANTHROPIC_API_KEY is not set. Moving to secondary."]);
});

test("run: a login of the wrong kind stops the run in both directions, before anything starts", async (t) => {
  // The real status reader on a fabricated `claude auth status`: everyone is signed in with claude.ai.
  const signedIn = (lane) => claudeStatusOf({ code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }) }, lane.auth);
  const keyedLane = rig(t, { check: signedIn });
  const a = await keyedLane.lanes.run("jobs", "x");
  assert.deepEqual([a.res, a.stop], [null, { id: "primary", why: "signed in with claude.ai, but the lane is set to apiKey" }]);
  assert.deepEqual(keyedLane.spawned, [], "not even the next lane runs: a person has to see this");

  const keyed = (lane) => claudeStatusOf({ code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "api_key" }) }, lane.auth);
  const subscriptionLane = rig(t, { check: keyed });
  const b = await subscriptionLane.lanes.run("secondary", "x");
  assert.deepEqual([b.res, b.stop], [null, { id: "secondary", why: "signed in with api_key, but the lane is set to subscription" }]);
  assert.deepEqual(subscriptionLane.spawned, []);
});

test("run: a lane the run log shows rate limited is skipped next time without being started", async (t) => {
  const r = rig(t, { results: { primary: [LIMITED()] } });
  await r.lanes.run("jobs", "first");
  r.spawned.length = 0;
  r.err.length = 0;
  await r.make().run("jobs", "second"); // a new process: only the run log carries what happened
  assert.deepEqual(r.spawned.map((c) => c.lane), ["secondary"]);
  assert.deepEqual(r.err, ["primary: rate limited until 12:00 PM. Moving to secondary."]);
});

test("run: a guarded route never starts Codex; an unknown target is an error", async (t) => {
  const out = { ok: false, signedOut: true, line: "not signed in" };
  const r = rig(t, { statuses: { primary: out, secondary: out } });
  const { res, stop } = await r.lanes.run("fix", "x");
  assert.deepEqual([res, stop], [null, { id: "secondary", why: "not signed in" }]);
  assert.deepEqual(r.spawned, []);
  assert.ok(!r.checked.some((c) => c.id === "codex"));
  await assert.rejects(r.lanes.run("nope", "x"), /neither a route/);
});

test("fix: stdout carries only fixed phrases, even when the run's reply and the problem hold secrets", async (t) => {
  const leaky = { ok: false, text: "REPLY-SECRET-55e1 copied from a log", error: "REPLY-SECRET-55e1", limited: null, authFailed: false, didWork: true };
  const r = rig(t, { results: { primary: leaky } });
  const problems = [
    { key: "task:nightly-build", subject: "Nightly build", detail: "DETAIL-SECRET-0b9d in the config" },
    { key: "signin:secondary", subject: "Secondary sign-in", detail: "DETAIL-SECRET-0b9d" },
  ];
  await r.lanes.fix(problems);
  assert.deepEqual(r.out, [
    "Nightly build: an automatic fix is starting.",
    "Nightly build: the automatic fix could not finish, so this one needs a person.",
    "Secondary sign-in needs a person: only a person can sign in.",
  ]);
  assert.match(r.spawned[0].prompt, /DETAIL-SECRET-0b9d/, "the detail goes to the model");
  const [saved] = readdirSync(join(r.stateDir, "fixes"));
  assert.match(readFileSync(join(r.stateDir, "fixes", saved), "utf8"), /REPLY-SECRET-55e1/, "the reply stays in the local log");
  assert.equal(r.spawned.length, 1, "the sign-in problem never started a run");
});

test("fix: the attempt is on disk before the run starts", async (t) => {
  let seen = null;
  const r = rig(t, { onSpawn: () => (seen = readJsonl(join(r.stateDir, "fix-history.jsonl"))) });
  await r.lanes.fix([{ key: "task:nightly-build", subject: "Nightly build" }]);
  assert.deepEqual(seen, [{ key: "task:nightly-build", at: "2026-03-02T11:00:00.000Z" }]);
});

test("fix: the caps hold across restarts, and losing the other state does not reset them", async (t) => {
  const r = rig(t);
  const problem = { key: "task:nightly-build", subject: "Nightly build" };
  for (let i = 0; i < 3; i++) await r.make().fix([problem]); // three separate processes
  rmSync(join(r.stateDir, "runs.jsonl"));
  r.out.length = 0;
  const before = r.spawned.length;
  await r.make().fix([problem]);
  assert.deepEqual(r.out, ["Nightly build: the automatic fix already ran 3 times in the last 24 hours, so this one needs a person."]);
  assert.equal(r.spawned.length, before);
});

test("fix --dry-run: prints the plan and the prompt, records nothing, starts nothing", async (t) => {
  const r = rig(t);
  await r.lanes.fix([{ key: "task:nightly-build", subject: "Nightly build", detail: "exited 1" }, { key: "disk", subject: "Disk" }], { dryRun: true });
  assert.equal(r.out[0], 'Nightly build: would start an automatic fix on route "fix".');
  assert.match(r.out[1], /# Automatic fix: Nightly build/);
  assert.equal(r.out[2], "Disk needs a person: freeing disk space means deleting files.");
  assert.equal(r.out.at(-1), "Dry run: nothing recorded, nothing started.");
  assert.deepEqual(r.spawned, []);
  assert.equal(existsSync(join(r.stateDir, "fix-history.jsonl")), false);
});

test("status: each lane with its declared auth, a rate limit from the run log, and a note on credential variables", async (t) => {
  const r = rig(t, { statuses: { secondary: { ok: false, signedOut: true, line: "not signed in" } }, results: { primary: [LIMITED()] } });
  await r.lanes.run("jobs", "x"); // primary is refused until 12:00 and the run moves on
  r.out.length = 0;
  r.lanes.status();
  const text = r.out.join("\n");
  assert.match(text, /-- {2}primary +claude +apiKey +ready .*\n +rate limited until 12:00 PM, by the run log/);
  assert.match(text, /-- {2}secondary +claude +subscription +not signed in/);
  assert.match(text, /OK {2}codex +codex +apiKey +ready/);
  assert.match(text, /fix +primary -> secondary {3}\(guarded: Claude lanes only\)/);
  assert.match(text, /Note: ANTHROPIC_API_KEY, OPENAI_API_KEY set in this shell\. Each lane run keeps only the one its keyEnv names\./);
});
