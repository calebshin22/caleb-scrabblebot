// Learns live which strategy variant ("arm") finishes best. Each match start
// picks the arm with the highest optimistic estimate (UCB1); reward is
// finishing place scaled 0..1 (1st = 1), since rating comes from place.
// State persists in data/bandit.json.
import * as fs from "node:fs";
import * as path from "node:path";

const FILE = path.join(process.cwd(), "data", "bandit.json");
type State = Record<string, { n: number; reward: number }>;

const load = (): State => {
  try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { return {}; }
};

export function pickArm(arms: string[]): string | null {
  const s = load();
  const untried = arms.find((a) => !s[a]?.n);
  if (untried) return untried;
  const total = arms.reduce((t, a) => t + s[a].n, 0);
  let best: string | null = null, bestScore = -1;
  for (const a of arms) {
    const ucb = s[a].reward / s[a].n + Math.sqrt((2 * Math.log(total)) / s[a].n);
    if (ucb > bestScore) { best = a; bestScore = ucb; }
  }
  return best;
}

export function recordResult(arm: string, placement: number, players: number) {
  const s = load();
  const a = (s[arm] ??= { n: 0, reward: 0 });
  a.n += 1;
  a.reward += players > 1 ? (players - placement) / (players - 1) : 0;
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(s, null, 2) + "\n");
}
