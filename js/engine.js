// Pipeline schedule simulation engine.
// Pure logic, no DOM. Time is integer slots; ops occupy [start, start+dur).

// --- Config ---------------------------------------------------------------
// {
//   P: pipeline ranks, V: virtual chunks per rank, M: microbatches,
//   model: '11' (F=1,B=1) | '12' (F=1,B=2) | 'zb' (F=1,B=1,W=1 split grads),
//   cap: max in-flight activations per rank (null = unlimited),
// }

export function durations(model) {
  if (model === '12') return { F: 1, B: 2 };
  if (model === 'zb') return { F: 1, B: 1, W: 1 };
  return { F: 1, B: 1 };
}

export function opKinds(model) {
  return model === 'zb' ? ['F', 'B', 'W'] : ['F', 'B'];
}

export function numStages(cfg) {
  return cfg.P * cfg.V;
}

// Stage->rank placement.
//   'wrap' (Megatron interleaved): rank r hosts stages r, r+P, r+2P, ...
//   'v' (ZB-V / DualPipe style): odd chunks run in REVERSE rank order, so the
//     last stage of one chunk and the first of the next share a rank — the
//     microbatch's path bounces off the ends (a "V"), avoiding the comm hop
//     at each turn. Default for V>1.
export function placement(cfg) {
  return cfg.place ?? (cfg.V > 1 ? 'v' : 'wrap');
}

export function stageRank(cfg, stage) {
  const P = cfg.P;
  if (placement(cfg) === 'v') {
    const chunk = Math.floor(stage / P), pos = stage % P;
    return chunk % 2 === 0 ? pos : P - 1 - pos;
  }
  return stage % P;
}

export function rankStages(cfg, rank) {
  const out = [];
  for (let s = 0; s < numStages(cfg); s++) if (stageRank(cfg, s) === rank) out.push(s);
  return out;
}

export function opId(kind, stage, mb) {
  return `${kind}${stage}_${mb}`;
}

export function allOps(cfg) {
  const S = numStages(cfg);
  const kinds = opKinds(cfg.model);
  const dur = durations(cfg.model);
  const ops = [];
  for (const kind of kinds) {
    for (let s = 0; s < S; s++) {
      for (let m = 0; m < cfg.M; m++) {
        ops.push({ id: opId(kind, s, m), kind, stage: s, mb: m,
                   rank: stageRank(cfg, s), dur: dur[kind] });
      }
    }
  }
  return ops;
}

// Direct dependencies of an op (transitive deps implied).
export function depsOf(cfg, op) {
  const S = numStages(cfg);
  const out = [];
  if (op.kind === 'F') {
    if (op.stage > 0) out.push(opId('F', op.stage - 1, op.mb));
  } else if (op.kind === 'B') {
    if (op.stage === S - 1) out.push(opId('F', S - 1, op.mb));
    else out.push(opId('B', op.stage + 1, op.mb));
    // B(s,m) also needs its own forward; transitive via the chain above,
    // but state it directly so error messages point at the real blocker.
    if (op.stage < S - 1) out.push(opId('F', op.stage, op.mb));
  } else if (op.kind === 'W') {
    out.push(opId('B', op.stage, op.mb));
  }
  return out;
}

// --- Schedule state --------------------------------------------------------
// Actions: {rank, type:'op', id} | {rank, type:'idle'}
// State is rebuilt by replaying actions (undo/redo = slicing the list).

export function newState(cfg) {
  const ops = allOps(cfg);
  const byId = new Map(ops.map(o => [o.id, o]));
  return {
    cfg, ops, byId,
    placed: new Map(),                    // id -> {start, end}
    rows: Array.from({ length: cfg.P }, () => []),   // [{id|null, start, dur}]
    frontier: new Array(cfg.P).fill(0),
    inflight: new Array(cfg.P).fill(0),   // activations held right now
    fbDepth: new Array(cfg.P).fill(0),    // forwards minus backwards (policy depth)
    peak: new Array(cfg.P).fill(0),
    firstB: new Array(cfg.P).fill(null),  // time of first backward per rank
    lastF: new Array(cfg.P).fill(null),
    actions: [],
  };
}

export function pendingOps(state, rank) {
  return state.ops.filter(o => o.rank === rank && !state.placed.has(o.id));
}

export function isDone(state) {
  return state.placed.size === state.ops.length;
}

// Why can't `op` start at time t on its rank? Returns null if it can.
export function blockReason(state, op, t) {
  if (state.placed.has(op.id)) return { code: 'placed', msg: `${op.id} is already scheduled` };
  for (const depId of depsOf(state.cfg, op)) {
    const p = state.placed.get(depId);
    const dep = state.byId.get(depId);
    if (!p) return { code: 'dep-unscheduled', dep: depId,
      msg: `needs ${label(dep)} (rank ${dep.rank}), which hasn't been scheduled yet` };
    if (p.end > t) return { code: 'dep-late', dep: depId, readyAt: p.end,
      msg: `needs ${label(dep)}, which finishes at t=${p.end}` };
  }
  if (op.kind === 'F' && state.cfg.cap != null &&
      state.inflight[op.rank] >= state.cfg.cap) {
    return { code: 'memory', msg:
      `memory cap: rank ${op.rank} already holds ${state.inflight[op.rank]} ` +
      `in-flight activations (cap ${state.cfg.cap}) — a backward must run first` };
  }
  return null;
}

