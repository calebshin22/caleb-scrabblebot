// What the field pays per letter, from data/market.json (analyze.py).
// Loaded lazily and reloaded when the file changes.
import * as fs from "node:fs";
import * as path from "node:path";

const FILE = path.join(process.cwd(), "data", "market.json");
let cache: Record<string, { avg_paid: number; avg_top: number }> = {};
let mtime = 0;

export function marketPrice(letter: string): { avgPaid: number; avgTop: number } | null {
  try {
    const m = fs.statSync(FILE).mtimeMs;
    if (m !== mtime) {
      cache = JSON.parse(fs.readFileSync(FILE, "utf8")).letters ?? {};
      mtime = m;
    }
  } catch {
    return null;
  }
  const e = cache[letter];
  return e ? { avgPaid: e.avg_paid, avgTop: e.avg_top } : null;
}
