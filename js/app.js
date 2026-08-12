import * as E from './engine.js';
import { LEVELS, levelByKey, levelIndex } from './levels.js';
import { THEMES, cellStyle } from './palettes.js';
import { downloadSVG } from './export.js';

const $ = id => document.getElementById(id);
const CELL = 34;

// --- progression -------------------------------------------------------------
// progress = number of levels cleared; levels 0..progress are playable.
// UI features unlock at level indices (kept once unlocked).

const FEATURE_AT = {
  scoreboard: 1,   // pipelining level introduces bubble/par
  theme: 1,
  assist: 3,       // 1F1B introduces the coach + the full power-tool set:
  step: 3,         // 64 ops is fun to place by hand exactly once
  autorun: 3,
  project: 4,      // solve stays one level later — it skips the whole puzzle
  custom: 3,       // sandbox settings
};

const store = {
  get progress() { return +(localStorage.getItem('ppt-progress') ?? 0); },
  set progress(v) { localStorage.setItem('ppt-progress', v); },
  get unlockAll() { return localStorage.getItem('ppt-unlock-all') === '1'; },
  set unlockAll(v) { localStorage.setItem('ppt-unlock-all', v ? '1' : '0'); },
  // best saved solution per level: {actions, makespan, internalBubble}
  solution(key) {
    try { return JSON.parse(localStorage.getItem('ppt-sol-' + key)); }
    catch { return null; }
  },
  saveSolution(key, sol) { localStorage.setItem('ppt-sol-' + key, JSON.stringify(sol)); },
};

function maxReached() {
  if (store.unlockAll || state.level.key === 'custom') return LEVELS.length - 1;
  return Math.max(store.progress, levelIndex(state.level.key));
}
function featureOn(f) { return maxReached() >= FEATURE_AT[f]; }
function levelPlayable(i) { return store.unlockAll || i <= store.progress; }

const state = {
  level: LEVELS[0],
  sim: null,
  ref: null,
  selectedRank: 0,
  assist: 'ready',         // 'none' | 'ready' | 'coach'
  theme: 'microbatch',
  mode: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
  redo: [],                // stack of action batches
  batches: [],             // size of each applied batch (for batch undo)
  showCrit: false,         // critical-path highlight on a finished schedule
  showCompare: false,      // reference schedule shown below yours
  playT: null,             // playback cursor (null = not playing)
  playTimer: null,
  editing: false,          // free-edit mode: invariants may be broken
  plan: null,              // Map(id -> start) while editing
  lifted: null,            // op id currently picked up (edit mode)
  seenEvents: new Set(),
  hoverGhost: null,
  cleared: false,          // this level's goal met this session
};

// --- setup -------------------------------------------------------------------

// Custom sandbox: cfg comes from the settings row, not a fixed level.
function customLevel(cfg) {
  return {
    key: 'custom',
    name: 'Sandbox',
    cfg,
    policy: E.referencePolicy(cfg),
    goal: 'par',
    blurb: `Sandbox: your own P/VPP/microbatches/time model/memory cap. ` +
      `Par is whatever the standard greedy policy achieves — see if you can beat it.`,
  };
}

function readCustomCfg() {
  const P = Math.max(1, Math.min(8, +$('cfgP').value || 4));
  const V = Math.max(1, Math.min(4, +$('cfgV').value || 1));
  const M = Math.max(1, Math.min(16, +$('cfgM').value || 8));
  const model = $('cfgModel').value;
  const capRaw = $('cfgCap').value.trim();
  const cap = capRaw === '' ? null : Math.max(1, +capRaw);
  const warmup = $('cfgWarmup').checked ? 'zb2' : undefined;
  const place = $('cfgPlace').value || undefined;
  return { P, V, M, model, cap, ...(warmup ? { warmup } : {}), ...(place ? { place } : {}) };
}

function loadLevel(level, actions = []) {
  if (state.playTimer) stopPlayback(false);
  state.level = level;
  state.sim = E.replay(level.cfg, actions);
  state.ref = E.referenceSchedule(level.cfg);
  state.redo = [];
  state.batches = actions.map(() => 1);
  state.seenEvents = new Set();
  state.selectedRank = 0;
  state.hoverGhost = null;
  state.cleared = false;
  state.editing = false;
  state.plan = null;
  state.showCrit = false;
  state.showCompare = false;
  $('blurb').textContent = level.blurb;
  $('goal').textContent = goalText(level);
  hideBanner();
  setStatus('');
  logClear();
  saveHash();
  if (E.isDone(state.sim)) {
    const s = E.score(state.sim);
    state.cleared = goalMet(s);
    showBanner(state.cleared, s);
  }
  renderAll();
}

function goalText(level) {
  const ref = E.referenceSchedule(level.cfg);
  switch (level.goal) {
    case 'complete': return `Goal: any complete, legal schedule.`;
    case 'par': return `Goal: complete it in makespan ≤ ${ref.score.makespan} (par).`;
    case 'internal0': return `Goal: complete it with 0% internal bubble ` +
      `(no rank idles between its first and last op). Par makespan is ${ref.score.makespan}.`;
  }
}

function goalMet(s) {
  switch (state.level.goal) {
    case 'complete': return true;
    case 'par': return s.makespan <= state.ref.score.makespan;
    case 'internal0': return s.internalBubble < 1e-9;
  }
}

function pct(x) { return (100 * x).toFixed(1) + '%'; }

// --- actions -------------------------------------------------------------------

function tryAction(action, opts) { return tryActions([action], opts); }

// Apply a batch atomically (e.g. auto-padded idles + the chosen op): validate
// on a replay first so a failure commits nothing. Undo pops whole batches.
function tryActions(actions, { silent = false } = {}) {
  if (state.playTimer) stopPlayback(false);
  try {
    const test = E.replay(state.sim.cfg, [...state.sim.actions, ...actions]);
    state.sim = test;
    state.batches.push(actions.length);
    state.redo = [];
    setStatus('');
    afterChange(actions[actions.length - 1], silent);
    return true;
  } catch (err) {
    setStatus(err.message, 'err');
    if (err.reason?.dep) highlightDep(err.reason.dep);
    log(err.message, 'err');
    return false;
  }
}

function autoAdvanceSelection() {
  // wavefront order: jump to the unfinished rank with the earliest frontier
  let best = Infinity, pick = null;
  for (let r = 0; r < state.sim.cfg.P; r++) {
    if (E.pendingOps(state.sim, r).length && state.sim.frontier[r] < best) {
      best = state.sim.frontier[r]; pick = r;
    }
  }
  if (pick !== null) state.selectedRank = pick;
}

// Earliest place `op` can actually go: at/after the frontier, or inside an
// existing run of >= dur idle slots (filled via fillIdle). Null if neither.
function earliestSite(sim, op) {
  const ready = E.earliestStart(sim, op);
  if (ready === Infinity) return null;
  const r = op.rank;
  let best = Math.max(ready, sim.frontier[r]);   // frontier placement
  let mode = 'frontier';
  // idle-gap placement: find earliest run of op.dur consecutive idles >= ready
  const idles = sim.rows[r].filter(it => !it.id).map(it => it.start);
  const idleSet = new Set(idles);
  for (const t of idles.sort((a, b) => a - b)) {
    if (t < ready) continue;
    if (t >= best) break;
    let fits = true;
    for (let d = 1; d < op.dur; d++) if (!idleSet.has(t + d)) { fits = false; break; }
    if (fits) { best = t; mode = 'idle'; break; }
  }
  return { t: best, mode };
}