// Earliest time op could legally start given current placements (Infinity if a
// dep is unscheduled). Ignores the memory cap (which depends on future order).
export function earliestStart(state, op) {
  let t = 0;
  for (const depId of depsOf(state.cfg, op)) {
    const p = state.placed.get(depId);
    if (!p) return Infinity;
    t = Math.max(t, p.end);
  }
  return t;
}

export function readySet(state, rank) {
  const t = state.frontier[rank];
  return pendingOps(state, rank).filter(o => !blockReason(state, o, t));
}

export function label(op) {
  return `${op.stage}${op.kind}${op.mb}`;
}

// Apply one action. Throws Error with .reason on illegal op placement.
export function apply(state, action) {
  const r = action.rank;
  const t = state.frontier[r];
  if (action.type === 'idle') {
    state.rows[r].push({ id: null, start: t, dur: 1 });
    state.frontier[r] = t + 1;
  } else {
    const op = state.byId.get(action.id);
    if (!op) throw new Error(`unknown op ${action.id}`);
    if (op.rank !== r) {
      const e = new Error(`${label(op)} lives on rank ${op.rank}, not rank ${r}`);
      e.reason = { code: 'wrong-rank' };
      throw e;
    }
    const block = blockReason(state, op, t);
    if (block) {
      const e = new Error(`${label(op)} can't start at t=${t}: ${block.msg}`);
      e.reason = block;
      throw e;
    }
    state.placed.set(op.id, { start: t, end: t + op.dur });
    state.rows[r].push({ id: op.id, start: t, dur: op.dur });
    state.frontier[r] = t + op.dur;
    if (op.kind === 'F') {
      state.inflight[r]++;
      state.fbDepth[r]++;
      state.peak[r] = Math.max(state.peak[r], state.inflight[r]);
      // last F on this rank?
      if (pendingOps(state, r).every(o => o.kind !== 'F')) state.lastF[r] = t;
    } else if (op.kind === 'B') {
      state.fbDepth[r]--;
      // In the split model the weight grad still needs the activation, so
      // memory is freed by W, not B.
      if (state.cfg.model !== 'zb') state.inflight[r]--;
      if (state.firstB[r] === null) state.firstB[r] = t;
    } else if (op.kind === 'W') {
      state.inflight[r]--;
    }
  }
  state.actions.push(action);
  return state;
}

export function replay(cfg, actions) {
  const s = newState(cfg);
  for (const a of actions) apply(s, a);
  return s;
}

// --- Phases ----------------------------------------------------------------
export function phase(state, rank) {
  if (state.firstB[rank] === null) return 'warmup';
  if (state.lastF[rank] === null) return 'steady';
  return pendingOps(state, rank).length ? 'drain' : 'done';
}

// --- Policies ---------------------------------------------------------------
// A policy ranks the ready set; index 0 is the pick. `tie` is true when
// several candidates share top priority (a genuine degree of freedom).

const KIND_ORDER = {
  'gpipe': { F: 0, B: 1, W: 2 },   // all forwards first
  '1f1b':  { B: 0, F: 1, W: 2 },   // backward-first (+ cap => 1F1B)
  'zb':    { B: 0, F: 1, W: 2 },   // W fills what would otherwise be bubbles
};

export const POLICIES = {
  'gpipe': { name: 'Forwards first (GPipe)', order: KIND_ORDER['gpipe'] },
  '1f1b':  { name: 'Backward-first (1F1B)', order: KIND_ORDER['1f1b'], quota: true },
  '1f1b-eager': { name: 'Backward-first, eager warmup', order: KIND_ORDER['1f1b'] },
  'zb':    { name: 'B > F > W (zero-bubble)', order: KIND_ORDER['zb'], quota: true },
  'zb-eager': { name: 'B > F > W, eager warmup', order: KIND_ORDER['zb'] },
};

// Non-eager warmup: max in-flight forwards a rank keeps under 1F1B-style
// policies. V=1: the classic P - rank. V>1: Megatron's interleaved warmup
// count, clamped to total microbatch-chunks. cfg.warmup === 'zb2' uses the
// deeper ZB-H2-style quota 2(P - rank) - 1, which admits enough forwards to
// fill the warmup bubble entirely (at the cost of more activation memory).
export function warmupQuota(cfg, rank) {
  if (cfg.warmup === 'zb2')
    return Math.min(2 * (cfg.P - rank) - 1, cfg.M * cfg.V);
  if (cfg.V === 1) return cfg.P - rank;
  // V-placement: no closed-form Megatron quota; depth-first under the cap
  // works well, so the quota is just the cap (i.e. effectively ungated).
  if (placement(cfg) === 'v') return cfg.cap ?? cfg.M * cfg.V;
  const q = (cfg.P - rank - 1) * 2 + (cfg.V - 1) * cfg.P + 1;
  return Math.min(q, cfg.M * cfg.V);
}

