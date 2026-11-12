// Failover for a long-running session (a chat bot, for example). A single run falls back through its
// route (routing.mjs); a session that stays open needs a different decision: when to move it to the
// next lane in its route because its own lane is refused or rate limited, and when to move it back.
// Pure: the transcript text, the run log rows and the clock come in as arguments.
//
// - Refused or rate limited: move now, without waiting for quiet. The session cannot answer anyway.
// - At most one switch in 15 minutes, so two lanes that are both struggling cannot make it flap.
// - Never a switch when every other lane is unavailable too. That is said once, then nothing.
// - Back to the first lane only after 3 quiet minutes, so a reply being written is not cut off.
//
// The transcript fields read here (isApiErrorMessage, apiError, apiErrorParams.rate_limit_info) are
// the ones seen in Claude Code's session files. They are not a documented format.

import { toMs } from "./parse.mjs";

const MIN = 60_000;
export const SWITCH_GAP = 15 * MIN;
export const QUIET = 3 * MIN;
/** A refusal with no reset time is taken to last this long. */
export const UNKNOWN_RESET = 5 * 60 * MIN;

/** The refusal's own text, for entries without the structured fields. */
const HIT = /hit your .*limit/i;
const REFUSED = /Failed to authenticate|Not logged in|Please run \/login/i;
const textOf = (e) => (Array.isArray(e.message?.content) ? e.message.content : []).map((c) => c?.text ?? "").join(" ");

/** A rate-limit refusal in one transcript entry: { at, resetsAt, type }, or null. */
export function limitOf(e) {
  if (e?.type !== "assistant" || !e.isApiErrorMessage) return null;
  const info = e.apiErrorParams?.rate_limit_info ?? {};
  if (e.apiError !== "usage_limit_reached" && info.status !== "rejected" && !HIT.test(textOf(e))) return null;
  const at = Date.parse(e.timestamp);
  return Number.isFinite(at) ? { at, resetsAt: toMs(info.resetsAt), type: info.rateLimitType ?? null } : null;
}

/** A refused login in one transcript entry: its time, or null. A token refresh that raced another
 * process ("Failed to refresh OAuth token") is transient and does not count. */
export function refusalOf(e) {
  if (e?.type !== "assistant" || !e.isApiErrorMessage) return null;
  if (e.error !== "authentication_failed" && !REFUSED.test(textOf(e))) return null;
  const at = Date.parse(e.timestamp);
  return Number.isFinite(at) ? at : null;
}

/** A session transcript (JSONL text) -> newest rate-limit refusal, newest refused login, newest real
 * reply and newest entry of any kind. */
export function readTranscript(text) {
  const out = { limit: null, refusedAt: null, okAt: null, lastAt: null };
  for (const line of String(text).split(/\r?\n/)) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const at = Date.parse(e?.timestamp);
    if (!Number.isFinite(at)) continue;
    out.lastAt = Math.max(out.lastAt ?? 0, at);
    const limit = limitOf(e);
    const refused = limit ? null : refusalOf(e);
    if (limit) {
      if (!out.limit || limit.at >= out.limit.at) out.limit = limit;
    } else if (refused) out.refusedAt = Math.max(out.refusedAt ?? 0, refused);
    else if (e.type === "assistant" && !e.isApiErrorMessage) out.okAt = Math.max(out.okAt ?? 0, at);
  }
  return out;
}

/** The newest run-log row for `lane` that says anything about a limit or a sign-in, as one word. */
export function laneWord(rows, lane) {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r?.lane !== lane) continue;
    const at = Date.parse(r.at);
    if (r.authFailed) return { kind: "down", at };
    if (r.limited) return { kind: "limit", at, resetsAt: toMs(r.limited.resetsAt) };
    if (r.ok) return { kind: "ok", at };
  }
  return null;
}

