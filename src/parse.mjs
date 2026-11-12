// What the two CLIs print, read into plain data. Pure: nothing here starts a process or reads a file.
//
// Claude Code, `claude -p --output-format stream-json --verbose`, one JSON event per line:
//   system/init        session_id
//   assistant          message.content[] holds a tool_use block when a tool is called, and the
//                      `error` field is "authentication_failed" when the login was refused
//   system/api_retry   the same `error` categories, sent before a retry
//   rate_limit_event   rate_limit_info.status "rejected" when requests are refused until resetsAt
//   result             result (the reply), is_error, subtype, total_cost_usd, session_id
// The SDK reference names rate_limit_event but did not document its fields when this was written.
// `status` and `resetsAt` are the names seen in real runs, so this file is the one place to change
// if the CLI renames them.
//
// Codex, `codex exec --json`: thread.started, item.completed (an agent_message item carries the
// reply), turn.failed and error. None of its events is documented as a rate limit, so a Codex run
// never reports `limited` and never hands over to another lane.

/** One line of a stream as an object, or null when it is blank or not a JSON object. */
export function parseLine(line) {
  if (!String(line ?? "").trim()) return null;
  try {
    const v = JSON.parse(line);
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

/** A reset time in seconds or milliseconds, as milliseconds, or null. The unit is not documented, so
 * a value below 1e12 is read as seconds (1e12 ms is a date in 2001). */
export function toMs(t) {
  const n = Number(t);
  if (t == null || !Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
}

/** The rate-limit signal in one Claude event: { resetsAt (ms or null), type }, or null. */
export function usageLimitOf(ev) {
  if (ev?.type !== "rate_limit_event") return null;
  const info = ev.rate_limit_info ?? {};
  if (info.status !== "rejected") return null;
  return { resetsAt: toMs(info.resetsAt), type: info.rateLimitType ?? null };
}

/** A fresh summary of one run on `lane`. */
export const newSummary = (lane) => ({
  lane,
  text: "",
  sessionId: null,
  costUsd: null,
  isError: false,
  error: null,
  limited: null,
  authFailed: false,
  didWork: false,
});

const usedTool = (ev) => ev.type === "assistant" && (ev.message?.content ?? []).some((c) => c?.type === "tool_use");

/** Fold one Claude event into summary `s`. Any tool counts as work, a read included: the rule that
 * uses it (routing.mjs afterLane) is safer simple than clever. */
export function readClaudeEvent(ev, s) {
  const limit = usageLimitOf(ev);
  if (limit) s.limited = limit;
  else if (ev.type === "system" && ev.subtype === "init") s.sessionId = ev.session_id ?? s.sessionId;
  else if (ev.error === "authentication_failed" && (ev.type === "assistant" || (ev.type === "system" && ev.subtype === "api_retry"))) {
    s.authFailed = true;
    s.error = "the login was refused - sign this lane in again";
  } else if (usedTool(ev)) s.didWork = true;
  else if (ev.type === "result") {
    s.sessionId = ev.session_id ?? s.sessionId;
    s.text = typeof ev.result === "string" ? ev.result : "";
    s.costUsd = ev.total_cost_usd ?? null;
    if (ev.is_error) {
      s.isError = true;
      s.error ||= ev.subtype && ev.subtype !== "success" ? ev.subtype : (s.text || "error").slice(0, 300);
    }
  }
  return s;
}

/** Fold one Codex event into summary `s`. */
export function readCodexEvent(ev, s) {
  if (ev.type === "thread.started") s.sessionId = ev.thread_id ?? s.sessionId;
  else if (ev.type === "item.completed" && ev.item?.type === "agent_message") s.text = ev.item.text ?? s.text;
  else if (ev.type === "turn.failed" || ev.type === "error") {
    s.isError = true;
    s.error = String(ev.error?.message ?? ev.message ?? "codex reported an error").slice(0, 300);
  }
  return s;
}

export const readerFor = (cli) => (cli === "claude" ? readClaudeEvent : readCodexEvent);

/** Close a summary once the process has exited with `code` (null when it never started). */
export function finishSummary(s, code) {
  s.exit = code;
  s.ok = code === 0 && !s.isError && !s.limited && !s.authFailed;
  if (!s.ok && !s.error) s.error = s.limited ? "rate limited" : code == null ? "did not start" : `exit ${code}`;
  return s;
}

/** A whole recorded stream, as the summary a run would give. */
export function summarize(text, { cli, lane = cli, exitCode = 0 } = {}) {
  const s = newSummary(lane);
  const read = readerFor(cli);
  for (const line of String(text).split(/\r?\n/)) {
    const ev = parseLine(line);
    if (ev) read(ev, s);
  }
  return finishSummary(s, exitCode);
}

// ---------- sign-in status ----------

/** The `authMethod` of `claude auth status` that each declared auth expects. */
const CLAUDE_METHOD = { subscription: "claude.ai", apiKey: "api_key" };

/**
 * `claude auth status`: JSON, exit 0 when signed in and 1 when not; `authMethod` is one of none,
 * claude.ai, oauth_token, api_key, api_key_helper, third_party (CLI reference). It must be the
 * method the lane declares (`auth`). Anything else is a credential the lane did not ask for.
 */
export function claudeStatusOf({ code, stdout = "", timedOut = false }, auth) {
  if (timedOut) return { ok: false, line: "the sign-in check did not answer" };
  const j = parseLine(stdout);
  if (!j) return { ok: false, line: "could not read the sign-in status" };
  if (code === 1 || j.loggedIn === false || j.authMethod === "none") return { ok: false, signedOut: true, line: "not signed in" };
  if (j.authMethod !== CLAUDE_METHOD[auth]) return { ok: false, line: `signed in with ${j.authMethod}, but the lane is set to ${auth}` };
  return { ok: true, line: auth === "apiKey" ? "API key" : "claude.ai sign-in" };
}

/** `codex login status`, read from its text: the exit code was seen to be 0 while signed out. A
 * ChatGPT sign-in is `subscription`, an API key login is `apiKey`. */
export function codexStatusOf({ code, stdout = "", stderr = "", timedOut = false }, auth) {
  if (timedOut) return { ok: false, line: "the sign-in check did not answer" };
  const text = `${stdout}${stderr}`.trim();
  if (/not logged in/i.test(text)) return { ok: false, signedOut: true, line: "not signed in" };
  if (code !== 0) return { ok: false, line: `the sign-in check exited ${code}` };
  const method = /api key/i.test(text) ? "apiKey" : "subscription";
  if (method !== auth) return { ok: false, line: `signed in with ${method === "apiKey" ? "an API key" : "ChatGPT"}, but the lane is set to ${auth}` };
  return { ok: true, line: text.split(/\r?\n/)[0] || "signed in" };
}