export function rankCandidates(state, rank, policyKey, relaxQuota = false) {
  const pol = POLICIES[policyKey];
  const order = pol.order;
  let cands = readySet(state, rank);
  if (pol.quota && !relaxQuota) {
    // Quota is on forward-minus-backward depth, not raw activations: in the
    // split model W frees memory but shouldn't gate admitting forwards.
    const q = warmupQuota(state.cfg, rank);
    cands = cands.filter(o => o.kind !== 'F' || state.fbDepth[rank] < q);
  }
  // priority: kind class, then position in the microbatch stream. With V=1
  // that's just microbatch order. With V>1 under 'wrap' placement, follow
  // Megatron's interleaved order: microbatches move in groups of P per chunk,
  // stream key (mb group, chunk, mb). Under 'v' placement the chunks bounce
  // off the pipe ends, so plain depth-first (mb, then stage along the path)
  // is both natural and faster — the turns continue on the same rank.
  const P = state.cfg.P;
  const S = numStages(state.cfg);
  // forwards climb stages 0..S-1; backwards descend S-1..0
  const key = placement(state.cfg) === 'v'
    ? o => o.mb * S + (o.kind === 'F' ? o.stage : S - 1 - o.stage)
    : o => {
        const st = o.kind === 'F' ? o.stage : S - 1 - o.stage;
        return (Math.floor(o.mb / P) * S + st) * P + (o.mb % P);
      };
  cands.sort((a, b) =>
    (order[a.kind] - order[b.kind]) || (key(a) - key(b)));
  const tie = cands.length >= 2 &&
    order[cands[0].kind] === order[cands[1].kind] && key(cands[0]) === key(cands[1]);
  return { cands, tie };
}

// --- Auto-run / projection ---------------------------------------------------
// Steps the whole schedule forward under a policy, always advancing the rank
// with the earliest frontier. Returns events; `project` runs to completion,
// `autoRun` stops the first time a *new kind* of event happens.

function step(state, policyKey, events, seen, note) {
  // choose rank: earliest frontier among ranks with pending ops
  let rank = -1, best = Infinity;
  for (let r = 0; r < state.cfg.P; r++) {
    if (pendingOps(state, r).length && state.frontier[r] < best) {
      best = state.frontier[r]; rank = r;
    }
  }
  if (rank < 0) return 'done';
  const before = phase(state, rank);
  let { cands, tie } = rankCandidates(state, rank, policyKey);
  if (!cands.length) {
    // must idle — is that a deadlock? progress is possible iff some pending op
    // somewhere becomes ready in the future; idling is safe if any rank's
    // ready set is nonempty or any placed op ends after this frontier.
    const anyReady = Array.from({ length: state.cfg.P }, (_, r) => r)
      .some(r => readySet(state, r).length);
    const anyRunning = Math.max(...state.frontier) > best;
    if (!anyReady && !anyRunning) return 'deadlock';
    // if only the warmup quota is holding this rank back and everyone else is
    // also stuck, relax it rather than idle forever
    if (!anyRunning && readySet(state, rank).length)
      ({ cands, tie } = rankCandidates(state, rank, policyKey, true));
  }
  if (!cands.length) {
    const started = state.rows[rank].some(it => it.id);
    apply(state, { rank, type: 'idle' });
    if (started) note(events, seen, { kind: 'forced-idle', rank, t: best,
      msg: `rank ${rank} is forced idle at t=${best} — a bubble (nothing is ready)` });
    return null;
  }
  if (tie) {
    note(events, seen, { kind: 'tie', rank, t: best,
      choices: cands.filter(c =>
        POLICIES[policyKey].order[c.kind] === POLICIES[policyKey].order[cands[0].kind]
        && c.mb === cands[0].mb).map(label),
      msg: `genuine tie on rank ${rank} at t=${best}: ${label(cands[0])} vs ${label(cands[1])}` });
  }
  const pick = cands[0];
  // cap-block: greedy would also run an F but memory stops it
  if (state.cfg.cap != null && pick.kind !== 'F') {
    const blockedF = pendingOps(state, rank).find(o =>
      o.kind === 'F' && blockReason(state, o, best)?.code === 'memory');
    if (blockedF) note(events, seen, { kind: 'cap-block', rank, t: best,
      msg: `rank ${rank} hit the memory cap at t=${best} — forwards must wait for a backward` });
  }
  apply(state, { rank, type: 'op', id: pick.id });
  const after = phase(state, rank);
  if (before === 'warmup' && after !== 'warmup')
    note(events, seen, { kind: 'first-B', rank, t: best,
      msg: `rank ${rank} ran its first backward at t=${best} — warmup is over here` });
  if (before === 'steady' && (after === 'drain' || after === 'done'))
    note(events, seen, { kind: 'last-F', rank, t: best,
      msg: `rank ${rank} placed its last forward at t=${best} — entering drain` });
  return null;
}

function noteAlways(events, seen, ev) { events.push(ev); }

export function project(state, policyKey) {
  const events = [];
  for (let guard = 0; guard < 100000; guard++) {
    const res = step(state, policyKey, events, null, noteAlways);
    if (res === 'done') return { events, done: true };
    if (res === 'deadlock') return { events, done: false, deadlock: true };
  }
  throw new Error('projection did not terminate');
}

// Stop when an event of a not-yet-seen kind occurs (ties always stop).
export function autoRun(state, policyKey, seenKinds) {
  const events = [];
  const note = (evs, seen, ev) => {
    evs.push(ev);
  };
  for (let guard = 0; guard < 100000; guard++) {
    const res = step(state, policyKey, events, seenKinds, note);
    if (res === 'done') return { events, stopped: 'done' };
    if (res === 'deadlock') return { events, stopped: 'deadlock' };
    const fresh = events.find(e =>
      e.kind === 'tie' || !seenKinds.has(e.kind));
    if (fresh) {
      for (const e of events) seenKinds.add(e.kind);
      return { events, stopped: 'event', event: fresh };
    }
  }
  throw new Error('auto-run did not terminate');
}