/** Every word about lane `id`: the run log, and the transcript when the session runs on it. */
export function wordsFor(id, { rows = [], transcript = null, running = null }) {
  const t = running === id ? transcript : null;
  return [
    laneWord(rows, id),
    t?.limit ? { kind: "limit", ...t.limit } : null,
    t?.refusedAt ? { kind: "down", at: t.refusedAt } : null,
    t?.okAt ? { kind: "ok", at: t.okAt } : null,
  ];
}

/** Rate limited, or unable to sign in, at `now`? The newest word decides. A rate limit counts until
 * its reset; a refused login until a newer word says the lane works. */
export function laneState(words, now) {
  const w = words.filter((x) => x && Number.isFinite(x.at)).sort((a, b) => b.at - a.at)[0] ?? null;
  if (w?.kind === "down") return { down: true, limited: false, since: w.at };
  if (w?.kind !== "limit") return { down: false, limited: false };
  const until = w.resetsAt ?? w.at + UNKNOWN_RESET;
  return until > now ? { down: false, limited: true, until } : { down: false, limited: false };
}

/** Quiet long enough to restart the session without cutting a reply off. */
export const isQuiet = (now, lastActivityAt) => lastActivityAt == null || now - lastActivityAt >= QUIET;

/** "4:40 AM" in `timeZone` (the system's when unset). */
export const clockOf = (t, timeZone) =>
  new Date(t).toLocaleTimeString("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).replace(/\s/g, " ");

/**
 * What to do now.
 *   current   the lane the session runs on (null when it is not running)
 *   primary   the lane it belongs on when that lane can run
 *   lanes     { <id>: laneState } for the lanes of its route, in route order
 *   quiet     isQuiet(...)
 *   lastSwitchAt, lastNotice (the key of the last notice sent)
 * -> { action: "none" | "wait" | "switch" | "notify", from, to, message, key, why }
 */
export function decideSwitch({ now, current, primary = current, lanes, quiet = false, lastSwitchAt = null, lastNotice = null, names = {}, timeZone } = {}) {
  if (!current) return { action: "none", why: "no session is running" };
  const name = (id) => names[id] ?? id;
  const state = (id) => lanes[id] ?? { down: false, limited: false };
  const out = (id) => state(id).down || state(id).limited;
  const said = (id) => (state(id).down ? `${name(id)} cannot sign in` : `${name(id)} is rate limited until ${clockOf(state(id).until, timeZone)}`);
  const tag = (id) => (state(id).down ? `${id}:down:${state(id).since}` : `${id}:limit:${state(id).until}`);
  const recent = lastSwitchAt != null && now - lastSwitchAt < SWITCH_GAP;
  const once = (d) => (d.key === lastNotice ? { action: "none", why: `already said: ${d.message}` } : d);

  if (out(current)) {
    const others = Object.keys(lanes).filter((id) => id !== current);
    const to = others.find((id) => !out(id));
    if (!others.length) return once({ action: "notify", key: tag(current), message: `${said(current)} and its route has no other lane. The session waits.` });
    if (!to)
      return once({
        action: "notify",
        key: [current, ...others].map(tag).join("|"),
        message: `${said(current)}, and ${others.map(said).join(", ")}. Nothing switches; the session waits.`,
      });
    if (recent) return { action: "wait", why: `${said(current)}, but the last switch was less than 15 minutes ago` };
    return { action: "switch", from: current, to, message: `${said(current)}. The session moved to ${name(to)}.` };
  }
  if (current !== primary) {
    if (out(primary)) return { action: "none", why: `staying on ${name(current)}: ${said(primary)}` };
    if (recent) return { action: "wait", why: `${name(primary)} can run again, but the last switch was less than 15 minutes ago` };
    if (!quiet) return { action: "wait", why: `${name(primary)} can run again; waiting for 3 quiet minutes` };
    return { action: "switch", from: current, to: primary, message: `${name(primary)} can run again. The session moved back to ${name(primary)}.` };
  }
  return { action: "none", why: `${name(current)} is running and not rate limited` };
}
