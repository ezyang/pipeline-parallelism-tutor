// Level progression. Each level fixes a config and a coaching policy, and its
// blurb states the lesson. `par` is computed from the reference schedule.

export const LEVELS = [
  {
    key: 'gpipe-intro',
    name: '1. GPipe basics',
    cfg: { P: 2, V: 1, M: 4, model: '11', cap: null },
    policy: 'gpipe',
    blurb: `Two ranks, four microbatches, everything takes one slot.
Run every forward, then every backward (that's GPipe). Learn the rules:
a forward needs the forward below it; a backward needs the backward above it
(or the last forward, at the last stage). Watch the in-flight counter climb —
that's activation memory, and it's the villain of this story.`,
  },
  {
    key: 'memory-wall',
    name: '2. The memory wall',
    cfg: { P: 4, V: 1, M: 8, model: '11', cap: 4 },
    policy: '1f1b',
    blurb: `Same GPipe idea, but now each rank can hold at most 4 microbatches
of activations. Try forwards-first and you'll hit the wall: the cap forces a
backward before more forwards. Whatever legal schedule you find, you are about
to re-invent 1F1B. (Hint: once a backward becomes possible, take it.)`,
  },
  {
    key: '1f1b',
    name: '3. 1F1B',
    cfg: { P: 4, V: 1, M: 8, model: '11', cap: 4 },
    policy: '1f1b',
    blurb: `The classic. Warmup: rank r admits P−r forwards. Steady state:
alternate one forward, one backward. Drain: finish the backwards. Par is
makespan 22 with bubble 3/11 — exactly the Megatron paper figure. Don't let a
microbatch's forward lag, or you'll pay for it as a bubble when its backward
comes due.`,
  },
  {
    key: 'b-twice-f',
    name: '4. Backward costs 2×',
    cfg: { P: 4, V: 1, M: 8, model: '12', cap: 4 },
    policy: '1f1b',
    blurb: `Same schedule, honest time model: backward takes two slots (it's
roughly two matmuls to the forward's one). Notice the steady-state rhythm is
unchanged — 1F1B doesn't care about the ratio — but bubbles now cost more
where backwards gate the critical path.`,
  },
  {
    key: 'interleaved',
    name: '5. Interleaved (VPP)',
    cfg: { P: 4, V: 2, M: 8, model: '11', cap: 8 },
    policy: '1f1b',
    blurb: `Each rank now hosts two chunks: rank 0 has stages 0 and 4, etc.
A microbatch visits your rank twice on the way up and twice on the way down.
Warmup admits more forwards ((P−r−1)·2 + P), the bubble shrinks by ~V, and
memory grows. This is the level where "run until something strange happens"
earns its keep.`,
  },
  {
    key: 'zero-bubble',
    name: '6. Zero-bubble (F/B/W)',
    cfg: { P: 4, V: 1, M: 8, model: 'zb', cap: 4 },
    policy: 'zb',
    blurb: `Split the backward: B computes the input gradient (on the critical
path — the next rank is waiting for it) and W computes the weight gradient
(nobody is waiting — it can run whenever). Use W ops as filler to soak up what
would otherwise be bubbles, ZB-H1 style. Priority: B, then F, then W. Same
memory as 1F1B (W frees the activation, so B+W together behave like the old
backward), but the drain-phase bubble fills with useful work.`,
  },
  {
    key: 'zb-h2',
    name: '7. ZB-H2: buy zero with memory',
    cfg: { P: 4, V: 1, M: 8, model: 'zb', cap: 8, warmup: 'zb2' },
    policy: 'zb',
    blurb: `ZB-H2 spends memory to kill the bubble: admit up to 2(P−r)−1
forwards in warmup (double the 1F1B quota), then use W ops as caulk so no
rank ever gaps between its first and last op. Target: internal bubble 0% —
the schedule is a parallelogram, and every remaining idle slot is just the
unavoidable fill/drain stagger. Peak memory hits 2P−1 ≈ 8 on rank 0: you are
literally trading memory for bubble, and here you can see the exchange rate.`,
  },
];

export function levelByKey(key) {
  return LEVELS.find(l => l.key === key) ?? LEVELS[0];
}