// One policy step on a specific rank (for "auto-step"). Returns the action or null.
export function policyPick(state, rank, policyKey) {
  const { cands, tie } = rankCandidates(state, rank, policyKey);
  if (cands.length) return { action: { rank, type: 'op', id: cands[0].id }, tie };
  if (pendingOps(state, rank).length) return { action: { rank, type: 'idle' }, tie: false };
  return null;
}

// --- Free-form plans -----------------------------------------------------------
// A plan is a Map(id -> start) of op placements with NO validity guarantee —
// used by the UI's free-edit mode. These helpers judge and canonicalize it.

// All constraint violations in a plan. Codes: overlap, dep-missing, dep-late,
// memory (only if cap set; checked by simulating completed prefix order).
export function planViolations(cfg, plan) {
  const state = newState(cfg);
  const out = [];
  // overlaps per rank
  for (let r = 0; r < cfg.P; r++) {
    const items = [...plan.entries()]
      .map(([id, start]) => ({ op: state.byId.get(id), start }))
      .filter(x => x.op.rank === r)
      .sort((a, b) => a.start - b.start);
    for (let i = 1; i < items.length; i++) {
      if (items[i].start < items[i - 1].start + items[i - 1].op.dur)
        out.push({ id: items[i].op.id, code: 'overlap',
          msg: `${label(items[i].op)} overlaps ${label(items[i - 1].op)} on rank ${r}` });
    }
  }
  // dependencies
  for (const [id, start] of plan) {
    const op = state.byId.get(id);
    for (const depId of depsOf(cfg, op)) {
      const dep = state.byId.get(depId);
      if (!plan.has(depId)) {
        out.push({ id, code: 'dep-missing', dep: depId,
          msg: `${label(op)} needs ${label(dep)} (rank ${dep.rank}), which isn't placed` });
      } else if (plan.get(depId) + dep.dur > start) {
        out.push({ id, code: 'dep-late', dep: depId,
          msg: `${label(op)} at t=${start} needs ${label(dep)}, which finishes at t=${plan.get(depId) + dep.dur}` });
      }
    }
  }
  // memory cap: walk each rank's timeline in order, F +1 / (B or W) release
  if (cfg.cap != null && !out.some(v => v.code === 'overlap')) {
    const release = cfg.model === 'zb' ? 'W' : 'B';
    for (let r = 0; r < cfg.P; r++) {
      let held = 0;
      const items = [...plan.entries()]
        .map(([id, start]) => ({ op: state.byId.get(id), start }))
        .filter(x => x.op.rank === r)
        .sort((a, b) => a.start - b.start);
      for (const { op, start } of items) {
        if (op.kind === 'F') {
          held++;
          if (held > cfg.cap) out.push({ id: op.id, code: 'memory',
            msg: `${label(op)} at t=${start} exceeds the memory cap (${held} > ${cfg.cap} in flight)` });
        } else if (op.kind === release) held--;
      }
    }
  }
  return out;
}

// Speculative placement support. A plan may contain ops whose deps are
// missing or late; `planCompletion` decides whether the holes can be filled.
//
// Returns { feasible, required, witness, forced }:
//   required — transitive unplaced deps of placed ops, with [earliest, latestStart] windows
//   witness  — a concrete violation-free assignment for all required ops (if feasible)
//   forced   — Map(id -> start) of required ops with exactly ONE feasible slot,
//              closed under fixpoint (placing forced ops may force more)
// Memory caps are NOT considered here (they depend on global order); the final
// merge still validates them.

