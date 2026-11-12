// The environment a lane's CLI runs in. Pure: it takes the parent environment and returns a new one.
//
// A lane declares the credential it is meant to use: "subscription" (the CLI's own sign-in, kept in
// the lane's folder) or "apiKey" (the variable its keyEnv names). Every other credential variable is
// removed. Claude Code's documented credential order ranks these variables above a signed-in login,
// and in print mode (-p) an ANTHROPIC_API_KEY is used whenever it is set. So one export left in a
// shell profile would change who is billed and which account acts, with no error at all.

/** Every credential variable a child run could pick up. Removed unless it is the lane's own keyEnv. */
export const KEY_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "ANTHROPIC_PROFILE",
  "ANTHROPIC_FEDERATION_RULE_ID",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
];

/** The key variable an apiKey lane may name in keyEnv, per CLI. */
export const API_KEY_VARS = { claude: ["ANTHROPIC_API_KEY"], codex: ["OPENAI_API_KEY"] };

/** The variable that points each CLI at a lane's own folder: its sign-in, settings and history. */
export const HOME_VAR = { claude: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME" };

const valueOf = (env, name) => Object.entries(env).find(([k]) => k.toUpperCase() === name)?.[1];

/**
 * `parent` without any credential variable except the lane's own keyEnv, without an inherited folder
 * variable, and with the lane's own folder. The default lane (the CLI's usual folder) runs with the
 * variable unset, so it behaves the way the CLI does when you type its name. Names are compared
 * without case, as Windows does.
 */
export function laneEnv(lane, parent) {
  const keep = lane.auth === "apiKey" ? lane.keyEnv : null;
  const drop = new Set([...KEY_VARS, ...Object.values(HOME_VAR)].filter((k) => k !== keep));
  const env = Object.fromEntries(Object.entries(parent).filter(([k]) => !drop.has(k.toUpperCase())));
  if (!lane.isDefault) env[HOME_VAR[lane.cli]] = lane.home;
  return env;
}

/** The keyEnv an apiKey lane needs but `parent` does not set, or null. */
export const missingKey = (lane, parent) => (lane.auth === "apiKey" && !valueOf(parent, lane.keyEnv) ? lane.keyEnv : null);

/** The credential variables set in `env`, for the note in `status`. */
export const keysSet = (env) => Object.keys(env).filter((k) => KEY_VARS.includes(k.toUpperCase()));
