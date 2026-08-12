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

// Interleaved placement: rank r hosts stages r, r+P, r+2P, ...
export function stageRank(cfg, stage) {
  return stage % cfg.P;
}

export function rankStages(cfg, rank) {
  const out = [];
  for (let s = rank; s < numStages(cfg); s += cfg.P) out.push(s);
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
  'zb':    { name: 'B > F > W (zero-bubble)', order: KIND_ORDER['zb'], quota: true },
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
  // that's just microbatch order. With V>1, follow Megatron's interleaved
  // order: microbatches move in groups of P per chunk (F0..F3 on chunk 0,
  // then F0..F3 on chunk 1, then F4..F7 on chunk 0, ...), so the stream key
  // is (mb group, chunk, mb).
  const P = state.cfg.P;
  const S = numStages(state.cfg);
  // forwards climb stages 0..S-1; backwards descend S-1..0
  const key = o => {
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