export function planCompletion(cfg, plan) {
  const probe = newState(cfg);
  const need = new Map();   // id -> {op, earliest, latestStart}
  const queue = [...plan.keys()];
  while (queue.length) {
    const id = queue.pop();
    for (const depId of depsOf(cfg, probe.byId.get(id))) {
      if (plan.has(depId) || need.has(depId)) continue;
      need.set(depId, { op: probe.byId.get(depId), earliest: 0, latestStart: Infinity });
      queue.push(depId);
    }
  }
  if (!need.size) return { feasible: true, required: need, witness: new Map(), forced: new Map() };

  // topological order over required ops (deps first)
  const order = [];
  const seen = new Set();
  const visit = id => {
    if (seen.has(id) || !need.has(id)) return;
    seen.add(id);
    for (const d of depsOf(cfg, probe.byId.get(id))) visit(d);
    order.push(id);
  };
  for (const id of need.keys()) visit(id);

  const dependentsOf = id => {
    const out = [];
    for (const cand of [...plan.keys(), ...need.keys()]) {
      if (depsOf(cfg, probe.byId.get(cand)).includes(id)) out.push(cand);
    }
    return out;
  };

  const propagate = () => {
    for (const id of order) {                     // earliest: forward pass
      const n = need.get(id);
      n.earliest = 0;
      for (const d of depsOf(cfg, n.op)) {
        const fin = plan.has(d) ? plan.get(d) + probe.byId.get(d).dur
                  : need.has(d) ? need.get(d).earliest + probe.byId.get(d).dur : 0;
        n.earliest = Math.max(n.earliest, fin);
      }
    }
    for (let i = order.length - 1; i >= 0; i--) { // latest: backward pass
      const id = order[i];
      const n = need.get(id);
      n.latestStart = Infinity;
      for (const x of dependentsOf(id)) {
        const startX = plan.has(x) ? plan.get(x)
                     : need.get(x).latestStart;
        n.latestStart = Math.min(n.latestStart, startX - n.op.dur);
      }
    }
    return [...need.values()].every(n => n.earliest <= n.latestStart);
  };
  if (!propagate()) return { feasible: false, required: need };

  // free slots: any t not occupied by a plan op on that rank
  const occupied = r => {
    const s = new Set();
    for (const [id, start] of plan) {
      const op = probe.byId.get(id);
      if (op.rank === r) for (let d = 0; d < op.dur; d++) s.add(start + d);
    }
    return s;
  };
  const fits = (occ, t, dur) => {
    for (let d = 0; d < dur; d++) if (occ.has(t + d)) return false;
    return true;
  };
  const slotsFor = (n, occ) => {
    const out = [];
    for (let t = n.earliest; t <= n.latestStart; t++) if (fits(occ, t, n.op.dur)) out.push(t);
    return out;
  };

  // greedy witness: per rank, earliest-deadline-first into earliest free slot,
  // then verify the witness has no dep violations (retry once with updated
  // earliest bounds if the greedy pass introduced lateness)
  const buildWitness = () => {
    const w = new Map();
    const occs = Array.from({ length: cfg.P }, (_, r) => occupied(r));
    const byRank = Array.from({ length: cfg.P }, () => []);
    for (const n of need.values()) byRank[n.op.rank].push(n);
    for (let r = 0; r < cfg.P; r++) {
      byRank[r].sort((a, b) => a.latestStart - b.latestStart || a.earliest - b.earliest);
      for (const n of byRank[r]) {
        const slot = slotsFor(n, occs[r])[0];
        if (slot === undefined) return null;
        w.set(n.op.id, slot);
        for (let d = 0; d < n.op.dur; d++) occs[r].add(slot + d);
      }
    }
    return w;
  };
  let witness = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const w = buildWitness();
    if (!w) break;
    const full = new Map([...plan, ...w]);
    const bad = planViolations(cfg, full).filter(v => v.code !== 'memory');
    if (!bad.length) { witness = w; break; }
    // tighten earliest bounds from the witness's dep-late findings and retry
    let changed = false;
    for (const v of bad) {
      if (v.code === 'dep-late' && need.has(v.id)) {
        const n = need.get(v.id);
        const dep = probe.byId.get(v.dep);
        const fin = (full.get(v.dep) ?? 0) + dep.dur;
        if (fin > n.earliest) { n.earliest = fin; changed = true; }
      }
    }
    if (!changed || ![...need.values()].every(n => n.earliest <= n.latestStart)) break;
  }
  if (!witness) return { feasible: false, required: need };

  // forced fixpoint: required ops with exactly one feasible slot
  const forced = new Map();
  const fplan = new Map(plan);
  let changedF = true;
  while (changedF) {
    changedF = false;
    // recompute windows against fplan
    const sub = planCompletionWindows(cfg, fplan, probe);
    if (!sub) break;
    for (const [id, n] of sub) {
      if (fplan.has(id)) continue;
      const occ = new Set();
      for (const [pid, pstart] of fplan) {
        const pop = probe.byId.get(pid);
        if (pop.rank === n.op.rank) for (let d = 0; d < pop.dur; d++) occ.add(pstart + d);
      }
      const slots = slotsFor(n, occ);
      if (slots.length === 1) {
        forced.set(id, slots[0]);
        fplan.set(id, slots[0]);
        changedF = true;
      }
    }
  }
  return { feasible: true, required: need, witness, forced };
}

// window computation helper shared by the forced-fixpoint loop
function planCompletionWindows(cfg, plan, probe) {
  const need = new Map();
  const queue = [...plan.keys()];
  while (queue.length) {
    const id = queue.pop();
    for (const depId of depsOf(cfg, probe.byId.get(id))) {
      if (plan.has(depId) || need.has(depId)) continue;
      need.set(depId, { op: probe.byId.get(depId), earliest: 0, latestStart: Infinity });
      queue.push(depId);
    }
  }
  const order = [];
  const seen = new Set();
  const visit = id => {
    if (seen.has(id) || !need.has(id)) return;
    seen.add(id);
    for (const d of depsOf(cfg, probe.byId.get(id))) visit(d);
    order.push(id);
  };
  for (const id of need.keys()) visit(id);
  for (const id of order) {
    const n = need.get(id);
    for (const d of depsOf(cfg, n.op)) {
      const fin = plan.has(d) ? plan.get(d) + probe.byId.get(d).dur
                : need.has(d) ? need.get(d).earliest + probe.byId.get(d).dur : 0;
      n.earliest = Math.max(n.earliest, fin);
    }
  }
  const allIds = [...plan.keys(), ...need.keys()];
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    const n = need.get(id);
    for (const cand of allIds) {
      if (!depsOf(cfg, probe.byId.get(cand)).includes(id)) continue;
      const startX = plan.has(cand) ? plan.get(cand) : need.get(cand).latestStart;
      n.latestStart = Math.min(n.latestStart, startX - n.op.dur);
    }
    if (n.earliest > n.latestStart) return null;
  }
  return need;
}

// Shift every placed op of one microbatch by delta slots (plan-level; may
// produce violations — that's the caller's problem to show).
export function shiftMicrobatch(plan, byId, mb, delta) {
  const out = new Map(plan);
  for (const [id, t] of plan) {
    if (byId.get(id).mb === mb) {
      if (t + delta < 0) return null;
      out.set(id, t + delta);
    }
  }
  return out;
}

