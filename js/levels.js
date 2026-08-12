// Level progression. Each level fixes a config and a coaching policy; its
// blurb states the lesson and `goal` the win condition:
//   'complete'  — any legal complete schedule
//   'par'       — complete with makespan <= the reference policy's
//   'internal0' — complete with 0% internal bubble
// UI features unlock as levels are reached (see FEATURE_INTRO in app.js).

export const LEVELS = [
  {
    key: 'first-steps',
    name: '1. First steps',
    cfg: { P: 2, V: 1, M: 1, model: '11', cap: null },
    policy: 'gpipe',
    goal: 'complete',
    blurb: `One microbatch, two ranks. Send its forward up the pipe (F on
rank 0, then rank 1), then its backward down (B on rank 1, then rank 0).
Bright ops are ready to run; dim ones aren't — hover one to see what it's
waiting for. When nothing is ready on a rank, the only move is to wait:
place an ⏸ idle.`,
  },
  {
    key: 'gpipe-intro',
    name: '2. Pipelining (GPipe)',
    cfg: { P: 2, V: 1, M: 4, model: '11', cap: null },
    policy: 'gpipe',
    goal: 'par',
    blurb: `Four microbatches, one color each. While rank 1 works on
microbatch 0, rank 0 can already start microbatch 1 — that overlap is the
whole point of pipelining. Run all forwards, then all backwards (GPipe).
Keep an eye on the new scoreboard: idle slots are "bubble", and par is what
a decent schedule achieves.`,
  },
  {
    key: 'memory-wall',
    name: '3. The memory wall',
    cfg: { P: 4, V: 1, M: 6, model: '11', cap: 2 },
    policy: '1f1b',
    goal: 'complete',
    blurb: `Bigger pipe, and a new rule: each rank can hold at most 2
microbatches of activations (the mem counter). Every forward holds memory
until its backward releases it. Try forwards-first, GPipe-style — you'll hit
the wall after two forwards. The only way through is to interleave backwards
between forwards. ANY complete schedule wins this level; don't worry about
speed yet. (Watch the memory strips above each lane fill and drain.)`,
  },
  {
    key: '1f1b',
    name: '4. 1F1B',
    cfg: { P: 4, V: 1, M: 8, model: '11', cap: 4 },
    policy: '1f1b',
    goal: 'par',
    blurb: `Level 3 forced you to interleave; this level asks for the RIGHT
interleaving: warmup (rank r admits P−r forwards), then strictly alternate
one forward, one backward. Par is makespan 22 — exactly the Megatron paper
figure. 64 ops is a lot of clicking, so you've unlocked power tools, in
order of how much they do for you: 💡 hint tells you the standard move,
step ▸ places it, and run-until-strange ▸▸ keeps placing it until something
interesting happens (a real choice, a bubble, a phase change) and stops.
Suggested play: do warmup and a few steady-state rounds by hand until you
feel the rhythm, then let ▸▸ grind and take over at the interesting bits.`,
  },
  {
    key: 'building-block',
    name: '5. The building block',
    cfg: { P: 4, V: 1, M: 8, model: '11', cap: 4 },
    policy: '1f1b',
    goal: 'par',
    blurb: `A schedule is really ONE microbatch's trajectory — a "building
block" — repeated every 2 slots (Qi et al. 2024). So don't place 64 ops:
design the block. Schedule ONLY microbatch 0 (all its Fs and Bs, idling as
needed), and a ⧉ stamp button appears with a prediction of the peak memory
your block implies — its per-rank lifespan (first F to last B) divided by
the repeat interval. Stamp it to replicate across all 8 microbatches. If
your block was 1F1B-shaped you just rebuilt level 4 in a tenth of the
clicks; if it was too eager, the stamp will name the constraint it breaks.`,
  },
  {
    key: 'interleaved',
    name: '6. Interleaved (VPP)',
    cfg: { P: 4, V: 2, M: 8, model: '11', cap: 8 },
    policy: '1f1b',
    goal: 'par',
    blurb: `Each rank now hosts two chunks: rank 0 has stages 0 and 4, etc.
A microbatch visits your rank twice up and twice down (the superscript is
the stage). 128 ops — lean on your tools. Try block-stamping first: designing
a block that tiles at all is a real puzzle here (each rank's ops must land on
distinct time-residues mod w=4). But notice the best uniform stamp is SLOWER
than par: Megatron's interleaved schedule moves microbatches in groups of P
rather than at uniform offsets, which is exactly why it beats naive
repetition. Stamp to get a legal baseline, then study the reference (⇵) to
see the group trick — or run-until-strange and steer at the choice points.`,
  },
  {
    key: 'b-twice-f',
    name: '7. Backward costs 2×',
    cfg: { P: 4, V: 1, M: 8, model: '12', cap: 4 },
    policy: '1f1b',
    goal: 'par',
    blurb: `Honest time model: backward takes two slots (it's roughly two
matmuls to the forward's one). The steady-state rhythm is unchanged — 1F1B
doesn't care about the ratio — but the block repeat interval is now w=3,
and bubbles cost more where backwards gate the critical path.`,
  },
  {
    key: 'zero-bubble',
    name: '8. Zero-bubble (F/B/W)',
    cfg: { P: 4, V: 1, M: 8, model: 'zb', cap: 4 },
    policy: 'zb',
    goal: 'par',
    blurb: `Split the backward: B computes the input gradient (on the critical
path — the next rank is waiting for it) and W computes the weight gradient
(nobody is waiting — it can run whenever). Use W ops as filler to soak up
what would otherwise be bubbles, ZB-H1 style. Priority: B, then F, then W.
Same memory as 1F1B — W frees the activation, so delaying W costs memory.`,
  },
  {
    key: 'zb-h2',
    name: '9. ZB-H2: buy zero with memory',
    cfg: { P: 4, V: 1, M: 8, model: 'zb', cap: 8, warmup: 'zb2' },
    policy: 'zb',
    goal: 'internal0',
    blurb: `ZB-H2 spends memory to kill the bubble: admit up to 2(P−r)−1
forwards in warmup (double the 1F1B quota), then use W ops as caulk so no
rank ever gaps between its first and last op. Target: internal bubble 0% —
the schedule is a parallelogram, and every remaining idle slot is just the
unavoidable fill/drain stagger. Peak memory hits ~2P on rank 0: you are
literally trading memory for bubble, and here you can see the exchange rate.`,
  },
];

export function levelByKey(key) {
  return LEVELS.find(l => l.key === key) ?? LEVELS[0];
}

export function levelIndex(key) {
  return LEVELS.findIndex(l => l.key === key);
}
