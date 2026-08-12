// Papers referenced by levels and by schedule recognition.
export const PAPERS = {
  gpipe: { label: 'GPipe (Huang et al. 2019)', url: 'https://arxiv.org/abs/1811.06965' },
  pipedream: { label: 'PipeDream 1F1B (Harlap et al. 2018)', url: 'https://arxiv.org/abs/1806.03377' },
  pipedreamFlush: { label: 'PipeDream-Flush (Narayanan et al. 2021)', url: 'https://arxiv.org/abs/2006.09503' },
  megatron: { label: 'Megatron interleaved 1F1B (Narayanan et al. 2021)', url: 'https://arxiv.org/abs/2104.04473' },
  zb: { label: 'Zero Bubble Pipeline Parallelism (Qi et al. 2023)', url: 'https://arxiv.org/abs/2401.10241' },
  controllable: { label: 'Controllable Memory / building blocks & ZB-V (Qi et al. 2024)', url: 'https://arxiv.org/abs/2405.15362' },
  dualpipe: { label: 'DualPipe (DeepSeek-V3, 2024)', url: 'https://arxiv.org/abs/2412.19437' },
};

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
    papers: ['gpipe'],
    blurb: `Four microbatches, one color each. While rank 1 works on
microbatch 0, rank 0 can already start microbatch 1 — that overlap is the
whole point of pipelining. Run all forwards, then all backwards (GPipe).
Keep an eye on the new scoreboard: idle slots are "bubble", and par is what
a decent schedule achieves.`,
  },
  {
    key: 'memory-wall',
    name: '3. The memory wall',
    cfg: { P: 4, V: 1, M: 4, model: '11', cap: 2 },
    policy: '1f1b',
    goal: 'complete',
    papers: ['pipedream'],
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
    papers: ['pipedreamFlush', 'megatron'],
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
    papers: ['controllable'],
    blurb: `A schedule is really ONE microbatch's trajectory — a "building
block" — repeated every 2 slots (Qi et al. 2024). So don't place 64 ops:
design the block. Schedule ONLY microbatch 0 (all its Fs and Bs, idling as
needed), then ⧉ stamp the next strand: microbatch 1 copies the block, 2
slots later. Each op aims for its pattern slot and gets SHOVED RIGHT
(flashing red) if something is in the way — a busy rank, an unfinished dep,
a full memory cap. Stamp strand by strand and watch whether your block
tiles cleanly or drifts; shift-click stamps all remaining at once. A
1F1B-shaped block tiles perfectly — that's what makes it the classic.`,
  },
  {
    key: 'interleaved',
    name: '6. Interleaved (VPP)',
    cfg: { P: 4, V: 2, M: 8, model: '11', cap: 8 },
    policy: '1f1b',
    goal: 'par',
    papers: ['megatron', 'controllable', 'dualpipe'],
    blurb: `Each rank now hosts two chunks, placed in a "V": chunk 0 runs
down ranks 0→3, chunk 1 runs back UP 3→0. So rank 0 has stages 0 and 7,
and rank 3 has 3 and 4 — a microbatch bounces off the pipe ends, and at
each bounce the next stage is on the SAME rank (no communication hop).
This is the placement ZB-V and DualPipe use. Follow microbatch 0's ghosts
and watch the V shape draw itself, then ⧉ stamp strand by strand — and
watch the shoves. A tight V block does NOT tile at w=4 (rank 0 already has
ops at both residues its neighbors need), so each stamped strand gets
shoved right of the pattern and the drift compounds. That drift is the
lesson: greedy repetition of a tight block loses to par (38), which
staggers the warmup instead. Compare with par (⇵), study where its extra
gaps are, then try designing a block with those gaps built in.`,
  },
  {
    key: 'ragged',
    name: '7. Ragged rounds (M % P ≠ 0)',
    cfg: { P: 3, V: 2, M: 4, model: '11', cap: 6, place: 'wrap' },
    policy: '1f1b',
    goal: 'par',
    papers: ['megatron'],
    blurb: `Four microbatches, three ranks: it doesn't divide. Interleaved
schedules move microbatches in "rounds", and the naive grouping is 3 + 1 —
that last undersized round is a straggler that drags a nearly-empty wave
through every chunk (makespan 24). The fix is bookkeeping, not physics:
balance it into ONE round of 4 (rounds = ⌊M/P⌋, size = ⌈M/rounds⌉), so the
leftover microbatch rides inside a full wave instead of forming its own
(makespan 22 — that's par). A round is a BAND of microbatches sweeping the
pipe, wider than the pipe itself; the warmup quota grows with round size
((P−r−1)·2 + (V−1)·G + 1). Wrap placement here because rounds are a
wrap-schedule concept — and at this size wrap-with-balanced-rounds (22)
beats the V placement (24). One more secret: par itself is NOT optimal
here — a hand-crafted schedule reaches 21. No simple greedy rule generates
it; if you find it, the banner will know. 🏆`,
  },
  {
    key: 'b-twice-f',
    name: '8. Backward costs 2×',
    cfg: { P: 4, V: 1, M: 8, model: '12', cap: 4 },
    policy: '1f1b',
    goal: 'par',
    papers: ['zb'],
    blurb: `Honest time model: backward takes two slots (it's roughly two
matmuls to the forward's one). The steady-state rhythm is unchanged — 1F1B
doesn't care about the ratio — but the block repeat interval is now w=3,
and bubbles cost more where backwards gate the critical path.`,
  },
  {
    key: 'zero-bubble',
    name: '9. Zero-bubble (F/B/W)',
    cfg: { P: 4, V: 1, M: 8, model: 'zb', cap: 4 },
    policy: 'zb',
    goal: 'par',
    papers: ['zb'],
    blurb: `Split the backward: B computes the input gradient (on the critical
path — the next rank is waiting for it) and W computes the weight gradient
(nobody is waiting — it can run whenever). Use W ops as filler to soak up
what would otherwise be bubbles, ZB-H1 style. Priority: B, then F, then W.
Same memory as 1F1B — W frees the activation, so delaying W costs memory.
(Everything here is unit-time for clarity; the papers' figures use B≈2F.
Try "split F/B/W, B=2F" in the sandbox for the honest version — the W-tetris
gets much more interesting when the pieces have different sizes.)`,
  },
  {
    key: 'zb-h2',
    name: '10. ZB-H2: buy zero with memory',
    cfg: { P: 4, V: 1, M: 8, model: 'zb', cap: 8, warmup: 'zb2' },
    policy: 'zb',
    goal: 'internal0',
    papers: ['zb'],
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
