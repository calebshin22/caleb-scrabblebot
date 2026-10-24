// Random source for strategy decisions. Math.random live; the tuner seeds it
// so replays are repeatable.
let source: () => number = Math.random;

export function rand(): number {
  return source();
}

export function seedRandom(seed: number) {
  source = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