// All current proposals, derived from state (so they persist across
// placements, microbatch switches, and undo): every unplaced op whose deps
// are all placed AND that continues something already on the board — either
// a direct dep is placed (chain continuation) or the same op for the previous
// microbatch is placed (start the next microbatch). Stage-0 F0_0 aside, this
// keeps the board from drowning in ghosts at level start.
function computeFollowGhosts(sim) {
  if (E.isDone(sim)) return [];
  const out = [];
  for (const op of sim.ops) {
    if (sim.placed.has(op.id)) continue;
    const deps = E.depsOf(sim.cfg, op);
    if (!deps.every(d => sim.placed.has(d))) continue;
    const chainCont = deps.length > 0;   // deps placed (checked above)
    const prevMb = op.mb > 0 && sim.placed.has(E.opId(op.kind, op.stage, op.mb - 1));
    if (!chainCont && !prevMb) continue;
    const site = earliestSite(sim, op);
    if (site) out.push({ id: op.id, rank: op.rank, ...site });
  }
  return out;
}

function afterChange(action, silent) {
  const sim = state.sim;
  if (action?.type === 'op' && !silent) {
    const op = sim.byId.get(action.id);
    if (op.kind === 'B' && sim.rows[action.rank].filter(
        it => it.id && sim.byId.get(it.id).kind === 'B').length === 1) {
      log(`Rank ${action.rank}: first backward — warmup is over here.`, 'event');
    }
    if (E.phase(sim, action.rank) === 'drain' && op.kind === 'F') {
      log(`Rank ${action.rank}: last forward placed — draining.`, 'event');
    }
  }
  if (E.isDone(sim)) {
    const s = E.score(sim);
    const won = goalMet(s);
    if (won && !state.cleared) {
      state.cleared = true;
      const idx = levelIndex(state.level.key);
      if (idx >= store.progress) store.progress = idx + 1;
    }
    if (won) {
      const prev = store.solution(state.level.key);
      if (!prev || s.makespan < prev.makespan ||
          (s.makespan === prev.makespan && s.internalBubble < prev.internalBubble)) {
        store.saveSolution(state.level.key, {
          actions: sim.actions, makespan: s.makespan, internalBubble: s.internalBubble });
      }
    }
    showBanner(won, s);
    log(`Schedule complete: makespan ${s.makespan}, bubble ${pct(s.bubble)}, ` +
        `internal ${pct(s.internalBubble)}, peak ${s.peak.join('/')}.`, 'event');
  } else {
    hideBanner();
    // stay on the rank the user just acted on if it still has work;
    // otherwise jump to the earliest-frontier rank
    if (action?.rank !== undefined && E.pendingOps(sim, action.rank).length)
      state.selectedRank = action.rank;
    else autoAdvanceSelection();
  }
  saveHash();
  renderAll();
}

function undo() {
  if (state.playTimer) stopPlayback(false);
  const acts = state.sim.actions;
  if (!acts.length) return;
  const n = state.batches.pop() ?? 1;
  state.redo.push(acts.slice(acts.length - n));
  state.sim = E.replay(state.level.cfg, acts.slice(0, acts.length - n));
  hideBanner(); setStatus('');
  autoAdvanceSelection();
  saveHash(); renderAll();
}

function redo() {
  const batch = state.redo.pop();
  if (!batch) return;
  for (const a of batch) E.apply(state.sim, a);
  state.batches.push(batch.length);
  autoAdvanceSelection(); saveHash(); renderAll();
}

function autoStep() {
  // act on the earliest-frontier unfinished rank — "do the next thing",
  // regardless of which rank happens to be selected
  let rank = -1, best = Infinity;
  for (let r = 0; r < state.sim.cfg.P; r++) {
    if (E.pendingOps(state.sim, r).length && state.sim.frontier[r] < best) {
      best = state.sim.frontier[r]; rank = r;
    }
  }
  if (rank < 0) { setStatus('Schedule is complete.'); return; }
  const pick = E.policyPick(state.sim, rank, state.level.policy);
  if (pick.tie) {
    state.selectedRank = rank;
    renderAll();
    setStatus(`⚖️ Genuine choice on rank ${rank} — the policy has no preference. Your call.`);
    return;
  }
  const op = pick.action.type === 'op' ? state.sim.byId.get(pick.action.id) : null;
  if (tryAction(pick.action)) {
    setStatus(op ? `step: placed ${E.label(op)} on rank ${rank}.`
                 : `step: rank ${rank} idles (nothing ready).`);
  }
}

function autoRunUntilStrange() {
  const before = state.sim.actions.length;
  const res = E.autoRun(state.sim, state.level.policy, state.seenEvents);
  if (state.sim.actions.length > before) state.batches.push(state.sim.actions.length - before);
  state.redo = [];
  if (res.stopped === 'event') {
    setStatus(`⏸ ${res.event.msg}` +
      (res.event.kind === 'tie' ? ` — choices: ${res.event.choices.join(', ')}` : ''));
  } else if (res.stopped === 'done') {
    afterChange(null, true); return;
  } else if (res.stopped === 'deadlock') {
    setStatus('💀 Deadlock: nothing is ready anywhere and nothing is running. Undo and rethink.', 'err');
  }
  for (const e of res.events) log(e.msg, e === res.event ? 'event' : '');
  autoAdvanceSelection();
  saveHash(); renderAll();
}

function projectRest() {
  const before = state.sim.actions.length;
  const res = E.project(state.sim, state.level.policy);
  if (state.sim.actions.length > before) state.batches.push(state.sim.actions.length - before);
  state.redo = [];
  if (res.deadlock) setStatus('💀 Projection hit a deadlock — this prefix cannot be completed by the policy.', 'err');
  else afterChange(null, true);
  saveHash(); renderAll();
}

// --- rendering ------------------------------------------------------------------

function renderAll() {
  if (state.editing) { renderEditGrid(); renderEditChrome(); return; }
  renderGrid(); renderPicker(); renderStats(); renderChrome(); renderCompare();
}

function renderEditChrome() {
  $('pickerTitle').textContent = 'Free edit mode';
  $('picker').innerHTML = '<span class="hint">Click an op in the grid to lift it, then click a cell to drop it. ' +
    'Shift-click unplaces an op (it moves to the tray). Violations are outlined red and listed under the grid.</span>';
  $('editbtn').style.display = 'none';
  $('editdone').style.display = '';
  $('editcancel').style.display = '';
  for (const id of ['undo', 'redo', 'hintbtn', 'autostep', 'autorun', 'projectbtn', 'resetbtn'])
    $(id).disabled = true;
}

function buildAxis(horizon) {
  const axis = document.createElement('div');
  axis.className = 'timeaxis';
  for (let t = 0; t < horizon; t++) {
    const s = document.createElement('span');
    if (t % 2 === 0) s.textContent = t;
    axis.appendChild(s);
  }
  return axis;
}

// Position the (already-filled) popover near the pointer, clamped to viewport.
function placePopover(ev) {
  const pop = $('popover');
  pop.style.display = '';
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  pop.style.left = Math.max(8, Math.min(ev.clientX - 24, innerWidth - pw - 8)) + 'px';
  pop.style.top = Math.max(8, Math.min(ev.clientY + 14, innerHeight - ph - 8)) + 'px';
}

