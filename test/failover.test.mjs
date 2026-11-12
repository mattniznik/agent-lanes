import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { decideSwitch, isQuiet, laneState, laneWord, limitOf, readTranscript, refusalOf, UNKNOWN_RESET, wordsFor } from "../src/failover.mjs";

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const t = (iso) => Date.parse(iso);
const RESET = t("2026-03-02T12:00:00Z");
const MIN = 60_000;
const names = { primary: "Primary", secondary: "Secondary" };
const FREE = { down: false, limited: false };
const OUT = { down: false, limited: true, until: RESET };
const DOWN = { down: true, limited: false, since: t("2026-03-02T10:00:00Z") };
const base = { now: t("2026-03-02T11:00:00Z"), primary: "primary", names, timeZone: "UTC" };
const entries = () => fixture("session-transcript.jsonl").split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));

test("limitOf: the recorded rate-limit refusal, with its reset; a reply and a token-refresh race are not refusals", () => {
  const [, reply, , refusal, race] = entries();
  assert.deepEqual(limitOf(refusal), { at: t("2026-03-02T10:57:14Z"), resetsAt: RESET, type: "five_hour" });
  assert.equal(limitOf(reply), null);
  assert.equal(limitOf(race), null);
  assert.deepEqual(limitOf({ type: "assistant", isApiErrorMessage: true, timestamp: "2026-03-02T10:00:00Z", message: { content: [{ text: "You've hit your weekly limit" }] } }).resetsAt, null, "the text alone still counts");
});

test("refusalOf: a refused login counts; the refresh race, a rate limit and a reply do not", () => {
  const [, reply, , refusal, race] = entries();
  const refused = { type: "assistant", isApiErrorMessage: true, error: "authentication_failed", timestamp: "2026-03-02T11:05:00Z", message: { content: [{ text: "Failed to authenticate" }] } };
  assert.equal(refusalOf(refused), t("2026-03-02T11:05:00Z"));
  assert.equal(refusalOf({ ...refused, error: "unknown", message: { content: [{ text: "Not logged in · Please run /login" }] } }), t("2026-03-02T11:05:00Z"));
  for (const e of [race, refusal, reply]) assert.equal(refusalOf(e), null);
});

test("readTranscript: newest refusal, newest real reply, newest entry; a broken line is skipped", () => {
  const r = readTranscript(fixture("session-transcript.jsonl"));
  assert.equal(r.limit.at, t("2026-03-02T10:57:14Z"));
  assert.equal(r.okAt, t("2026-03-02T10:51:00Z"));
  assert.equal(r.refusedAt, null);
  assert.equal(r.lastAt, t("2026-03-02T11:02:00Z"));
});

test("laneState: the newest word decides; a refusal with no reset time is taken to last 5 hours", () => {
  const transcript = readTranscript(fixture("session-transcript.jsonl"));
  const words = wordsFor("primary", { transcript, running: "primary" });
  assert.deepEqual(laneState(words, t("2026-03-02T11:00:00Z")), { down: false, limited: true, until: RESET });
  assert.deepEqual(laneState(words, RESET + 1), FREE, "past the reset");
  assert.deepEqual(laneState(wordsFor("secondary", { transcript, running: "primary" }), t("2026-03-02T11:00:00Z")), FREE, "the transcript is only the running lane's");
  const later = [...words, { kind: "ok", at: t("2026-03-02T11:20:00Z") }];
  assert.deepEqual(laneState(later, t("2026-03-02T11:30:00Z")), FREE, "a reply that worked after the refusal");
  const bare = { kind: "limit", at: t("2026-03-02T10:00:00Z"), resetsAt: null };
  assert.equal(laneState([bare], t("2026-03-02T10:00:00Z") + UNKNOWN_RESET - 1).limited, true);
  assert.equal(laneState([bare], t("2026-03-02T10:00:00Z") + UNKNOWN_RESET).limited, false);
});

