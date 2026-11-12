// Automatic fixes: when a monitored job breaks, may an agent run try to fix it? Pure: the history
// comes in as rows, and the file it lives in is read and appended by the caller (store.mjs).
//
// Never for what needs a person: a sign-in (only a person can sign in, and a run would be refused the
// same way), low disk (freeing space means deleting files), the fixer itself (a fix for the fixer
// could loop), and any key on the config's humanOnly list.
//
// Caps: capPerKey attempts per problem and capPerDay in all, over the last 24 hours, counted from an
// append-only history. Any other state file can be lost or rewritten, and that must not reset the
// caps; a sliding window means midnight does not reset them either. The caller writes the attempts
// before the run starts, so a run that crashes or is killed still counts.
//
// Notices are fixed phrases with the problem's subject, never the run's reply or an error message:
// either can hold anything, a token copied out of a log line included.

export const FIX_DEFAULTS = { route: "fix", capPerKey: 3, capPerDay: 8, humanOnly: [] };
export const CAP_WINDOW = 24 * 3600_000;

const ms = (t) => (t instanceof Date ? t.getTime() : typeof t === "number" ? t : Date.parse(t));

/** `*` is any text, everything else is literal: "task:publish-*". */
const matches = (pattern, key) =>
  new RegExp(`^${String(pattern).split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(key);

/** Why a problem gets no automatic fix, or null when it may get one. Keys: "task:<name>",
 * "run:<route>", "signin:<lane>", "disk", "fixer", or anything a monitor names. */
export function needsPerson(key, { route = FIX_DEFAULTS.route, humanOnly = [] } = {}) {
  const k = String(key);
  if (k.startsWith("signin:")) return "sign-in";
  if (k === "disk") return "disk";
  if (k === "fixer" || k === `run:${route}`) return "self";
  if (humanOnly.some((p) => matches(p, k))) return "listed";
  return null;
}

/** May `key` get a fix run at `now`, given every attempt so far ([{ key, at }])?
 * -> { ok: true } | { ok: false, why: "needs-person" | "key-cap" | "day-cap", reason } */
export function decideFix(key, history, now, opts = {}) {
  const o = { ...FIX_DEFAULTS, ...opts };
  const reason = needsPerson(key, o);
  if (reason) return { ok: false, why: "needs-person", reason };
  const t = ms(now);
  const recent = history.filter((e) => {
    const at = ms(e?.at);
    return at <= t && t - at < CAP_WINDOW;
  });
  if (recent.length >= o.capPerDay) return { ok: false, why: "day-cap" };
  if (recent.filter((e) => e.key === key).length >= o.capPerKey) return { ok: false, why: "key-cap" };
  return { ok: true };
}

/** Decisions for a batch of problems, in order. Each approved one counts against the caps of the
 * ones after it, so one batch cannot go past a cap. `attempts` are the rows to append. */
export function planFixes(problems, history, now, opts = {}) {
  const log = [...history];
  const at = new Date(ms(now)).toISOString();
  const plan = problems.map((problem) => {
    const decision = decideFix(problem.key, log, now, opts);
    if (decision.ok) log.push({ key: problem.key, at });
    return { problem, decision };
  });
  return { plan, attempts: log.slice(history.length) };
}

/** The name a notice uses: the problem's subject (or key), on one line, at most 80 characters. It
 * comes from the monitor that reported the problem, never from a model. */
export const subjectOf = (p) => String(p.subject || p.key).replace(/\s+/g, " ").trim().slice(0, 80);

const PERSON = {
  "sign-in": "only a person can sign in",
  disk: "freeing disk space means deleting files",
  self: "the fixer does not fix itself",
  listed: "it is on the list of problems that need a person",
};

/** Every line `fix` sends out. Nothing else reaches stdout. */
export function notice(kind, subject, { capPerKey = FIX_DEFAULTS.capPerKey, capPerDay = FIX_DEFAULTS.capPerDay, reason = null } = {}) {
  const lines = {
    starting: `${subject}: an automatic fix is starting.`,
    done: `${subject}: the automatic fix finished. The details are in the local log.`,
    failed: `${subject}: the automatic fix could not finish, so this one needs a person.`,
    "key-cap": `${subject}: the automatic fix already ran ${capPerKey} times in the last 24 hours, so this one needs a person.`,
    "day-cap": `${subject}: the automatic fixes reached their limit of ${capPerDay} in 24 hours, so this one needs a person.`,
    "needs-person": `${subject} needs a person: ${PERSON[reason] ?? "it is not fixed automatically"}.`,
  };
  if (!lines[kind]) throw new Error(`no notice "${kind}"`);
  return lines[kind];
}

/** The notice for a decision from decideFix. */
export const decisionNotice = (d, subject, opts = {}) => (d.ok ? notice("starting", subject, opts) : notice(d.why, subject, { ...opts, reason: d.reason }));

/** The prompt one fix run gets. The problem's detail goes to the model here, and nowhere outward. */
export function fixPrompt(problem) {
  return [
    `# Automatic fix: ${subjectOf(problem)}`,
    "",
    "A scheduled check found this broken and started you through agent-lanes. Nobody is watching this run.",
    "",
    "## What broke",
    "",
    `- Problem: ${subjectOf(problem)}${problem.detail ? ` - ${problem.detail}` : ""}`,
    `- Key: ${problem.key}`,
    `- Log: ${problem.log ?? "none recorded"}`,
    "",
    "## Rules",
    "",
    "- Never push, publish, deploy or send anything. Do not commit: leave the change in the working tree for a person to review.",
    "- Never re-run a job that sends, publishes or spends money. Prove the fix with its tests or a dry run.",
    "- Some commands are refused for this run by the route's deny rules. If one is refused, do not look for another way to run it.",
    "- If the cause is outside this machine's control (a sign-in, an outage, money, anything irreversible), stop and say so.",
    "",
    "## How",
    "",
    "1. Read the log and the failing script first. Find the exact line, setting or value.",
    "2. Fix the root cause with the smallest change that does it.",
    "3. Add or update a test that would have caught it, run it, and give the pass and fail counts.",
    "4. Your final reply goes to a local log, not to a person: two or three lines on what you did.",
  ].join("\n");
}