// One op button, styled by the current theme.
function opButton(op, { notReady = false, onPick }) {
  const btn = document.createElement('button');
  btn.className = 'opbtn' + (notReady ? ' notready' : '');
  btn.dataset.opid = op.id;
  const st = cellStyle(state.theme, state.mode, op, state.sim.cfg);
  btn.style.background = st.bg; btn.style.borderColor = st.border; btn.style.color = st.ink;
  btn.innerHTML = `<span class="stg">${op.stage}</span>${op.kind}${op.mb}`;
  btn.title = opTitle(op, state.sim);
  btn.onclick = () => onPick(op);
  return btn;
}

function opTitle(op, sim) {
  const deps = E.depsOf(sim.cfg, op).map(d => {
    const dop = sim.byId.get(d);
    const p = sim.placed.get(d);
    return `${E.label(dop)} on rank ${dop.rank}${p ? ` (done t=${p.end})` : ' (not scheduled)'}`;
  });
  return `${E.label(op)} — stage ${op.stage}, microbatch ${op.mb}, ${op.dur} slot(s)\nneeds: ${deps.join(', ') || 'nothing'}`;
}

function renderGrid() {
  const sim = state.sim;
  const cfg = sim.cfg;
  const grid = $('grid');
  grid.innerHTML = '';
  const horizon = Math.max(...sim.frontier, state.ref.score.makespan,
    ...(state.hoverGhost ? state.hoverGhost.map(g => g.end) : [])) + 4;

  grid.appendChild(buildAxis(horizon));

  const critSet = state.showCrit && E.isDone(sim)
    ? new Set(E.criticalPath(sim).ids) : null;
  const followGhosts = state.editing ? [] : computeFollowGhosts(sim);

  for (let r = 0; r < cfg.P; r++) {
    const row = document.createElement('div');
    row.className = 'rankrow' + (r === state.selectedRank ? ' selected' : '');
    const head = document.createElement('div');
    head.className = 'rankhead';
    const stages = E.rankStages(cfg, r).join(',');
    const ph = E.phase(sim, r);
    const mem = cfg.cap != null
      ? ` · mem ${sim.inflight[r]}/${cfg.cap}` : '';
    head.innerHTML = `<span class="rname">rank ${r} <span class="phase ${ph}">${ph}</span></span>` +
      `<span class="rmeta">stage${stages.length > 1 ? 's' : ''} ${stages}${mem}</span>`;
    head.onclick = () => { state.selectedRank = r; renderAll(); };
    row.appendChild(head);

    const lane = document.createElement('div');
    lane.className = 'lane';
    lane.style.width = (horizon * CELL) + 'px';
    for (const item of sim.rows[r]) {
      const el = renderItem(item, sim);
      if (critSet && item.id) el.classList.add(critSet.has(item.id) ? 'crit' : 'dim');
      lane.appendChild(el);
    }
    if (state.hoverGhost) {
      for (const g of state.hoverGhost.filter(g => g.rank === r)) {
        const el = renderItem({ id: g.id, start: g.start, dur: g.end - g.start }, sim, true);
        el.classList.add('ghost');
        lane.appendChild(el);
      }
    }
    // follow ghosts: ready continuations (chain or next microbatch), clickable.
    // Frontier sites pad idles up to the slot; idle-gap sites go via fillIdle.
    for (const g of followGhosts.filter(g => g.rank === r)) {
      const op = sim.byId.get(g.id);
      const el = renderItem({ id: g.id, start: g.t, dur: op.dur }, sim, true);
      el.classList.add('ghost', 'follow');
      el.title = `${E.label(op)} is ready — click to place it here (t=${g.t})` +
        (g.mode === 'idle' ? ', filling the idle gap' : '');
      el.style.cursor = 'pointer';
      el.onclick = ev => {
        ev.stopPropagation();
        if (g.mode === 'idle') { fillIdle(r, g.t, g.id); return; }
        const pad = Array.from({ length: g.t - sim.frontier[r] }, () => ({ rank: r, type: 'idle' }));
        tryActions([...pad, { rank: r, type: 'op', id: g.id }]);
      };
      lane.appendChild(el);
    }
    // clickable slots from the frontier onward; clicking a later one
    // auto-pads the gap with idles
    if (E.pendingOps(sim, r).length) {
      const f = sim.frontier[r];
      for (let t = f; t < horizon - 1; t++) {
        const slot = document.createElement('div');
        slot.className = 'slot' + (t === f ? (r === state.selectedRank ? ' active' : '') : ' future');
        slot.dataset.rank = r;
        slot.dataset.t = t;
        slot.style.left = (t * CELL + 1) + 'px';
        if (t === f) slot.textContent = '+';
        slot.title = t === f
          ? `place something at rank ${r}, t=${t}`
          : `place at rank ${r}, t=${t} (idles the ${t - f} slot(s) before it)`;
        slot.onclick = ev => { ev.stopPropagation(); openPopover(r, t, ev); };
        lane.appendChild(slot);
      }
    }
    lane.onclick = () => { closePopover(); state.selectedRank = r; renderAll(); };
    row.appendChild(lane);
    grid.appendChild(renderMemStrip(sim, r, horizon));
    grid.appendChild(row);
  }
}

// Thin activation-memory-over-time bar under each lane. Height ∝ in-flight
// microbatches after the events in that slot; red when at the cap.
function renderMemStrip(sim, r, horizon) {
  const cfg = sim.cfg;
  const strip = document.createElement('div');
  strip.className = 'memrow';
  const lane = document.createElement('div');
  lane.className = 'memlane';
  lane.style.width = (horizon * CELL) + 'px';
  // reconstruct in-flight count per slot from placements on this rank
  const delta = new Array(horizon + 1).fill(0);
  for (const it of sim.rows[r]) {
    if (!it.id) continue;
    const op = sim.byId.get(it.id);
    if (op.kind === 'F') delta[it.start + it.dur - 1]++;
    else if (cfg.model === 'zb' ? op.kind === 'W' : op.kind === 'B')
      delta[it.start + it.dur - 1]--;
  }
  const cap = cfg.cap ?? cfg.M * cfg.V;
  let cur = 0;
  const t99 = sim.frontier[r];
  for (let t = 0; t < Math.min(horizon, t99); t++) {
    cur += delta[t];
    const bar = document.createElement('div');
    bar.className = 'membar' + (cfg.cap != null && cur >= cfg.cap ? ' atcap' : '');
    bar.style.left = (t * CELL) + 'px';
    bar.style.height = Math.max(1, Math.round(12 * cur / cap)) + 'px';
    bar.title = `t=${t}: ${cur} in flight${cfg.cap != null ? ` (cap ${cfg.cap})` : ''}`;
    lane.appendChild(bar);
  }
  strip.appendChild(lane);
  return strip;
}

