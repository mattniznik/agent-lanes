import assert from "node:assert/strict";
import { test } from "node:test";

import { checkConfig, resolveLane } from "../src/config.mjs";

const lane = (cli, home, auth = "subscription", extra = {}) => ({ cli, home, auth, ...extra });

test("checkConfig: every problem is named, not just the first", () => {
  const errs = checkConfig({
    lanes: { a: lane("claude", "~/.a"), b: { cli: "gpt", home: "", auth: "subscription" }, x: lane("codex", "~/.x") },
    routes: {
      jobs: { lane: "a", fallback: ["ghost", "a"] },
      a: { lane: "a" },
      guarded: { lane: "x", denyCommands: ["git push*"] },
      empty: {},
    },
    fix: { route: "nowhere", capPerKey: 0 },
  });
  assert.deepEqual(errs, [
    'lane "b": cli must be claude or codex',
    'lane "b": home is missing',
    'route "jobs": unknown lane "ghost"',
    'route "jobs": a lane is listed twice',
    '"a" is both a lane and a route',
    'route "guarded": its deny rules are Claude Code rules, but it has no Claude lane',
    'route "empty": no lane',
    'fix.route: no route "nowhere"',
    "fix.capPerKey must be a whole number above 0",
  ]);
  assert.deepEqual(checkConfig({}), ["no lanes"]);
});

test("checkConfig: every lane declares its auth, and an apiKey lane names its own CLI's key variable", () => {
  const errs = (l) => checkConfig({ lanes: { l }, routes: {} });
  assert.deepEqual(errs(lane("claude", "~/.a", "apiKey", { keyEnv: "ANTHROPIC_API_KEY" })), []);
  assert.deepEqual(errs(lane("codex", "~/.c", "apiKey", { keyEnv: "OPENAI_API_KEY" })), []);
  assert.deepEqual(errs(lane("claude", "~/.a", "subscription")), []);
  assert.deepEqual(errs({ cli: "claude", home: "~/.a" }), ['lane "l": auth must be subscription or apiKey']);
  assert.deepEqual(errs(lane("claude", "~/.a", "oauth")), ['lane "l": auth must be subscription or apiKey']);
  assert.deepEqual(errs(lane("claude", "~/.a", "apiKey")), ['lane "l": an apiKey lane needs keyEnv set to ANTHROPIC_API_KEY']);
  assert.deepEqual(errs(lane("claude", "~/.a", "apiKey", { keyEnv: "OPENAI_API_KEY" })), ['lane "l": an apiKey lane needs keyEnv set to ANTHROPIC_API_KEY'], "another CLI's key");
  assert.deepEqual(errs(lane("claude", "~/.a", "apiKey", { keyEnv: "CLAUDE_CODE_OAUTH_TOKEN" })), ['lane "l": an apiKey lane needs keyEnv set to ANTHROPIC_API_KEY']);
  assert.deepEqual(errs(lane("claude", "~/.a", "subscription", { keyEnv: "ANTHROPIC_API_KEY" })), ['lane "l": keyEnv is only for apiKey lanes']);
});

test("resolveLane: ~ is the home folder, only the CLI's usual folder is the default lane, and auth comes along", () => {
  const config = {
    lanes: { p: lane("claude", "~/.claude", "apiKey", { keyEnv: "ANTHROPIC_API_KEY" }), s: lane("claude", "~/.claude-secondary"), c: lane("codex", "~/.codex") },
  };
  const posix = (id) => resolveLane(config, id, "/home/u", "linux");
  assert.deepEqual([posix("p").isDefault, posix("s").isDefault, posix("c").isDefault], [true, false, true]);
  assert.match(posix("s").home, /[\\/]home[\\/]u[\\/]\.claude-secondary$/);
  assert.deepEqual([posix("p").auth, posix("p").keyEnv, posix("s").auth, posix("s").keyEnv], ["apiKey", "ANTHROPIC_API_KEY", "subscription", null]);
  const upper = { lanes: { p: lane("claude", "~/.CLAUDE") } };
  assert.equal(resolveLane(upper, "p", "/home/u", "win32").isDefault, true, "Windows paths ignore case");
  assert.equal(resolveLane(upper, "p", "/home/u", "linux").isDefault, false);
});
