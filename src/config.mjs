// lanes.json: the logins (lanes) and which of them does what (routes). See lanes.example.json.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { API_KEY_VARS } from "./env.mjs";
import { guarded, routeLanes } from "./routing.mjs";

export const CLIS = ["claude", "codex"];
export const AUTHS = ["subscription", "apiKey"];
const DEFAULT_FOLDER = { claude: ".claude", codex: ".codex" };
const positiveInt = (n) => Number.isInteger(n) && n > 0;

/** What is wrong with a config, one sentence each; [] when it is usable. Pure. */
export function checkConfig(config) {
  const errs = [];
  const lanes = config?.lanes ?? {};
  const routes = config?.routes ?? {};
  if (!Object.keys(lanes).length) errs.push("no lanes");
  for (const [id, l] of Object.entries(lanes)) {
    if (!CLIS.includes(l?.cli)) errs.push(`lane "${id}": cli must be ${CLIS.join(" or ")}`);
    if (typeof l?.home !== "string" || !l.home) errs.push(`lane "${id}": home is missing`);
    // Every lane says which credential it is meant to run with; laneEnv and the status check hold it to that.
    if (!AUTHS.includes(l?.auth)) errs.push(`lane "${id}": auth must be ${AUTHS.join(" or ")}`);
    else if (l.auth === "apiKey" && CLIS.includes(l.cli) && !API_KEY_VARS[l.cli].includes(l.keyEnv))
      errs.push(`lane "${id}": an apiKey lane needs keyEnv set to ${API_KEY_VARS[l.cli].join(" or ")}`);
    else if (l.auth === "subscription" && l.keyEnv !== undefined) errs.push(`lane "${id}": keyEnv is only for apiKey lanes`);
  }
  for (const [k, r] of Object.entries(routes)) {
    const ids = routeLanes(r);
    if (lanes[k]) errs.push(`"${k}" is both a lane and a route`);
    if (!ids.length) errs.push(`route "${k}": no lane`);
    for (const id of ids) if (!lanes[id]) errs.push(`route "${k}": unknown lane "${id}"`);
    if (new Set(ids).size !== ids.length) errs.push(`route "${k}": a lane is listed twice`);
    if (guarded(r) && !ids.some((id) => lanes[id]?.cli === "claude")) errs.push(`route "${k}": its deny rules are Claude Code rules, but it has no Claude lane`);
  }
  const fix = config?.fix;
  if (fix) {
    if (fix.route !== undefined && !routes[fix.route]) errs.push(`fix.route: no route "${fix.route}"`);
    for (const cap of ["capPerKey", "capPerDay"]) if (fix[cap] !== undefined && !positiveInt(fix[cap])) errs.push(`fix.${cap} must be a whole number above 0`);
    if (fix.humanOnly !== undefined && !Array.isArray(fix.humanOnly)) errs.push("fix.humanOnly must be a list of problem keys");
  }
  return errs;
}

/** One lane with `~` expanded, and `isDefault` when its folder is the CLI's usual one. Pure. */
export function resolveLane(config, id, homeDir, platform = process.platform) {
  const l = config.lanes[id];
  const home = resolve(l.home.replace(/^~(?=$|[\\/])/, homeDir));
  const usual = resolve(homeDir, DEFAULT_FOLDER[l.cli]);
  const isDefault = platform === "win32" ? home.toLowerCase() === usual.toLowerCase() : home === usual;
  return { id, cli: l.cli, auth: l.auth, keyEnv: l.keyEnv ?? null, home, isDefault };
}

/** Read and check a config file. Throws with every problem listed. */
export function loadConfig(file) {
  const config = JSON.parse(readFileSync(file, "utf8"));
  const errs = checkConfig(config);
  if (errs.length) throw new Error(`${file}:\n  ${errs.join("\n  ")}`);
  return config;
}