// Replace a placed idle at (rank, t) with a real op, keeping everything else.
// Rebuild: annotate every action with its current start time, swap the idle
// (consuming extra idles if the op is multi-slot), re-sort by start time so
// cross-rank deps replay in a valid order, and validate atomically.
function fillIdle(r, t, opId) {
  const sim = state.sim;
  const op = sim.byId.get(opId);
  // annotate: rows[r][k] corresponds 1:1 to the k-th action of rank r
  const perRank = Array.from({ length: sim.cfg.P }, () => []);
  for (const a of sim.actions) perRank[a.rank].push(a);
  const annotated = [];
  for (let rr = 0; rr < sim.cfg.P; rr++) {
    sim.rows[rr].forEach((item, k) => {
      annotated.push({ start: item.start, idle: item.id === null, a: perRank[rr][k] });
    });
  }
  // the op needs `dur` consecutive idle slots starting at t on this rank
  const needed = [];
  for (let d = 0; d < op.dur; d++) {
    const hit = annotated.find(x => x.a.rank === r && x.start === t + d && x.idle);
    if (!hit) {
      setStatus(`${E.label(op)} takes ${op.dur} slots — needs idle at t=${t + d} too.`, 'err');
      return;
    }
    needed.push(hit);
  }
  const rebuilt = annotated
    .filter(x => !needed.includes(x) || x === needed[0])
    .map(x => x === needed[0] ? { start: t, a: { rank: r, type: 'op', id: opId } } : x)
    .sort((x, y) => x.start - y.start || x.a.rank - y.a.rank)
    .map(x => x.a);
  try {
    state.sim = E.replay(sim.cfg, rebuilt);
    state.batches = rebuilt.map(() => 1);
    state.redo = [];
    setStatus(`Filled the idle at rank ${r}, t=${t} with ${E.label(op)}.`);
    afterChange({ rank: r, type: 'op', id: opId }, false);
  } catch (err) {
    setStatus(`Can't put ${E.label(op)} there: ${err.message}`, 'err');
    if (err.reason?.dep) highlightDep(err.reason.dep);
  }
}

function openIdlePopover(r, t, ev) {
  state.selectedRank = r;
  renderAll();
  const pop = $('popover');
  const sim = state.sim;
  pop.innerHTML = '';
  const pending = E.pendingOps(sim, r);
  if (!pending.length) pop.innerHTML = '<span class="hint">Rank finished ✓</span>';
  // one row per kind, F → B → W (same order as everywhere else)
  for (const kind of ['F', 'B', 'W']) {
    const ops = pending.filter(o => o.kind === kind)
      .sort((a, b) => a.mb - b.mb || a.stage - b.stage);
    if (!ops.length) continue;
    const group = document.createElement('div');
    group.className = 'kindgroup';
    for (const op of ops) {
      const block = E.blockReason(sim, op, t);
      const ready = !block || block.code === 'memory'; // memory depends on order; let replay judge
      group.appendChild(opButton(op, {
        notReady: state.assist !== 'none' && !ready,
        onPick: o => { closePopover(); fillIdle(r, t, o.id); },
      }));
    }
    pop.appendChild(group);
  }
  placePopover(ev);
}

// --- free-edit mode -----------------------------------------------------------
// Temporarily break invariants: move/lift/place ops anywhere on their rank,
// violations shown live; only a violation-free plan can be committed back.

function enterEdit() {
  state.editing = true;
  state.lifted = null;
  state.plan = new Map([...state.sim.placed.entries()].map(([id, p]) => [id, p.start]));
  closePopover(); hideBanner();
  setStatus('✏️ Free edit: click an op to lift it, click a cell to drop it. Invariants may break — fix all violations to finish.');
  renderAll();
}

function exitEdit(commit) {
  if (!commit) {
    state.editing = false; state.plan = null; state.lifted = null;
    setStatus('Edit cancelled — schedule restored.');
    renderAll();
    return;
  }
  const v = E.planViolations(state.level.cfg, state.plan);
  if (v.length) {
    setStatus(`Can't finish: ${v.length} violation(s) remain — ${v[0].msg}`, 'err');
    return;
  }
  const actions = E.planToActions(state.level.cfg, state.plan);
  state.sim = E.replay(state.level.cfg, actions);
  state.batches = actions.map(() => 1);
  state.redo = [];
  state.editing = false; state.plan = null; state.lifted = null;
  setStatus('✓ Edits applied.');
  afterChange(null, true);
}

function editViolations() {
  return state.editing ? E.planViolations(state.level.cfg, state.plan) : [];
}

function editClickOp(opId) {
  if (state.lifted === opId) state.lifted = null;        // put back down
  else state.lifted = opId;                              // pick up
  renderAll();
}

function editDrop(r, t) {
  const op = state.sim.byId.get(state.lifted);
  if (!op) return;
  if (op.rank !== r) {
    setStatus(`${E.label(op)} lives on rank ${op.rank} — it can't move to rank ${r}.`, 'err');
    return;
  }
  state.plan.set(op.id, t);
  state.lifted = null;
  renderAll();
}

function editRemove(opId) {
  state.plan.delete(opId);
  if (state.lifted === opId) state.lifted = null;
  renderAll();
}

function renderEditGrid() {
  const sim = state.sim;
  const cfg = sim.cfg;
  const grid = $('grid');
  grid.innerHTML = '';
  const plan = state.plan;
  const viol = editViolations();
  const badIds = new Set(viol.map(v => v.id));
  const horizon = Math.max(state.ref.score.makespan,
    ...[...plan.entries()].map(([id, s]) => s + sim.byId.get(id).dur), 10) + 6;
  grid.appendChild(buildAxis(horizon));

  for (let r = 0; r < cfg.P; r++) {
    const row = document.createElement('div');
    row.className = 'rankrow editing';
    const head = document.createElement('div');
    head.className = 'rankhead';
    head.innerHTML = `<span class="rname">rank ${r}</span>` +
      `<span class="rmeta">stage${E.rankStages(cfg, r).length > 1 ? 's' : ''} ${E.rankStages(cfg, r).join(',')}</span>`;
    row.appendChild(head);
    const lane = document.createElement('div');
    lane.className = 'lane';
    lane.style.width = (horizon * CELL) + 'px';
    // drop cells (behind ops) when an op of this rank is lifted
    const liftedOp = state.lifted ? sim.byId.get(state.lifted) : null;
    if (liftedOp && liftedOp.rank === r) {
      for (let t = 0; t < horizon - 1; t++) {
        const cell = document.createElement('div');
        cell.className = 'slot dropcell';
        cell.style.left = (t * CELL + 1) + 'px';
        cell.onclick = ev => { ev.stopPropagation(); editDrop(r, t); };
        lane.appendChild(cell);
      }
    }
    for (const [id, start] of plan) {
      const op = sim.byId.get(id);
      if (op.rank !== r) continue;
      const el = renderItem({ id, start, dur: op.dur }, sim, true);
      el.classList.remove('ghost');
      if (badIds.has(id)) el.classList.add('violation');
      if (state.lifted === id) el.classList.add('lifted');
      el.title = opTitle(op, sim) + '\n(click to lift/move; shift-click to unplace)';
      el.onclick = ev => {
        ev.stopPropagation();
        if (ev.shiftKey) editRemove(id); else editClickOp(id);
      };
      lane.appendChild(el);
    }
    row.appendChild(lane);
    grid.appendChild(row);
  }

  // tray of unplaced ops + violations list
  const tray = document.createElement('div');
  tray.className = 'edittray';
  const unplaced = sim.ops.filter(o => !plan.has(o.id));
  if (unplaced.length) {
    const lbl = document.createElement('span');
    lbl.className = 'kindlabel';
    lbl.textContent = `unplaced (${unplaced.length}):`;
    tray.appendChild(lbl);
    for (const op of unplaced.slice(0, 40)) {
      const btn = opButton(op, { onPick: o => editClickOp(o.id) });
      if (state.lifted === op.id) btn.classList.add('pulse');
      tray.appendChild(btn);
    }
    if (unplaced.length > 40) tray.append(` …and ${unplaced.length - 40} more`);
  }
  grid.appendChild(tray);

  const vlist = document.createElement('div');
  vlist.className = 'violations';
  if (!viol.length) {
    vlist.innerHTML = '<b class="beat">✓ no violations</b> — press "finish editing" to apply.';
  } else {
    // are the violations repairable by placing more ops? (dep problems only)
    const depOnly = viol.every(v => v.code === 'dep-missing' || v.code === 'dep-late');
    vlist.innerHTML =
      `<b>${viol.length} violation(s):</b><br>` +
      viol.slice(0, 8).map(v => `• ${v.msg}`).join('<br>') +
      (viol.length > 8 ? `<br>…and ${viol.length - 8} more` : '');
    if (depOnly) {
      const comp = E.planCompletion(cfg, plan);
      const line = document.createElement('div');
      if (comp.feasible) {
        line.innerHTML = `<b class="beat">…but fixable:</b> the missing dependencies fit in the blanks. `;
        if (comp.forced.size) {
          const a = document.createElement('a');
          a.href = '#';
          a.textContent = `${comp.forced.size} op(s) have exactly one legal slot — autofill them`;
          a.onclick = ev => {
            ev.preventDefault();
            for (const [id, t] of comp.forced) state.plan.set(id, t);
            renderAll();
          };
          line.appendChild(a);
        }
      } else {
        line.innerHTML = `<b>…and NOT fixable:</b> the missing deps can't fit in the remaining blanks. Something must move.`;
      }
      vlist.appendChild(line);
    }
  }
  grid.appendChild(vlist);
}

