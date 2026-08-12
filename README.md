# Pipeline Schedule Tutor

An interactive puzzle for learning how pipeline-parallel training schedules
work (GPipe, 1F1B, interleaved/VPP, zero-bubble). You build the schedule *by
hand*, one op at a time, and the tool checks legality, traces dependencies,
tracks activation memory, and scores you against a reference policy.

**Play it: https://ezyang.github.io/pipeline-parallelism-tutor/**

Or locally: open `index.html` (any static server: `python3 -m http.server`).
No build step, no dependencies — plain ES modules.

## The idea

Reading a paper's schedule figure teaches you what the schedule *is*; placing
each `F`/`B`/`W` yourself — and getting told exactly why an illegal move is
illegal, or watching a lagging microbatch turn into a bubble ten slots later —
teaches you why it's *shaped* that way. Assistance is a ladder:

1. **validate only** — place anything; illegal moves are rejected with the
   reason (missing dep, dep finishes too late, memory cap).
2. **show ready set** — per-slot list of what could legally run now.
3. **coach** — a tiebreak policy (forwards-first / backward-first / B>F>W)
   suggests the standard move and flags *genuine* ties, i.e. real degrees of
   freedom.

Plus **step** (one policy move), **run until strange** (auto-play until a tie,
a forced bubble, or a phase transition — warmup→steady→drain), and **project
rest** (finish the schedule under the policy).

## Levels

The game teaches its own rules, puzzle-game style: UI elements (scoreboard,
coach, hint, run-until-strange, solve, sandbox settings) unlock as you clear
levels, so the interface grows with your understanding. "🔓 unlock all" skips
the progression.

1. **First steps** — P=2, M=1; the dependency rules and the idle move.
2. **Pipelining (GPipe)** — P=2, M=4; overlap, bubbles, par.
3. **The memory wall** — cap=2 forces you to interleave backwards at all.
4. **1F1B** — P=4, M=8; the *right* interleaving (Megatron figure, makespan
   22, bubble 3/11).
5. **The building block** — schedule ONE microbatch's trajectory, then ⧉
   stamp it across all 8 (Qi et al. 2024, "controllable memory"): the
   block's per-rank lifespan predicts peak memory before you commit.
6. **Interleaved (VPP)** — P=4, V=2; each rank hosts two chunks.
7. **Backward costs 2×** — the honest B=2F time model; block interval w=3.
8. **Zero-bubble (F/B/W)** — split backward into input-grad B (critical path)
   and weight-grad W (filler). ZB-H1 style.
9. **ZB-H2** — double the warmup quota, spend memory, and aim for **0%
   internal bubble**.

Plus a **sandbox** (unlocked with level 4): set PP/VPP/microbatch count, time
model, memory cap, and warmup depth freely.

Scoring: makespan, bubble fraction, *internal* bubble (idle between each
rank's own first and last op — ignores unavoidable fill/drain stagger), peak
in-flight activations per rank vs. the cap.

## Extras

- Click any empty slot to place an op there (gaps auto-fill with idles,
  committed atomically); click a placed op to rewind; click an idle in a
  finished-prefix to fill it with work.
- **✏️ free edit**: lift/move/unplace ops with invariants temporarily broken;
  live violation list says whether the holes are fixable (and autofills ops
  that have exactly one legal slot); only a consistent plan commits.
- **▶ play**: animate the schedule — a time cursor sweeps, the op running on
  each rank lights up, with a narration line per tick.
- On completion: schedule **recognition** ("You built 1F1B / ZB-H2 / …" or
  "this one's yours"), **🔦 critical path** (with voluntary-delay detection),
  **⇵ compare with par** on a shared time axis, and per-bubble explanations
  on idle hover ("this bubble exists because…").
- Hover any op to trace deps (red = needs, green = unblocks); in coach mode,
  hovering a candidate ghost-projects the consequence and its makespan cost.
- Per-rank activation-memory strips above each lane (red at the cap).
- Best solutions auto-save per level (✓ in the level list, 📂 to reload);
  🔗 share copies a URL reproducing the exact position.
- Color themes: microbatch-colored (default, colorblind-validated palette,
  light+dark), or "paper style" (kind-colored like the Megatron / zero-bubble
  figures).
- The URL hash always encodes your schedule — share a half-finished position
  as an exercise.
- `node cli.mjs <level> "0F0 1. 1F0 ..."` — text interface to the same
  engine (`--list` for levels, `--auto`, `--project`).
- `node --test tests/` — engine unit tests.

## Architecture

- `js/engine.js` — pure simulation: ops, deps, legality, memory, phases,
  policies, projection, scoring. No DOM.
- `js/levels.js` — level configs + coaching policy + blurbs.
- `js/palettes.js` — color themes.
- `js/app.js` — UI. `cli.mjs` — terminal UI over the same engine.

Time models: uniform (F=B=1), honest (B=2F), split (F=B=W=1, weight grad
frees the activation). Communication is free (a dep enables the next slot);
stage→rank placement is data-driven (`rank r` hosts stages `r, r+P, …`), so
bidirectional placements (DualPipe/Chimera) are a future data change, not a
rewrite.
