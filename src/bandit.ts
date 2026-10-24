// Learns live which strategy variant ("arm") finishes best. Each match start
// picks the arm with the highest optimistic estimate (UCB, with a small
// exploration bonus: every match spent on a weak arm costs rating); reward is
// finishing place scaled 0..1 (1st = 1), since rating comes from place.
// State persists in data/bandit.json.
import * as fs from "node:fs";
import * as path from "node:path";

const FILE = path.join(process.cwd(), "data", "bandit.json");
type State = Record<string, { n: number; reward: number; sq?: number }>;

const load = (): State => {
  try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { return {}; }
};

const EXPLORE = 0.35;   // UCB1 uses ~1.41; lower plays the leader more
const PRIOR_N = 2;      // untried arms start as 2 matches at PRIOR_REWARD
const PRIOR_REWARD = 0.3;

export function pickArm(arms: string[]): string | null {
  const s = load();
  if (arms.length === 0) return null;
  const stat = (a: string) => ({
    n: (s[a]?.n ?? 0) + PRIOR_N,
    reward: (s[a]?.reward ?? 0) + PRIOR_N * PRIOR_REWARD,
  });
  const total = arms.reduce((t, a) => t + stat(a).n, 0);
  let best: string | null = null, bestScore = -1;
  for (const a of arms) {
    const { n, reward } = stat(a);
    const ucb = reward / n + EXPLORE * Math.sqrt(Math.log(total) / n);
    if (ucb > bestScore) { best = a; bestScore = ucb; }
  }
  return best;
}

export function recordResult(arm: string, placement: number, players: number) {
  const s = load();
  const a = (s[arm] ??= { n: 0, reward: 0, sq: 0 });
  const r = players > 1 ? (players - placement) / (players - 1) : 0;
  a.n += 1;
  a.reward += r;
  a.sq = (a.sq ?? 0) + r * r; // for the evolver's significance tests
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(s, null, 2) + "\n");
}