// Canonicalize a valid, complete-or-partial plan back to an action list
// (per-rank time order, gaps filled with idles). Throws on overlap.
export function planToActions(cfg, plan) {
  const state = newState(cfg);
  const perRank = Array.from({ length: cfg.P }, () => []);
  for (const [id, start] of plan) {
    const op = state.byId.get(id);
    perRank[op.rank].push({ op, start });
  }
  const events = [];
  for (let r = 0; r < cfg.P; r++) {
    perRank[r].sort((a, b) => a.start - b.start);
    let t = 0;
    for (const { op, start } of perRank[r]) {
      if (start < t) throw new Error(`overlap on rank ${r} at t=${start}`);
      for (; t < start; t++) events.push({ start: t, a: { rank: r, type: 'idle' } });
      events.push({ start, a: { rank: r, type: 'op', id: op.id } });
      t = start + op.dur;
    }
  }
  // cross-rank replay order: by start time (deps always start strictly earlier
  // than dependents in a violation-free plan)
  events.sort((x, y) => x.start - y.start || x.a.rank - y.a.rank);
  return events.map(e => e.a);
}

// --- Scoring ------------------------------------------------------------------
export function score(state) {
  let makespan = 0, work = 0;
  for (const [id, p] of state.placed) {
    makespan = Math.max(makespan, p.end);
    work += p.end - p.start;
  }
  const P = state.cfg.P;
  const bubble = makespan ? 1 - work / (P * makespan) : 0;
  // "internal" bubble ignores the unavoidable fill/drain stagger: idle only
  // counts between a rank's own first and last op. A ZB-H2 parallelogram
  // schedule scores 0 here even though the naive bubble fraction is positive.
  let span = 0, internalIdle = 0;
  for (let r = 0; r < P; r++) {
    let first = Infinity, last = 0, busy = 0;
    for (const it of state.rows[r]) if (it.id) {
      first = Math.min(first, it.start);
      last = Math.max(last, it.start + it.dur);
      busy += it.dur;
    }
    if (first === Infinity) continue;
    span += last - first;
    internalIdle += (last - first) - busy;
  }
  const internalBubble = span ? internalIdle / span : 0;
  return { makespan, work, bubble, internalBubble, peak: [...state.peak] };
}

// Reference schedule for a config: projection under its natural policy.
export function referencePolicy(cfg) {
  if (cfg.model === 'zb') return 'zb';
  return cfg.cap == null ? 'gpipe' : '1f1b';
}

export function referenceSchedule(cfg) {
  const s = newState(cfg);
  const { done, deadlock } = project(s, referencePolicy(cfg));
  return { state: s, done, deadlock, score: score(s) };
}

// --- Building blocks (Qi et al. 2024, "Controllable Memory") -------------------
// A schedule can be described as ONE microbatch's trajectory (the building
// block) repeated at a uniform interval w = the per-RANK work of one
// microbatch: V chunks × (sum of op durations). A block tiles iff each rank's
// ops occupy distinct time-residues mod w (the paper's "squeezing" condition).
// The block's per-rank lifespan (first F start -> memory-releasing op end)
// determines peak activation memory: ceil(lifespan / w) microbatches in flight.

export function blockInterval(cfg) {
  const dur = durations(cfg.model);
  return cfg.V * opKinds(cfg.model).reduce((a, k) => a + dur[k], 0);
}

// Is the current state exactly "microbatch `mb` fully scheduled, nothing else"?
export function soleMicrobatch(state) {
  const placed = [...state.placed.keys()].map(id => state.byId.get(id));
  if (!placed.length) return null;
  const mb = placed[0].mb;
  if (!placed.every(o => o.mb === mb)) return null;
  const expected = state.ops.filter(o => o.mb === mb);
  return placed.length === expected.length ? mb : null;
}

// Predict, from a complete single-microbatch block, what uniform repetition
// yields per rank. The steady-state in-flight count at phase ρ is the block's
// own in-flight profile summed at ρ, ρ+w, ρ+2w, … (each shifted copy is one
// microbatch); the peak over phases is the schedule's peak memory, exact when
// M is large enough to reach steady state (handles V>1, where each microbatch
// holds one activation per chunk on a rank).
export function blockStats(state, mb) {
  const cfg = state.cfg;
  const w = blockInterval(cfg);
  const release = cfg.model === 'zb' ? 'W' : 'B';
  const stats = [];
  for (let r = 0; r < cfg.P; r++) {
    const times = state.ops.filter(o => o.mb === mb && o.rank === r)
      .map(o => ({ o, p: state.placed.get(o.id) }));
    let firstF = Infinity, lastRelease = 0;
    for (const { o, p } of times) {
      if (o.kind === 'F') firstF = Math.min(firstF, p.start);
      if (o.kind === release) lastRelease = Math.max(lastRelease, p.end);
    }
    const lifespan = Math.max(0, lastRelease - firstF);
    // block in-flight profile on this rank
    const profile = new Array(lastRelease + 1).fill(0);
    for (const { o, p } of times) {
      if (o.kind === 'F') for (let t = p.start; t <= lastRelease; t++) profile[t]++;
      if (o.kind === release) for (let t = p.end; t <= lastRelease; t++) profile[t]--;
    }
    let peak = 0;
    for (let rho = 0; rho < w; rho++) {
      let sum = 0;
      for (let t = rho; t < profile.length; t += w) sum += profile[t];
      peak = Math.max(peak, sum);
    }
    stats.push({ rank: r, lifespan, peak: Math.min(peak, cfg.M * cfg.V) });
  }
  return { w, perRank: stats, peak: stats.map(s => s.peak) };
}

