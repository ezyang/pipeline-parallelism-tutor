import * as E from './engine.js';
import { LEVELS, levelByKey, levelIndex } from './levels.js';
import { THEMES, cellStyle } from './palettes.js';

const $ = id => document.getElementById(id);
const CELL = 34;

// --- progression -------------------------------------------------------------
// progress = number of levels cleared; levels 0..progress are playable.
// UI features unlock at level indices (kept once unlocked).

const FEATURE_AT = {
  scoreboard: 1,   // pipelining level introduces bubble/par
  theme: 1,
  assist: 3,       // 1F1B introduces the coach + validate-only mode
  step: 3,         // hint button
  autorun: 4,      // B=2F: warmup is tedious, earn the fast-forward
  project: 4,      // solve button
  custom: 3,       // sandbox settings
};

const store = {
  get progress() { return +(localStorage.getItem('ppt-progress') ?? 0); },
  set progress(v) { localStorage.setItem('ppt-progress', v); },
  get unlockAll() { return localStorage.getItem('ppt-unlock-all') === '1'; },
  set unlockAll(v) { localStorage.setItem('ppt-unlock-all', v ? '1' : '0'); },
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
  redo: [],
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
  return { P, V, M, model, cap, ...(warmup ? { warmup } : {}) };
}

function loadLevel(level, actions = []) {
  state.level = level;
  state.sim = E.replay(level.cfg, actions);
  state.ref = E.referenceSchedule(level.cfg);
  state.redo = [];
  state.seenEvents = new Set();
  state.selectedRank = 0;
  state.hoverGhost = null;
  state.cleared = false;
  $('blurb').textContent = level.blurb;
  $('goal').textContent = goalText(level);
  logClear();
  saveHash();
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

function tryAction(action, { silent = false } = {}) {
  try {
    E.apply(state.sim, action);
    state.redo = [];
    setStatus('');
    afterChange(action, silent);
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
    showBanner(won, s);
    log(`Schedule complete: makespan ${s.makespan}, bubble ${pct(s.bubble)}, ` +
        `internal ${pct(s.internalBubble)}, peak ${s.peak.join('/')}.`, 'event');
  } else {
    hideBanner();
    autoAdvanceSelection();
  }
  saveHash();
  renderAll();
}

function undo() {
  const acts = state.sim.actions;
  if (!acts.length) return;
  state.redo.push(acts[acts.length - 1]);
  state.sim = E.replay(state.level.cfg, acts.slice(0, -1));
  hideBanner(); setStatus('');
  autoAdvanceSelection();
  saveHash(); renderAll();
}

function redo() {
  const a = state.redo.pop();
  if (a) { E.apply(state.sim, a); autoAdvanceSelection(); saveHash(); renderAll(); }
}

function autoStep() {
  const pick = E.policyPick(state.sim, state.selectedRank, state.level.policy);
  if (!pick) { setStatus('This rank is finished.'); return; }
  if (pick.tie) {
    setStatus('⚖️ Genuine tie — the policy has no preference here. Your call.');
    return;
  }
  tryAction(pick.action);
}

function autoRunUntilStrange() {
  const res = E.autoRun(state.sim, state.level.policy, state.seenEvents);
  state.redo = [];
  if (res.stopped === 'event') {
    setStatus(`⏸ ${res.event.msg}` +
      (res.event.kind === 'tie' ? ` — choices: ${res.event.choices.join(', ')}` : ''));
    log(res.event.msg, 'event');
  } else if (res.stopped === 'done') {
    afterChange(null, true); return;
  } else if (res.stopped === 'deadlock') {
    setStatus('💀 Deadlock: nothing is ready anywhere and nothing is running. Undo and rethink.', 'err');
  }
  for (const e of res.events) if (e.kind !== 'tie') log(e.msg);
  autoAdvanceSelection();
  saveHash(); renderAll();
}

function projectRest() {
  const res = E.project(state.sim, state.level.policy);
  state.redo = [];
  if (res.deadlock) setStatus('💀 Projection hit a deadlock — this prefix cannot be completed by the policy.', 'err');
  else afterChange(null, true);
  saveHash(); renderAll();
}

// --- rendering ------------------------------------------------------------------

function renderAll() { renderGrid(); renderPicker(); renderStats(); renderChrome(); }

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

  const axis = document.createElement('div');
  axis.className = 'timeaxis';
  for (let t = 0; t < horizon; t++) {
    const s = document.createElement('span');
    if (t % 2 === 0) s.textContent = t;
    axis.appendChild(s);
  }
  grid.appendChild(axis);

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
    for (const item of sim.rows[r]) lane.appendChild(renderItem(item, sim));
    if (state.hoverGhost) {
      for (const g of state.hoverGhost.filter(g => g.rank === r)) {
        const el = renderItem({ id: g.id, start: g.start, dur: g.end - g.start }, sim, true);
        el.classList.add('ghost');
        lane.appendChild(el);
      }
    }
    // clickable "next slot" square at the frontier
    if (E.pendingOps(sim, r).length) {
      const slot = document.createElement('div');
      slot.className = 'slot' + (r === state.selectedRank ? ' active' : '');
      slot.dataset.rank = r;
      slot.style.left = (sim.frontier[r] * CELL + 1) + 'px';
      slot.textContent = '+';
      slot.title = `place something at rank ${r}, t=${sim.frontier[r]}`;
      slot.onclick = ev => { ev.stopPropagation(); openPopover(r, slot); };
      lane.appendChild(slot);
    }
    lane.onclick = () => { closePopover(); state.selectedRank = r; renderAll(); };
    row.appendChild(lane);
    grid.appendChild(row);
    grid.appendChild(renderMemStrip(sim, r, horizon));
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

// Rewind: truncate history to just before the action that placed `opId`.
function rewindTo(opId) {
  const acts = state.sim.actions;
  const i = acts.findIndex(a => a.type === 'op' && a.id === opId);
  if (i < 0) return;
  const removed = acts.slice(i);
  state.redo = removed.slice().reverse().concat(state.redo);
  state.sim = E.replay(state.level.cfg, acts.slice(0, i));
  hideBanner();
  setStatus(`Rewound ${removed.length} placement(s) — redo restores them in order.`);
  autoAdvanceSelection();
  saveHash(); renderAll();
}

function renderItem(item, sim, isGhost = false) {
  const el = document.createElement('div');
  el.style.left = (item.start * CELL + 1) + 'px';
  el.style.width = (item.dur * CELL - 4) + 'px';
  if (!item.id) { el.className = 'op idle'; el.title = 'idle (bubble)'; return el; }
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
  document.querySelectorAll('#grid .op').forEach(el =>
    el.classList.remove('dep-up', 'dep-down', 'dim'));
}

// Build op buttons for a rank into `box`. Used by both the picker panel and
// the click-a-slot popover.
function buildOpButtons(box, r) {
  const sim = state.sim;
  const t = sim.frontier[r];
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
    const lbl = document.createElement('span');
    lbl.className = 'kindlabel';
    lbl.textContent = {
      F: 'forward',
      B: sim.cfg.model === 'zb' ? 'backward (input grad)' : 'backward',
      W: 'weight grad',
    }[kind];
    group.appendChild(lbl);
    for (const op of pending.filter(o => o.kind === kind)
                            .sort((a, b) => a.mb - b.mb || a.stage - b.stage)) {
      const ready = !E.blockReason(sim, op, t);
      const btn = document.createElement('button');
      btn.className = 'opbtn' + (state.assist !== 'none' && !ready ? ' notready' : '');
      btn.dataset.opid = op.id;
      const st = cellStyle(state.theme, state.mode, op, sim.cfg);
      btn.style.background = st.bg; btn.style.borderColor = st.border; btn.style.color = st.ink;
      btn.innerHTML = `<span class="stg">${op.stage}</span>${op.kind}${op.mb}`;
      btn.title = opTitle(op, sim);
      btn.onclick = () => { closePopover(); tryAction({ rank: r, type: 'op', id: op.id }); };
      btn.onmouseenter = () => previewConsequence(op, ready, r);
      btn.onmouseleave = () => { $('hint').textContent = ''; state.hoverGhost = null; renderGrid(); };
      group.appendChild(btn);
    }
    box.appendChild(group);
  }
  const wgroup = document.createElement('div');
  wgroup.className = 'kindgroup';
  const wlbl = document.createElement('span');
  wlbl.className = 'kindlabel';
  wlbl.textContent = 'wait';
  wgroup.appendChild(wlbl);
  const idle = document.createElement('button');
  idle.className = 'opbtn';
  idle.textContent = '⏸ idle';
  idle.title = 'Leave this slot empty. Sometimes waiting is the right move!';
  idle.onclick = () => { closePopover(); tryAction({ rank: r, type: 'idle' }); };
  wgroup.appendChild(idle);
  box.appendChild(wgroup);
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

function openPopover(r, anchorEl) {
  state.selectedRank = r;
  renderAll();          // rebuilds grid; anchor is recreated, so find it again
  const pop = $('popover');
  const anchor = document.querySelector(`#grid .slot[data-rank="${r}"]`);
  if (!anchor) return;
  buildOpButtons(pop, r);
  pop.style.display = '';
  const wrap = $('gridwrap').getBoundingClientRect();
  const a = anchor.getBoundingClientRect();
  pop.style.left = Math.max(0, a.left - wrap.left + $('gridwrap').scrollLeft) + 'px';
  pop.style.top = (a.bottom - wrap.top + 6) + 'px';
}

function closePopover() {
  $('popover').style.display = 'none';
}

// Hint: pulse the coach's pick in the picker/popover without placing it.
function showHint() {
  const pick = E.policyPick(state.sim, state.selectedRank, state.level.policy);
  if (!pick) { setStatus('This rank is finished — pick another rank.'); return; }
  if (pick.tie) {
    setStatus('⚖️ Genuine tie — several moves are equally standard here. Your call.');
    return;
  }
  if (pick.action.type === 'idle') {
    setStatus('Hint: nothing is ready on this rank — place an idle.');
    return;
  }
  const op = state.sim.byId.get(pick.action.id);
  setStatus(`Hint: run ${E.label(op)} (${E.POLICIES[state.level.policy].name}).`);
  document.querySelectorAll(`.opbtn[data-opid="${CSS.escape(op.id)}"]`).forEach(el => {
    el.classList.remove('pulse'); void el.offsetWidth; el.classList.add('pulse');
  });
}

function previewConsequence(op, ready, r = state.selectedRank) {
  const sim = state.sim;
  if (!ready) {
    const block = E.blockReason(sim, op, sim.frontier[r]);
    $('hint').textContent = `${E.label(op)}: ${block.msg}`;
    if (block.dep) highlightDep(block.dep);
    return;
  }
  if (state.assist === 'none') return;
  try {
    const base = E.replay(sim.cfg, sim.actions);
    E.project(base, state.level.policy);
    const withOp = E.replay(sim.cfg, [...sim.actions, { rank: r, type: 'op', id: op.id }]);
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
  const rows = [];
  for (let r = 0; r < sim.cfg.P; r++) {
    const busy = sim.rows[r].filter(i => i.id).reduce((a, i) => a + i.dur, 0);
    const t = sim.frontier[r];
    rows.push(`<tr><td>rank ${r}</td><td>${t}</td>` +
      `<td>${t ? pct(busy / t) : '—'}</td>` +
      `<td>${sim.peak[r]}${sim.cfg.cap != null ? '/' + sim.cfg.cap : ''}</td></tr>`);
  }
  const done = E.isDone(sim);
  const parM = state.ref.score.makespan;
  $('stats').innerHTML =
    `<table class="stats">
      <tr><th>rank</th><th>t</th><th>util</th><th>peak mem</th></tr>
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
    </table>`;
}

// show/hide progressive UI, populate level select with locks
function renderChrome() {
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
    o.textContent = levelPlayable(i) ? l.name : `🔒 ${l.name}`;
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
}

// --- banner / status -------------------------------------------------------------

function showBanner(won, s) {
  const b = $('banner');
  const idx = levelIndex(state.level.key);
  const next = idx >= 0 ? LEVELS[idx + 1] : null;
  b.className = won ? 'banner won' : 'banner missed';
  b.style.display = '';
  const parM = state.ref.score.makespan;
  let msg;
  if (won) {
    msg = `🎉 <b>Level cleared!</b> Makespan ${s.makespan}` +
      (state.level.goal === 'internal0' ? `, internal bubble ${pct(s.internalBubble)}` :
       s.makespan <= parM ? ` — matched par` : '');
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
    h += `&cfg=${c.P}.${c.V}.${c.M}.${c.model}.${c.cap ?? 'x'}.${c.warmup ?? 'std'}`;
  }
  if (acts) h += '&a=' + acts;
  history.replaceState(null, '', '#' + h);
}

function loadHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  let level;
  if (p.get('level') === 'custom' && p.get('cfg')) {
    const [P, V, M, model, cap, warmup] = p.get('cfg').split('.');
    level = customLevel({ P: +P, V: +V, M: +M, model,
      cap: cap === 'x' ? null : +cap, ...(warmup === 'zb2' ? { warmup: 'zb2' } : {}) });
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
  document.addEventListener('click', e => {
    if (!$('popover').contains(e.target) && !e.target.classList?.contains('slot'))
      closePopover();
  });

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
  $('nextlevel').onclick = () => {
    const next = LEVELS[levelIndex(state.level.key) + 1];
    if (next) { hideBanner(); loadLevel(next); }
  };
  $('retrybtn').onclick = () => { hideBanner(); loadLevel(state.level); };

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
