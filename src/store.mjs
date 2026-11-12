// JSON Lines files: the run log and the fix history. Append-only; a broken line is skipped, not fatal.

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

/** Every row of `file`, oldest first; [] when it does not exist yet. */
export function readJsonl(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
  return text.split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

/** Append `rows` to `file` in one write. */
export function appendJsonl(file, rows) {
  if (!rows.length) return;
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}