test("laneWord: a refused login in the run log keeps the lane down until a newer good run", () => {
  const refused = { at: "2026-03-02T10:00:00Z", lane: "secondary", ok: false, authFailed: true };
  const good = { at: "2026-03-03T09:00:00Z", lane: "secondary", ok: true };
  assert.equal(laneState([laneWord([refused], "secondary")], t("2026-03-04T00:00:00Z")).down, true, "no reset time for a sign-in");
  assert.equal(laneState([laneWord([refused, good], "secondary")], t("2026-03-04T00:00:00Z")).down, false);
  assert.equal(laneWord([refused], "primary"), null);
});

test("rate limited: the session moves to the next lane at once, without waiting for quiet", () => {
  const d = decideSwitch({ ...base, current: "primary", lanes: { primary: OUT, secondary: FREE }, quiet: false });
  assert.deepEqual(d, { action: "switch", from: "primary", to: "secondary", message: "Primary is rate limited until 12:00 PM. The session moved to Secondary." });
});

test("a refused login moves it too", () => {
  const d = decideSwitch({ ...base, current: "primary", lanes: { primary: DOWN, secondary: FREE } });
  assert.equal(d.action, "switch");
  assert.equal(d.message, "Primary cannot sign in. The session moved to Secondary.");
});

test("no flapping: at most one switch in 15 minutes", () => {
  const lanes = { primary: FREE, secondary: OUT };
  const soon = decideSwitch({ ...base, current: "secondary", lanes, lastSwitchAt: base.now - 10 * MIN });
  assert.equal(soon.action, "wait");
  assert.equal(decideSwitch({ ...base, current: "secondary", lanes, lastSwitchAt: base.now - 16 * MIN }).to, "primary");
});

test("every lane unavailable: one notice, never a switch, and the same notice is not sent twice", () => {
  const lanes = { primary: OUT, secondary: { down: false, limited: true, until: t("2026-03-02T14:30:00Z") } };
  const d = decideSwitch({ ...base, current: "primary", lanes });
  assert.equal(d.action, "notify");
  assert.equal(d.message, "Primary is rate limited until 12:00 PM, and Secondary is rate limited until 2:30 PM. Nothing switches; the session waits.");
  assert.equal(decideSwitch({ ...base, current: "primary", lanes, lastNotice: d.key }).action, "none");
});

test("never moves to a lane that cannot sign in", () => {
  const d = decideSwitch({ ...base, current: "primary", lanes: { primary: OUT, secondary: DOWN } });
  assert.equal(d.action, "notify");
  assert.match(d.message, /Secondary cannot sign in\. Nothing switches/);
});

test("back to the first lane only when it can run again and the session has been quiet for 3 minutes", () => {
  const free = { primary: FREE, secondary: FREE };
  assert.equal(decideSwitch({ ...base, current: "secondary", lanes: { primary: OUT, secondary: FREE }, quiet: true }).action, "none", "first lane still out");
  assert.equal(decideSwitch({ ...base, current: "secondary", lanes: free, quiet: isQuiet(base.now, base.now - MIN) }).action, "wait", "a reply may be in progress");
  const d = decideSwitch({ ...base, current: "secondary", lanes: free, quiet: isQuiet(base.now, base.now - 4 * MIN) });
  assert.deepEqual([d.action, d.to, d.message], ["switch", "primary", "Primary can run again. The session moved back to Primary."]);
  assert.equal(decideSwitch({ ...base, current: "primary", lanes: free, quiet: true }).action, "none", "already home");
});

test("a route with one lane: says so once and waits", () => {
  const d = decideSwitch({ ...base, current: "primary", lanes: { primary: OUT } });
  assert.deepEqual([d.action, d.message], ["notify", "Primary is rate limited until 12:00 PM and its route has no other lane. The session waits."]);
  assert.equal(decideSwitch({ ...base, current: "primary", lanes: { primary: OUT }, lastNotice: d.key }).action, "none");
  assert.equal(decideSwitch({ ...base, current: null, lanes: {} }).action, "none", "no session running");
});