// Squeeze the block (the paper's repair step): keep the op ORDER of the
// user's block but re-time it minimally so each rank's ops land on distinct
// residues mod w — the necessary and sufficient condition for the block to
// tile at interval w without overlap. Returns a new plan or null.
export function squeezeBlock(state, mb) {
  const cfg = state.cfg;
  const w = blockInterval(cfg);
  const ops = [...state.placed.entries()]
    .map(([id, p]) => ({ op: state.byId.get(id), start: p.start }))
    .sort((a, b) => a.start - b.start);
  const plan = new Map();
  const used = Array.from({ length: cfg.P }, () => new Set());
  for (const { op } of ops) {
    let t = 0;
    for (const depId of depsOf(cfg, op)) {
      const dep = state.byId.get(depId);
      if (plan.has(depId)) t = Math.max(t, plan.get(depId) + dep.dur);
    }
    const r = op.rank;
    const fits = tt => {
      for (let d = 0; d < op.dur; d++) if (used[r].has((tt + d) % w)) return false;
      return true;
    };
    let guard = 0;
    while (!fits(t) && guard++ < 4 * w) t++;
    if (!fits(t)) return null;    // rank already saturated (shouldn't happen)
    plan.set(op.id, t);
    for (let d = 0; d < op.dur; d++) used[r].add((t + d) % w);
  }
  return planViolations(cfg, plan).length ? null : plan;
}

// Is the board a clean prefix: microbatches 0..k-1 fully scheduled, nothing
// else? Returns k (the next microbatch to stamp), or null.
export function microbatchPrefix(state) {
  const placedMbs = new Set([...state.placed.keys()].map(id => state.byId.get(id).mb));
  if (!placedMbs.size) return null;
  const k = Math.max(...placedMbs) + 1;
  for (let m = 0; m < k; m++) {
    if (state.ops.some(o => o.mb === m && !state.placed.has(o.id))) return null;
  }
  return k <= state.cfg.M - 1 ? k : null;
}

// Stamp ONE more microbatch strand, greedily: each op of microbatch k aims
// for its pattern slot — the SAME op in the previous strand, one period (w)
// later — and gets shoved right until legal (deps met, rank free, memory ok).
// Following the previous strand (not mb0 + k·w) means a hand-designed stagger
// between mb0 and mb1 propagates to every later strand. Returns
// { plan, shoves: [{id, target, actual}] } or { violations }.
export function stampNextMicrobatch(state) {
  const cfg = state.cfg;
  const k = microbatchPrefix(state);
  if (k === null) return { violations: [{ msg: 'need microbatches 0..k-1 fully scheduled, nothing else' }] };
  const w = blockInterval(cfg);
  const plan = new Map([...state.placed.entries()].map(([id, p]) => [id, p.start]));
  const blockOps = state.ops.filter(o => o.mb === k - 1)
    .map(o => ({ o, start: state.placed.get(o.id).start }))
    .sort((a, b) => a.start - b.start);
  const shoves = [];
  for (const { o, start } of blockOps) {
    const id = opId(o.kind, o.stage, k);
    const op = state.byId.get(id);
    const target = start + w;
    let t = target;
    // dep floor
    for (const depId of depsOf(cfg, op)) {
      const dep = state.byId.get(depId);
      if (!plan.has(depId)) return { violations: [{ msg: `${label(op)} needs ${label(dep)}, which isn't scheduled` }] };
      t = Math.max(t, plan.get(depId) + dep.dur);
    }
    // shove right past same-rank occupancy and memory violations
    const occupied = tt => [...plan.entries()].some(([pid, ps]) => {
      const po = state.byId.get(pid);
      return po.rank === op.rank && tt < ps + po.dur && ps < tt + op.dur;
    });
    let guard = 0;
    for (;;) {
      if (guard++ > 10000) return { violations: [{ msg: `${label(op)} can't be placed` }] };
      if (occupied(t)) { t++; continue; }
      plan.set(id, t);
      if (planViolations(cfg, plan).length) { plan.delete(id); t++; continue; }
      break;
    }
    if (t > target) shoves.push({ id, target, actual: t });
  }
  return { plan, shoves, mb: k };
}

// Stamp the block: replicate every placed op for all other microbatches,
// shifted by (mb' - mb) * w. Returns {actions} on success or {violations}.
export function stampBlock(state, mb) {
  const cfg = state.cfg;
  const w = blockInterval(cfg);
  const plan = new Map();
  for (const [id, p] of state.placed) {
    const op = state.byId.get(id);
    for (let m = 0; m < cfg.M; m++) {
      const shifted = p.start + (m - mb) * w;
      if (shifted < 0) return { violations: [{ msg:
        `${label(op)} starts too early — shifting microbatch ${m} by ${(m - mb) * w} ` +
        `goes below t=0. Schedule microbatch 0 (not ${mb}) or start later.` }] };
      plan.set(opId(op.kind, op.stage, m), shifted);
    }
  }
  const violations = planViolations(cfg, plan);
  if (violations.length) return { violations };
  return { actions: planToActions(cfg, plan) };
}

// --- Post-mortem analysis -----------------------------------------------------
// What actually gated each op: the dependency or same-rank predecessor whose
// finish time equals the op's start. If nothing ends exactly at its start, the
// op started later than it had to — a voluntary delay (scheduling choice).

