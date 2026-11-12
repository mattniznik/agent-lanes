import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// The real command line, started with node. PATH points at an empty folder, so even on a machine
// with claude or codex installed, neither can be found or started.
const BIN = fileURLToPath(new URL("../bin/agent-lanes.mjs", import.meta.url));
const EXAMPLE = (name) => fileURLToPath(new URL(`../${name}`, import.meta.url));

function folder(t) {
  const root = mkdtempSync(join(tmpdir(), "agent-lanes-bin-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const emptyPath = join(root, "empty-path");
  mkdirSync(emptyPath);
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toUpperCase() !== "PATH"));
  const cli = (...args) => spawnSync(process.execPath, [BIN, ...args], { cwd: root, env: { ...env, PATH: emptyPath }, encoding: "utf8" });
  return { root, cli };
}

test("bin: fix --dry-run on the example files prints the plan and records nothing", (t) => {
  const { root, cli } = folder(t);
  copyFileSync(EXAMPLE("lanes.example.json"), join(root, "lanes.json"));
  copyFileSync(EXAMPLE("problems.example.json"), join(root, "problems.json"));
  const r = cli("fix", "--dry-run", "--problems", "problems.json");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Nightly build: would start an automatic fix on route "fix"\./);
  assert.match(r.stdout, /Codex lane sign-in needs a person: only a person can sign in\./);
  assert.match(r.stdout, /Newsletter publish needs a person: it is on the list of problems that need a person\./);
  assert.match(r.stdout, /Dry run: nothing recorded, nothing started\./);
  assert.equal(existsSync(join(root, "state", "fix-history.jsonl")), false);
});

test("bin: status with no CLI on PATH says so for every lane and starts nothing", (t) => {
  const { root, cli } = folder(t);
  copyFileSync(EXAMPLE("lanes.example.json"), join(root, "lanes.json"));
  const r = cli("status");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /-- {2}primary +claude +apiKey +claude is not installed/);
  assert.match(r.stdout, /-- {2}codex +codex +apiKey +codex is not installed/);
});

test("bin: run with no CLI on PATH reports that nothing could run, exit 1", (t) => {
  const { root, cli } = folder(t);
  copyFileSync(EXAMPLE("lanes.example.json"), join(root, "lanes.json"));
  const r = cli("run", "jobs", "say hello");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /primary: claude is not installed\. Moving to codex\./);
  assert.match(r.stderr, /codex: codex is not installed\. Stopped here/);
  assert.equal(r.stdout, "");
});

test("bin: a broken config, a missing one, or a wrong option is a usage error, exit 2", (t) => {
  const { root, cli } = folder(t);
  const missing = cli("status");
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /no config at .*lanes\.json/);
  writeFileSync(join(root, "lanes.json"), JSON.stringify({ lanes: { a: { cli: "claude", home: "~/.a", auth: "subscription" } }, routes: { jobs: { lane: "a", fallback: "ghost" } } }));
  const broken = cli("status");
  assert.equal(broken.status, 2);
  assert.match(broken.stderr, /route "jobs": unknown lane "ghost"/);
  assert.equal(cli("status", "--no-such-flag").status, 2);
});