// Rewind: truncate history to just before the action that placed `opId`.
function rewindTo(opId) {
  const acts = state.sim.actions;
  const i = acts.findIndex(a => a.type === 'op' && a.id === opId);
  if (i < 0) return;
  const removed = acts.slice(i);
  state.redo = removed.map(a => [a]).reverse().concat(state.redo);
  state.sim = E.replay(state.level.cfg, acts.slice(0, i));
  state.batches = acts.slice(0, i).map(() => 1);
  hideBanner();
  setStatus(`Rewound ${removed.length} placement(s) — redo restores them in order.`);
  autoAdvanceSelection();
  saveHash(); renderAll();
}

function renderItem(item, sim, isGhost = false) {
  const el = document.createElement('div');
  el.style.left = (item.start * CELL + 1) + 'px';
  el.style.width = (item.dur * CELL - 4) + 'px';
  if (!item.id) {
    el.className = 'op idle';
    if (isGhost) { el.title = 'idle (bubble)'; return el; }
    const r = state.sim.rows.findIndex(row => row.includes(item));
    if (E.isDone(state.sim)) {
      el.title = E.explainIdle(state.sim, r, item.start).msg;
    } else {
      el.title = `idle at t=${item.start} — click to fill it with work`;
      el.onclick = ev => {
        ev.stopPropagation();
        openIdlePopover(r, item.start, ev);
      };
    }
    return el;
  }
  const op = sim.byId.get(item.id);
  const st = cellStyle(state.theme, state.mode, op, sim.cfg);
  el.className = 'op' + (st.hatch ? ' hatch' : '');
  el.dataset.opid = op.id;
  el.style.background = st.bg;
  el.style.borderColor = st.border;
  el.style.color = st.ink;
  el.innerHTML = `<span class="stg">${op.stage}</span>${op.kind}${op.mb}`;
  el.title = opTitle(op, sim) + '\n(click to rewind to just before this)';
  if (!isGhost) {
    el.onmouseenter = () => traceDeps(op);
    el.onmouseleave = () => clearTrace();
    el.onclick = ev => { ev.stopPropagation(); rewindTo(op.id); };
  }
  return el;
}

function traceDeps(op) {
  if (state.showCrit) return;   // crit view owns the dim/highlight classes
  const sim = state.sim;
  const up = new Set(E.depsOf(sim.cfg, op));
  const down = new Set(sim.ops.filter(o => E.depsOf(sim.cfg, o).includes(op.id)).map(o => o.id));
  document.querySelectorAll('#grid .op[data-opid]').forEach(el => {
    const id = el.dataset.opid;
    if (up.has(id)) el.classList.add('dep-up');
    else if (down.has(id)) el.classList.add('dep-down');
    else if (id !== op.id) el.classList.add('dim');
  });
}
function clearTrace() {
  if (state.showCrit) return;
  document.querySelectorAll('#grid .op').forEach(el =>
    el.classList.remove('dep-up', 'dep-down', 'dim'));
}

// Build op buttons for a rank into `box`. Used by both the picker panel and
// the click-a-slot popover. `at` targets a slot at/after the frontier;
// clicking an op auto-pads the gap with idles (committed atomically).
function buildOpButtons(box, r, at = null, compact = false) {
  const sim = state.sim;
  const f = sim.frontier[r];
  const t = at ?? f;
  const pad = Array.from({ length: t - f }, () => ({ rank: r, type: 'idle' }));
  box.innerHTML = '';
  const pending = E.pendingOps(sim, r);
  if (!pending.length) {
    box.innerHTML = '<span class="hint">Rank finished ✓ — pick another rank.</span>';
    return;
  }
  const kinds = [...new Set(pending.map(o => o.kind))];
  for (const kind of kinds) {
    const group = document.createElement('div');
    group.className = 'kindgroup';
    if (!compact) {
      const lbl = document.createElement('span');
      lbl.className = 'kindlabel';
      lbl.textContent = {
        F: 'forward',
        B: sim.cfg.model === 'zb' ? 'backward (input grad)' : 'backward',
        W: 'weight grad',
      }[kind];
      group.appendChild(lbl);
    }
    for (const op of pending.filter(o => o.kind === kind)
                            .sort((a, b) => a.mb - b.mb || a.stage - b.stage)) {
      const ready = !E.blockReason(sim, op, t);
      const btn = opButton(op, {
        notReady: state.assist !== 'none' && !ready,
        onPick: o => {
          closePopover();
          tryActions([...pad, { rank: r, type: 'op', id: o.id }]);
        },
      });
      btn.onmouseenter = () => previewConsequence(op, ready, r, t);
      btn.onmouseleave = () => { $('hint').textContent = ''; state.hoverGhost = null; renderGrid(); };
      group.appendChild(btn);
    }
    box.appendChild(group);
  }
  // explicit idle only in the frontier picker; slot-clicking pads automatically
  if (at === null) {
    const wgroup = document.createElement('div');
    wgroup.className = 'kindgroup';
    const wlbl = document.createElement('span');
    wlbl.className = 'kindlabel';
    wlbl.textContent = 'wait';
    wgroup.appendChild(wlbl);
    const idle = document.createElement('button');
    idle.className = 'opbtn';
    idle.textContent = '⏸ idle';
    idle.title = 'Leave this slot empty — or just click a later slot directly.';
    idle.onclick = () => { closePopover(); tryAction({ rank: r, type: 'idle' }); };
    wgroup.appendChild(idle);
    box.appendChild(wgroup);
  }
}

function renderPicker() {
  const sim = state.sim;
  const r = state.selectedRank;
  $('pickerTitle').textContent =
    `Place at rank ${r}, t=${sim.frontier[r]} (${E.phase(sim, r)})`;
  buildOpButtons($('picker'), r);

  if (state.assist === 'coach' && featureOn('assist')) {
    const pick = E.policyPick(sim, r, state.level.policy);
    if (pick?.action.type === 'op') {
      const op = sim.byId.get(pick.action.id);
      $('hint').textContent = pick.tie
        ? `Coach: it's a genuine tie — ${E.label(op)} is fine, but so are others.`
        : `Coach (${E.POLICIES[state.level.policy].name}): run ${E.label(op)}.`;
    } else if (pick) {
      $('hint').textContent = 'Coach: nothing is ready — idle this slot.';
    }
  }
}