export function gaterOf(state, id) {
  const op = state.byId.get(id);
  const p = state.placed.get(id);
  if (!p) return null;
  if (p.start === 0) return { kind: 'start' };
  // same-rank predecessor (resource constraint)
  let prevOp = null;
  for (const it of state.rows[op.rank]) {
    if (it.id && it.start + it.dur === p.start) { prevOp = it.id; break; }
  }
  // dependency constraint
  for (const depId of depsOf(state.cfg, op)) {
    const dp = state.placed.get(depId);
    if (dp && dp.end === p.start) return { kind: 'dep', id: depId };
  }
  if (prevOp) return { kind: 'resource', id: prevOp };
  // nothing ends at start: op was voluntarily delayed
  let earliest = 0;
  for (const depId of depsOf(state.cfg, op)) {
    const dp = state.placed.get(depId);
    if (dp) earliest = Math.max(earliest, dp.end);
  }
  return { kind: 'delayed', couldHaveStarted: earliest };
}

// Critical path: walk back from the op that finishes last, following gaters.
// Returns { ids, breaks } — breaks are voluntary delays found on the walk
// (the path "restarts" there; each break is a place the makespan could shrink).
export function criticalPath(state) {
  let lastId = null, lastEnd = -1;
  for (const [id, p] of state.placed) {
    if (p.end > lastEnd) { lastEnd = p.end; lastId = id; }
  }
  const ids = [];
  const breaks = [];
  let cur = lastId;
  const seen = new Set();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    ids.push(cur);
    const g = gaterOf(state, cur);
    if (!g || g.kind === 'start') break;
    if (g.kind === 'delayed') {
      breaks.push({ id: cur, couldHaveStarted: g.couldHaveStarted,
        actual: state.placed.get(cur).start });
      break;
    }
    cur = g.id;
  }
  return { ids: ids.reverse(), breaks };
}

// Explain an idle slot at (rank, t): what ran next on this rank and why it
// couldn't have run at t instead.
export function explainIdle(state, rank, t) {
  const next = state.rows[rank].find(it => it.id && it.start > t);
  if (!next) return { reason: 'drain', msg:
    `Nothing runs after this on rank ${rank} — this is fill/drain stagger, not a schedulable gap.` };
  const op = state.byId.get(next.id);
  // why not at t? find the blocking dep at time t
  let blocker = null, blockEnd = 0;
  for (const depId of depsOf(state.cfg, op)) {
    const dp = state.placed.get(depId);
    if (!dp) continue;
    if (dp.end > t && dp.end > blockEnd) { blocker = depId; blockEnd = dp.end; }
  }
  if (blocker) {
    const bop = state.byId.get(blocker);
    return { reason: 'dep', blocker, msg:
      `Rank ${rank} idles here because its next op, ${label(op)}, was waiting for ` +
      `${label(bop)} on rank ${bop.rank} (finished t=${blockEnd}). To kill this bubble, ` +
      `${label(bop)} would have to run earlier — or something else must fill this slot.` };
  }
  return { reason: 'choice', msg:
    `${label(op)} could have started at t=${t} — this bubble was a scheduling choice, not forced.` };
}

// --- Schedule recognition ---------------------------------------------------
// Compare a completed schedule against canonical schedules from the literature
// (each = a policy projection, possibly with modified cfg). Matching is up to
// per-rank op ORDER (start times can differ) — order is what defines a named
// schedule; exact slots depend on idle placement.

function rankOrders(state) {
  return state.rows.map(row => row.filter(it => it.id).map(it => it.id).join(' '));
}

function sameOrder(a, b) {
  const oa = rankOrders(a), ob = rankOrders(b);
  return oa.length === ob.length && oa.every((x, i) => x === ob[i]);
}

export function recognizeSchedule(state) {
  if (!isDone(state)) return null;
  const cfg = state.cfg;
  const candidates = [];
  const zb = cfg.model === 'zb';
  const push = (name, note, policy, cfg2) => {
    try {
      const s = newState(cfg2 ?? cfg);
      if (!project(s, policy).done) return;
      candidates.push({ name, note, state: s });
    } catch { /* candidate not constructible for this cfg */ }
  };
  if (!zb) {
    push('GPipe', 'all forwards, then all backwards (Huang et al. 2019)', 'gpipe');
    const vppName = placement(cfg) === 'v'
      ? 'V-shape interleaved 1F1B' : 'Interleaved 1F1B (Megatron VPP)';
    const vppNote = placement(cfg) === 'v'
      ? 'chunks bounce off the pipe ends (ZB-V / DualPipe-style placement)'
      : 'Narayanan et al. 2021 — interleaved stages';
    push(cfg.V > 1 ? vppName : '1F1B',
      cfg.V > 1 ? vppNote : 'one-forward-one-backward (PipeDream-Flush / Megatron)',
      '1f1b');
    push('1F1B (eager warmup)', '1F1B order but admitting forwards greedily in warmup', '1f1b-eager');
  } else {
    const std = { ...cfg }; delete std.warmup;   // pin warmup per candidate
    push('ZB-H2', 'zero-bubble with doubled warmup, ~2P memory (Qi et al. 2023)', 'zb',
      { ...cfg, warmup: 'zb2' });
    push('ZB-H1', 'zero-bubble handcrafted schedule, 1F1B memory (Qi et al. 2023)', 'zb', std);
    push('ZB-H1 (eager warmup)', 'zero-bubble greedy with eager warmup', 'zb-eager', std);
    push('GPipe (F/B/W split)', 'all F, then all B, then W filler', 'gpipe', std);
  }
  for (const c of candidates) if (sameOrder(state, c.state)) {
    return { name: c.name, note: c.note, exact: score(state).makespan === score(c.state).makespan };
  }
  return { name: null };
}
