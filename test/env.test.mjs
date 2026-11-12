import assert from "node:assert/strict";
import { test } from "node:test";

import { HOME_VAR, KEY_VARS, keysSet, laneEnv, missingKey } from "../src/env.mjs";

// Invented values only; nothing here is a real key.
const PARENT = {
  PATH: "/usr/local/bin:/usr/bin",
  HOME: "/home/lane-user",
  LANG: "C.UTF-8",
  ANTHROPIC_API_KEY: "fake-key-1",
  anthropic_auth_token: "fake-key-2",
  CLAUDE_CODE_OAUTH_TOKEN: "fake-token-3",
  CLAUDE_CODE_USE_BEDROCK: "1",
  ANTHROPIC_PROFILE: "work",
  OPENAI_API_KEY: "fake-key-4",
  Codex_Api_Key: "fake-key-5",
  CLAUDE_CONFIG_DIR: "/home/lane-user/.claude-someone-else",
  CODEX_HOME: "/home/lane-user/.codex-someone-else",
};
const PRIMARY = { id: "primary", cli: "claude", auth: "subscription", home: "/home/lane-user/.claude", isDefault: true };
const SECONDARY = { id: "secondary", cli: "claude", auth: "subscription", home: "/home/lane-user/.claude-secondary", isDefault: false };
const KEYED = { id: "keyed", cli: "claude", auth: "apiKey", keyEnv: "ANTHROPIC_API_KEY", home: "/home/lane-user/.claude-ci", isDefault: false };
const CODEX_KEYED = { id: "codex", cli: "codex", auth: "apiKey", keyEnv: "OPENAI_API_KEY", home: "/home/lane-user/.codex-2", isDefault: false };
const has = (env, name) => Object.keys(env).some((k) => k.toUpperCase() === name);

test("laneEnv: a subscription lane runs with every credential variable removed, whatever its case", () => {
  for (const lane of [PRIMARY, SECONDARY]) {
    const env = laneEnv(lane, PARENT);
    for (const k of KEY_VARS) assert.equal(has(env, k), false, `${lane.id}: ${k}`);
    assert.deepEqual([env.PATH, env.HOME, env.LANG], [PARENT.PATH, PARENT.HOME, PARENT.LANG]);
  }
});

test("laneEnv: an apiKey lane keeps its own keyEnv and nothing else", () => {
  const env = laneEnv(KEYED, PARENT);
  assert.equal(env.ANTHROPIC_API_KEY, "fake-key-1");
  for (const k of KEY_VARS.filter((k) => k !== "ANTHROPIC_API_KEY")) assert.equal(has(env, k), false, k);
  const codex = laneEnv(CODEX_KEYED, PARENT);
  assert.equal(codex.OPENAI_API_KEY, "fake-key-4");
  assert.equal(has(codex, "ANTHROPIC_API_KEY"), false, "another CLI's key never rides along");
  assert.equal(has(codex, "CODEX_API_KEY"), false);
});

test("laneEnv: a lane with its own folder gets the folder variable; the default lane runs with it unset", () => {
  assert.equal(laneEnv(SECONDARY, PARENT).CLAUDE_CONFIG_DIR, SECONDARY.home);
  assert.equal(laneEnv(KEYED, PARENT).CLAUDE_CONFIG_DIR, KEYED.home);
  assert.equal(has(laneEnv(PRIMARY, PARENT), "CLAUDE_CONFIG_DIR"), false, "an inherited folder would point the default lane at another sign-in");
  const codex = laneEnv(CODEX_KEYED, PARENT);
  assert.equal(codex[HOME_VAR.codex], CODEX_KEYED.home);
  assert.equal(has(codex, "CLAUDE_CONFIG_DIR"), false);
});

test("laneEnv: the parent environment is left as it was", () => {
  const copy = { ...PARENT };
  laneEnv(KEYED, PARENT);
  laneEnv(SECONDARY, PARENT);
  assert.deepEqual(PARENT, copy);
});

test("missingKey: an apiKey lane whose variable is unset or empty says which; a subscription lane never does", () => {
  assert.equal(missingKey(KEYED, PARENT), null);
  assert.equal(missingKey(KEYED, { PATH: "/bin" }), "ANTHROPIC_API_KEY");
  assert.equal(missingKey(KEYED, { ANTHROPIC_API_KEY: "" }), "ANTHROPIC_API_KEY");
  assert.equal(missingKey(KEYED, { anthropic_api_key: "fake" }), null, "names compared without case");
  assert.equal(missingKey(SECONDARY, { PATH: "/bin" }), null);
});

test("keysSet: names the credential variables present, for the note in status", () => {
  assert.deepEqual(keysSet({ PATH: "/bin", ANTHROPIC_API_KEY: "x", openai_api_key: "y" }), ["ANTHROPIC_API_KEY", "openai_api_key"]);
  assert.deepEqual(keysSet({ PATH: "/bin" }), []);
});