// --- popover: click the next-slot square, pick what goes there ---------------

function openPopover(r, t, ev) {
  state.selectedRank = r;
  renderAll();
  buildOpButtons($('popover'), r, t, true);  // compact: no kind labels
  placePopover(ev);
}

function closePopover() {
  $('popover').style.display = 'none';
}

// Hint: pulse the coach's pick in the picker/popover without placing it.
function showHint() {
  // hint about the earliest-frontier rank (same target as step ▸)
  let rank = -1, best = Infinity;
  for (let r = 0; r < state.sim.cfg.P; r++) {
    if (E.pendingOps(state.sim, r).length && state.sim.frontier[r] < best) {
      best = state.sim.frontier[r]; rank = r;
    }
  }
  if (rank < 0) { setStatus('Schedule is complete.'); return; }
  if (rank !== state.selectedRank) { state.selectedRank = rank; renderAll(); }
  const pick = E.policyPick(state.sim, rank, state.level.policy);
  if (pick.tie) {
    setStatus('⚖️ Genuine tie — several moves are equally standard here. Your call.');
    return;
  }
  if (pick.action.type === 'idle') {
    setStatus(`Hint: nothing is ready on rank ${rank} — place an idle (or click a later slot).`);
    return;
  }
  const op = state.sim.byId.get(pick.action.id);
  setStatus(`Hint: run ${E.label(op)} on rank ${rank} (${E.POLICIES[state.level.policy].name}).`);
  document.querySelectorAll(`.opbtn[data-opid="${CSS.escape(op.id)}"]`).forEach(el => {
    el.classList.remove('pulse'); void el.offsetWidth; el.classList.add('pulse');
  });
}

function previewConsequence(op, ready, r = state.selectedRank, t = null) {
  const sim = state.sim;
  const at = t ?? sim.frontier[r];
  if (!ready) {
    const block = E.blockReason(sim, op, at);
    $('hint').textContent = `${E.label(op)}: ${block.msg}`;
    if (block.dep) highlightDep(block.dep);
    return;
  }
  // ghost projection is a coach-level assist — with lighter help it's cheating
  if (state.assist !== 'coach' || !featureOn('assist')) return;
  const pad = Array.from({ length: at - sim.frontier[r] }, () => ({ rank: r, type: 'idle' }));
  try {
    const base = E.replay(sim.cfg, sim.actions);
    E.project(base, state.level.policy);
    const withOp = E.replay(sim.cfg, [...sim.actions, ...pad, { rank: r, type: 'op', id: op.id }]);
    const placedBefore = new Set(sim.placed.keys());
    E.project(withOp, state.level.policy);
    const dm = E.score(withOp).makespan - E.score(base).makespan;
    $('hint').textContent = dm > 0
      ? `${E.label(op)} is legal, but projecting the standard policy afterward costs +${dm} slot(s) of makespan.`
      : `${E.label(op)} — projected final makespan ${E.score(withOp).makespan} (no penalty).`;
    state.hoverGhost = [...withOp.placed.entries()]
      .filter(([id]) => !placedBefore.has(id))
      .map(([id, p]) => ({ id, rank: withOp.byId.get(id).rank, start: p.start, end: p.end }));
    renderGrid();
  } catch { /* projection can fail on weird prefixes; stay quiet */ }
}

function highlightDep(depId) {
  document.querySelectorAll(`#grid .op[data-opid="${CSS.escape(depId)}"]`)
    .forEach(el => el.classList.add('dep-up'));
  setTimeout(clearTrace, 1500);
}

function renderStats() {
  const sim = state.sim;
  const panel = $('scorePanel');
  if (!featureOn('scoreboard')) { panel.style.display = 'none'; return; }
  panel.style.display = '';
  const s = E.score(sim);
  // when the reference is on display, add its per-rank util/peak for comparison
  const withPar = state.showCompare;
  const ref = state.ref.state;
  const rankUtil = (st, r) => {
    const busy = st.rows[r].filter(i => i.id).reduce((a, i) => a + i.dur, 0);
    const t = st.frontier[r];
    return t ? busy / t : null;
  };
  const rows = [];
  for (let r = 0; r < sim.cfg.P; r++) {
    const u = rankUtil(sim, r);
    const capSuffix = sim.cfg.cap != null ? '/' + sim.cfg.cap : '';
    let cells = `<td>rank ${r}</td><td>${sim.frontier[r]}</td>` +
      `<td>${u === null ? '—' : pct(u)}</td>` +
      `<td>${sim.peak[r]}${capSuffix}</td>`;
    if (withPar) {
      const pu = rankUtil(ref, r);
      cells += `<td class="parcol">${pu === null ? '—' : pct(pu)}</td>` +
        `<td class="parcol">${ref.peak[r]}${capSuffix}</td>`;
    }
    rows.push(`<tr>${cells}</tr>`);
  }
  const done = E.isDone(sim);
  const parM = state.ref.score.makespan;
  $('stats').innerHTML =
    `<table class="stats">
      <tr><th>rank</th><th>t</th><th>util</th><th>peak mem</th>` +
      (withPar ? '<th class="parcol">par util</th><th class="parcol">par mem</th>' : '') +
      `</tr>
      ${rows.join('')}
    </table>
    <table class="stats" style="margin-top:8px">
      <tr><td>placed</td><td>${sim.placed.size} / ${sim.ops.length}</td></tr>
      <tr><td>makespan${done ? '' : ' (so far)'}</td>
          <td class="${done ? (s.makespan <= parM ? 'beat' : 'miss') : ''}">${s.makespan}</td></tr>
      <tr><td>par (policy reference)</td><td>${parM}</td></tr>
      <tr><td>bubble${done ? '' : ' (so far)'}</td><td>${pct(s.bubble)}</td></tr>
      <tr><td>par bubble</td><td>${pct(state.ref.score.bubble)}</td></tr>
      <tr><td title="idle between each rank's own first and last op — ignores the unavoidable fill/drain stagger">internal bubble</td>
          <td>${pct(s.internalBubble)} <span style="color:var(--muted)">(par ${pct(state.ref.score.internalBubble)})</span></td></tr>
      ${(() => {
        const sol = store.solution(state.level.key);
        return sol ? `<tr><td>your best</td><td>${sol.makespan}</td></tr>` : '';
      })()}
    </table>`;
}

