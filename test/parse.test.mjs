import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { claudeStatusOf, codexStatusOf, parseLine, summarize, toMs, usageLimitOf } from "../src/parse.mjs";

// Every fixture is fabricated in the shape of the CLIs' event lines. None comes from a real session.
const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const RESET = Date.parse("2026-03-02T12:00:00Z"); // resetsAt 1772452800 in the fixtures

test("usageLimitOf: a rejected rate_limit_event is the rate-limit signal; an allowed one and other events are not", () => {
  const line = '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1772452800,"rateLimitType":"five_hour"}}';
  assert.deepEqual(usageLimitOf(parseLine(line)), { resetsAt: RESET, type: "five_hour" });
  assert.equal(usageLimitOf(parseLine(line.replace("rejected", "allowed"))), null);
  assert.equal(usageLimitOf({ type: "assistant", error: "rate_limit", message: { content: [] } }), null, "only the rate_limit_event decides");
  assert.deepEqual(usageLimitOf({ type: "rate_limit_event", rate_limit_info: { status: "rejected" } }), { resetsAt: null, type: null }, "no reset time is still a refusal");
});

test("toMs: seconds and milliseconds both come out as milliseconds; missing or junk is null", () => {
  assert.equal(toMs(1772452800), RESET);
  assert.equal(toMs(RESET), RESET);
  for (const v of [null, undefined, "soon", 0, -5]) assert.equal(toMs(v), null, String(v));
});

test("parseLine: blank, broken and non-object lines are null, never a throw", () => {
  for (const line of ["", "   ", "{not json", "42", '"text"', "null"]) assert.equal(parseLine(line), null, line);
  assert.deepEqual(parseLine('{"type":"turn.started"}'), { type: "turn.started" });
});

test("claude stream: a run that used a tool and finished is ok, with its reply, cost and session", () => {
  const s = summarize(fixture("claude-ok.jsonl"), { cli: "claude", lane: "primary" });
  assert.deepEqual(
    [s.ok, s.text, s.didWork, s.limited, s.authFailed, s.costUsd, s.sessionId],
    [true, "One test failed: the date parser.", true, null, false, 0.0412, "00000000-0000-4000-8000-00000000c0a1"],
  );
});

test("claude stream: rate limited before any tool is limited and did no work", () => {
  const s = summarize(fixture("claude-rate-limited.jsonl"), { cli: "claude" });
  assert.equal(s.ok, false);
  assert.deepEqual(s.limited, { resetsAt: RESET, type: "five_hour" });
  assert.equal(s.didWork, false);
});

test("claude stream: rate limited after an edit is limited AND did work", () => {
  const s = summarize(fixture("claude-rate-limited-after-tool.jsonl"), { cli: "claude" });
  assert.equal(s.ok, false);
  assert.ok(s.limited);
  assert.equal(s.didWork, true);
});

test("claude stream: a refused login is authFailed, not a rate limit", () => {
  const s = summarize(fixture("claude-login-refused.jsonl"), { cli: "claude" });
  assert.deepEqual([s.ok, s.authFailed, s.limited, s.didWork], [false, true, null, false]);
  assert.match(s.error, /login was refused/);
});

test("claude stream: a clean stream with a non-zero exit is still a failure", () => {
  const s = summarize(fixture("claude-ok.jsonl"), { cli: "claude", exitCode: 1 });
  assert.deepEqual([s.ok, s.error], [false, "exit 1"]);
});

test("codex stream: the reply comes from the agent_message item; a failure carries its message; never limited", () => {
  const ok = summarize(fixture("codex-ok.jsonl"), { cli: "codex" });
  assert.deepEqual([ok.ok, ok.text, ok.sessionId, ok.limited], [true, "One test failed: the date parser.", "00000000-0000-7000-8000-00000000c0d1", null]);
  const failed = summarize(fixture("codex-failed.jsonl"), { cli: "codex" });
  assert.deepEqual([failed.ok, failed.error, failed.limited], [false, "stream disconnected before completion", null]);
});

test("claudeStatusOf: the login must be the kind the lane declares, in both directions; signed out is told apart", () => {
  const status = (code, j, auth) => claudeStatusOf({ code, stdout: JSON.stringify(j, null, 2) }, auth);
  const signedIn = { loggedIn: true, authMethod: "claude.ai", email: "lane-a@example.com" };
  const keyed = { loggedIn: true, authMethod: "api_key" };
  assert.deepEqual(status(0, signedIn, "subscription"), { ok: true, line: "claude.ai sign-in" });
  assert.deepEqual(status(0, keyed, "apiKey"), { ok: true, line: "API key" });
  assert.equal(JSON.stringify(status(0, signedIn, "subscription")).includes("@"), false, "the account email is never in the result");
  // A key where the lane expects its sign-in, or a sign-in where it expects a key: stop, not skip.
  assert.deepEqual(status(0, keyed, "subscription"), { ok: false, line: "signed in with api_key, but the lane is set to subscription" });
  assert.deepEqual(status(0, signedIn, "apiKey"), { ok: false, line: "signed in with claude.ai, but the lane is set to apiKey" });
  for (const authMethod of ["oauth_token", "api_key_helper", "third_party"])
    for (const auth of ["subscription", "apiKey"]) {
      const st = status(0, { loggedIn: true, authMethod }, auth);
      assert.deepEqual([st.ok, st.signedOut], [false, undefined], `${authMethod} on a ${auth} lane must stop the run`);
    }
  assert.deepEqual(status(1, { loggedIn: false, authMethod: "none" }, "subscription"), { ok: false, signedOut: true, line: "not signed in" });
  assert.deepEqual(claudeStatusOf({ code: null, timedOut: true }, "apiKey"), { ok: false, line: "the sign-in check did not answer" });
  assert.equal(claudeStatusOf({ code: 0, stdout: "Usage: claude ..." }, "subscription").ok, false);
});

test("codexStatusOf: read from the text (signed out was seen to exit 0) and held to the lane's auth both ways", () => {
  const chatgpt = { code: 0, stdout: "Logged in using ChatGPT\n" };
  const key = { code: 0, stdout: "Logged in using an API key\n" };
  assert.deepEqual(codexStatusOf(chatgpt, "subscription"), { ok: true, line: "Logged in using ChatGPT" });
  assert.deepEqual(codexStatusOf(key, "apiKey"), { ok: true, line: "Logged in using an API key" });
  assert.deepEqual(codexStatusOf(key, "subscription"), { ok: false, line: "signed in with an API key, but the lane is set to subscription" });
  assert.deepEqual(codexStatusOf(chatgpt, "apiKey"), { ok: false, line: "signed in with ChatGPT, but the lane is set to apiKey" });
  assert.deepEqual(codexStatusOf({ code: 0, stdout: "Not logged in\n" }, "apiKey"), { ok: false, signedOut: true, line: "not signed in" });
});