// show/hide progressive UI, populate level select with locks
function renderChrome() {
  $('editbtn').style.display = state.sim.actions.length ? '' : 'none';
  $('editdone').style.display = 'none';
  $('editcancel').style.display = 'none';
  $('resetbtn').disabled = false;
  $('undo').disabled = !state.sim.actions.length;
  $('redo').disabled = !state.redo.length;
  const done = E.isDone(state.sim);

  const vis = (id, on) => { $(id).style.display = on ? '' : 'none'; };
  vis('assistwrap', featureOn('assist'));
  vis('themewrap', featureOn('theme'));
  vis('hintbtn', featureOn('step'));
  vis('autostep', featureOn('step'));
  vis('autorun', featureOn('autorun'));
  vis('projectbtn', featureOn('project'));
  vis('customwrap', featureOn('custom'));
  $('hintbtn').disabled = done;
  $('autostep').disabled = done;
  $('autorun').disabled = done;
  $('projectbtn').disabled = done;

  const lsel = $('levelsel');
  const cur = state.level.key;
  lsel.innerHTML = '';
  LEVELS.forEach((l, i) => {
    const o = document.createElement('option');
    o.value = l.key;
    const mark = store.solution(l.key) ? ' ✓' : '';
    o.textContent = levelPlayable(i) ? l.name + mark : `🔒 ${l.name}`;
    o.disabled = !levelPlayable(i);
    lsel.appendChild(o);
  });
  if (featureOn('custom')) {
    const o = document.createElement('option');
    o.value = 'custom';
    o.textContent = '⚙ Sandbox (custom settings)';
    lsel.appendChild(o);
  }
  lsel.value = cur;
  vis('cfgrow', cur === 'custom');
  vis('unlockall', !store.unlockAll);

  const sol = store.solution(state.level.key);
  vis('loadsol', !!sol);
  if (sol) $('loadsol').title =
    `Load your best solution for this level (makespan ${sol.makespan})`;

  $('playbtn').disabled = !state.sim.actions.length;
  $('svgbtn').disabled = !state.sim.actions.length;

  // ⧉ stamp: available when exactly one microbatch is fully scheduled
  const soleMb = E.soleMicrobatch(state.sim);
  const stampable = soleMb !== null && !E.isDone(state.sim);
  $('stampbtn').style.display = stampable ? '' : 'none';
  if (stampable) {
    const bs = E.blockStats(state.sim, soleMb);
    $('stampbtn').title =
      `Repeat microbatch ${soleMb}'s trajectory for all ${state.sim.cfg.M} microbatches, ` +
      `shifted ${bs.w} slots apart. Predicted peak memory per rank: ${bs.peak.join('/')}` +
      (state.sim.cfg.cap != null ? ` (cap ${state.sim.cfg.cap})` : '') +
      `. The block's lifespan on each rank determines its memory (Qi et al. 2024).`;
  }
}

function stampCurrentBlock() {
  const mb = E.soleMicrobatch(state.sim);
  if (mb === null) return;
  const bs = E.blockStats(state.sim, mb);
  const res = E.stampBlock(state.sim, mb);
  if (res.violations) {
    setStatus(`⧉ This block doesn't tile: ${res.violations[0].msg}`, 'err');
    return;
  }
  state.sim = E.replay(state.level.cfg, res.actions);
  state.batches = res.actions.map(() => 1);
  state.redo = [];
  log(`Stamped microbatch ${mb}'s block across all ${state.sim.cfg.M} microbatches ` +
      `(interval ${bs.w}, predicted peak ${bs.peak.join('/')}).`, 'event');
  afterChange(null, true);
  $('logPanel').style.display = $('log').childElementCount ? '' : 'none';
}

// --- banner / status -------------------------------------------------------------

function showBanner(won, s) {
  const b = $('banner');
  const idx = levelIndex(state.level.key);
  const next = idx >= 0 ? LEVELS[idx + 1] : null;
  b.className = won ? 'banner won' : 'banner missed';
  b.style.display = '';
  const parM = state.ref.score.makespan;
  // which schedule from the literature is this?
  const rec = E.recognizeSchedule(state.sim);
  const recMsg = rec?.name
    ? ` You built <b>${rec.name}</b> — ${rec.note}.`
    : ` This op ordering doesn't match any schedule in our library — it's yours. 🧪`;
  let msg;
  if (won) {
    msg = `🎉 <b>Level cleared!</b> Makespan ${s.makespan}` +
      (state.level.goal === 'internal0' ? `, internal bubble ${pct(s.internalBubble)}` :
       s.makespan <= parM ? ` — matched par` : '') + '.' + recMsg;
  } else if (state.level.goal === 'internal0') {
    msg = `✅ Complete, but internal bubble is ${pct(s.internalBubble)} — the goal is 0%. ` +
      `Find the gaps (hatched slots between a rank's first and last op) and fill them with W ops.`;
  } else {
    msg = `✅ Complete, but makespan ${s.makespan} vs par ${parM} — ` +
      `${s.makespan - parM} slot(s) of avoidable bubble to squeeze out.`;
  }
  $('bannerMsg').innerHTML = msg;
  $('nextlevel').style.display = won && next ? '' : 'none';
  if (won && next) $('nextlevel').textContent = `next: ${next.name} →`;
  $('retrybtn').style.display = won ? 'none' : '';
  $('critbtn').style.display = '';
  $('critbtn').textContent = state.showCrit ? 'hide critical path' : '🔦 critical path';
  $('comparebtn').style.display = '';
  $('comparebtn').textContent = state.showCompare ? 'hide reference' : '⇵ compare with par';
}

// Render the reference schedule as a second, read-only grid for comparison.
function renderCompare() {
  const wrap = $('compare');
  if (!state.showCompare || !E.isDone(state.sim)) { wrap.style.display = 'none'; return; }
  wrap.style.display = '';
  const ref = state.ref.state;
  const horizon = Math.max(...state.sim.frontier, ref ? E.score(ref).makespan : 0) + 4;
  const grid = $('comparegrid');
  grid.innerHTML = '';
  grid.appendChild(buildAxis(horizon));
  for (let r = 0; r < ref.cfg.P; r++) {
    const row = document.createElement('div');
    row.className = 'rankrow';
    const head = document.createElement('div');
    head.className = 'rankhead';
    head.innerHTML = `<span class="rname">rank ${r}</span><span class="rmeta">reference</span>`;
    row.appendChild(head);
    const lane = document.createElement('div');
    lane.className = 'lane';
    lane.style.width = (horizon * CELL) + 'px';
    for (const item of ref.rows[r]) {
      const el = renderItem(item, ref, true);
      el.classList.remove('ghost');
      el.style.cursor = 'default';
      lane.appendChild(el);
    }
    row.appendChild(lane);
    grid.appendChild(row);
  }
}

function toggleCompare() {
  state.showCompare = !state.showCompare;
  renderCompare();
  renderStats();
  if (E.isDone(state.sim)) showBanner(state.cleared || goalMet(E.score(state.sim)), E.score(state.sim));
  if (state.showCompare) {
    const d = E.score(state.sim).makespan - state.ref.score.makespan;
    setStatus(d > 0
      ? `Reference shown below yours. It finishes ${d} slot(s) sooner — scan column by column to find where you fell behind.`
      : d < 0
      ? `Reference shown below yours — and you BEAT it by ${-d} slot(s). 🏆`
      : `Reference shown below yours. Same makespan — compare the op orders to see if you found a different route.`);
  }
}

// --- playback ------------------------------------------------------------------
// Sweep a "now" cursor across the schedule: ops in the future are faded, the
// op executing on each rank right now is lit. Connects the static time-space
// picture to what the cluster is doing moment to moment.

function stopPlayback(rerender = true) {
  clearInterval(state.playTimer);
  state.playTimer = null;
  state.playT = null;
  $('playbtn').textContent = '▶ play';
  if (rerender) renderAll();
}

function togglePlayback() {
  if (state.playTimer) { stopPlayback(); return; }
  const end = Math.max(...state.sim.frontier);
  if (!end) return;
  state.playT = 0;
  $('playbtn').textContent = '⏹ stop';
  closePopover();
  applyPlaybackClasses();
  state.playTimer = setInterval(() => {
    state.playT++;
    if (state.playT > end) { stopPlayback(); return; }
    applyPlaybackClasses();
  }, 420);
}

function applyPlaybackClasses() {
  const t = state.playT;
  const sim = state.sim;
  document.querySelectorAll('#grid .op[data-opid]').forEach(el => {
    const p = sim.placed.get(el.dataset.opid);
    el.classList.remove('future', 'running');
    if (p.start > t) el.classList.add('future');
    else if (p.start <= t && t < p.end) el.classList.add('running');
  });
  let cursor = $('playcursor');
  if (!cursor) {
    cursor = document.createElement('div');
    cursor.id = 'playcursor';
    $('grid').appendChild(cursor);
  }
  cursor.style.left = (130 + (t + 1) * CELL) + 'px';
  // narrate what's happening now
  const active = [];
  for (let r = 0; r < sim.cfg.P; r++) {
    const it = sim.rows[r].find(i => i.start <= t && t < i.start + i.dur);
    if (it?.id) active.push(`rank ${r}: ${E.label(sim.byId.get(it.id))}`);
    else if (it) active.push(`rank ${r}: idle`);
  }
  setStatus(`t=${t} — ${active.join(' · ') || 'nothing running yet'}`);
}

// Toggle critical-path highlight: dim everything off the path, show why the
// makespan is what it is. Hovering idles explains each bubble (tooltip).
function toggleCrit() {
  state.showCrit = !state.showCrit;
  if (state.showCrit) {
    const { breaks } = E.criticalPath(state.sim);
    setStatus(breaks.length
      ? `Critical path shown. ⚠ It hit a voluntary delay: ${E.label(state.sim.byId.get(breaks[0].id))} ` +
        `started at t=${breaks[0].actual} but could have started at t=${breaks[0].couldHaveStarted} — that gap is yours to close.`
      : `Critical path shown: the chain of ops that sets the makespan. Every op on it is gated by the one before — ` +
        `to finish faster, this chain itself must change. Hover any idle to see why that bubble exists.`);
  } else setStatus('');
  renderAll();
  if (E.isDone(state.sim)) showBanner(state.cleared || goalMet(E.score(state.sim)), E.score(state.sim));
}
function hideBanner() { $('banner').style.display = 'none'; }

function setStatus(msg, cls = '') {
  const el = $('status');
  el.textContent = msg;
  el.className = 'status ' + cls;
  if (cls === 'err') {
    el.classList.remove('shake'); void el.offsetWidth;
    el.classList.add('shake');
  }
}

function log(msg, cls = '') {
  const div = document.createElement('div');
  div.className = 'entry ' + cls;
  div.textContent = msg;
  $('log').prepend(div);
}
function logClear() { $('log').innerHTML = ''; }

// --- URL state -------------------------------------------------------------------

function saveHash() {
  const acts = state.sim.actions.map(a =>
    a.type === 'idle' ? `${a.rank}:.` : `${a.rank}:${a.id}`).join(',');
  let h = `level=${state.level.key}`;
  if (state.level.key === 'custom') {
    const c = state.level.cfg;
    h += `&cfg=${c.P}.${c.V}.${c.M}.${c.model}.${c.cap ?? 'x'}.${c.warmup ?? 'std'}.${c.place ?? 'auto'}`;
  }
  if (acts) h += '&a=' + acts;
  history.replaceState(null, '', '#' + h);
}

function loadHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  let level;
  if (p.get('level') === 'custom' && p.get('cfg')) {
    const [P, V, M, model, cap, warmup, place] = p.get('cfg').split('.');
    level = customLevel({ P: +P, V: +V, M: +M, model,
      cap: cap === 'x' ? null : +cap,
      ...(warmup === 'zb2' ? { warmup: 'zb2' } : {}),
      ...(place && place !== 'auto' ? { place } : {}) });
  } else {
    level = levelByKey(p.get('level') || LEVELS[0].key);
  }
  const actions = (p.get('a') || '').split(',').filter(Boolean).map(tok => {
    const i = tok.indexOf(':');
    const rank = +tok.slice(0, i), rest = tok.slice(i + 1);
    return rest === '.' ? { rank, type: 'idle' } : { rank, type: 'op', id: rest };
  });
  try { loadLevel(level, actions); }
  catch { loadLevel(level, []); }
}

// --- wiring -------------------------------------------------------------------

function init() {
  document.documentElement.dataset.theme = state.mode;

  $('levelsel').onchange = e => {
    if (e.target.value === 'custom') loadLevel(customLevel(readCustomCfg()));
    else loadLevel(levelByKey(e.target.value));
  };
  $('cfgapply').onclick = () => loadLevel(customLevel(readCustomCfg()));
  $('hintbtn').onclick = showHint;
  $('stampbtn').onclick = stampCurrentBlock;
  document.addEventListener('click', e => {
    if (!$('popover').contains(e.target) && !e.target.classList?.contains('slot'))
      closePopover();
  });
  $('gridwrap').addEventListener('scroll', closePopover);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closePopover(); });

  const tsel = $('themesel');
  for (const [k, t] of Object.entries(THEMES)) {
    const o = document.createElement('option');
    o.value = k; o.textContent = t.name;
    tsel.appendChild(o);
  }
  tsel.onchange = () => { state.theme = tsel.value; renderAll(); };

  $('assistsel').onchange = e => { state.assist = e.target.value; renderAll(); };
  $('darktoggle').onclick = () => {
    state.mode = state.mode === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = state.mode;
    renderAll();
  };
  $('undo').onclick = undo;
  $('redo').onclick = redo;
  $('resetbtn').onclick = () => loadLevel(state.level);
  $('autostep').onclick = autoStep;
  $('autorun').onclick = autoRunUntilStrange;
  $('projectbtn').onclick = projectRest;
  $('unlockall').onclick = () => { store.unlockAll = true; renderChrome(); };
  $('loadsol').onclick = () => {
    const sol = store.solution(state.level.key);
    if (sol) loadLevel(state.level, sol.actions);
  };
  $('editbtn').onclick = enterEdit;
  $('editdone').onclick = () => exitEdit(true);
  $('editcancel').onclick = () => exitEdit(false);
  $('nextlevel').onclick = () => {
    const next = LEVELS[levelIndex(state.level.key) + 1];
    if (next) { hideBanner(); loadLevel(next); }
  };
  $('retrybtn').onclick = () => { hideBanner(); loadLevel(state.level); };
  $('critbtn').onclick = toggleCrit;
  $('comparebtn').onclick = toggleCompare;
  $('playbtn').onclick = togglePlayback;
  $('svgbtn').onclick = () => {
    const cfg = state.sim.cfg;
    downloadSVG(state.sim, { theme: state.theme, mode: state.mode,
      title: `P=${cfg.P} V=${cfg.V} M=${cfg.M} (${cfg.model})` });
    setStatus('⤓ SVG downloaded — drop it straight into slides or a paper.');
  };
  $('sharebtn').onclick = async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      setStatus('🔗 Link copied — it reproduces this exact position, including partial schedules.');
    } catch {
      setStatus(`Copy this link: ${location.href}`);
    }
  };

  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT') return;
    if ((e.metaKey || e.ctrlKey) && e.key === 'z') { e.shiftKey ? redo() : undo(); e.preventDefault(); }
    else if (e.key === 'ArrowDown') { state.selectedRank = Math.min(state.level.cfg.P - 1, state.selectedRank + 1); renderAll(); }
    else if (e.key === 'ArrowUp') { state.selectedRank = Math.max(0, state.selectedRank - 1); renderAll(); }
    else if (e.key === ' ' && featureOn('step')) { autoStep(); e.preventDefault(); }
    else if (e.key === 'i') { tryAction({ rank: state.selectedRank, type: 'idle' }); }
  });

  loadHash();
}

init();
