import * as E from './engine.js';
import { LEVELS, levelByKey } from './levels.js';
import { THEMES, cellStyle } from './palettes.js';

const $ = id => document.getElementById(id);
const CELL = 34, CELLH = 40;

const state = {
  level: LEVELS[0],
  sim: null,
  ref: null,               // reference schedule for par
  selectedRank: 0,
  assist: 'ready',         // 'none' | 'ready' | 'coach'
  theme: 'microbatch',
  mode: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
  redo: [],
  seenEvents: new Set(),
  hoverGhost: null,        // projected placements to render as ghosts
};

// --- setup -------------------------------------------------------------------

function loadLevel(level, actions = []) {
  state.level = level;
  state.sim = E.replay(level.cfg, actions);
  state.ref = E.referenceSchedule(level.cfg);
  state.redo = [];
  state.seenEvents = new Set();
  state.selectedRank = 0;
  state.hoverGhost = null;
  $('blurb').textContent = level.blurb;
  logClear();
  log(`Level loaded: ${level.name}. Par: makespan ${state.ref.score.makespan}, ` +
      `bubble ${pct(state.ref.score.bubble)}.`);
  saveHash();
  renderAll();
}

function pct(x) { return (100 * x).toFixed(1) + '%'; }

// --- actions -------------------------------------------------------------------

function tryAction(action, { silent = false } = {}) {
  try {
    E.apply(state.sim, action);
    state.redo = [];
    afterChange(action, silent);
    return true;
  } catch (err) {
    flashToast(`❌ ${err.message}`);
    if (err.reason?.dep) highlightDep(err.reason.dep);
    log(err.message, 'err');
    return false;
  }
}

function afterChange(action, silent) {
  const sim = state.sim;
  if (action?.type === 'op' && !silent) {
    const op = sim.byId.get(action.id);
    const ph = E.phase(sim, action.rank);
    // phase-transition callouts
    if (op.kind === 'B' && sim.rows[action.rank].filter(
        it => it.id && sim.byId.get(it.id).kind === 'B').length === 1) {
      log(`Rank ${action.rank}: first backward — warmup is over here.`, 'event');
    }
    if (ph === 'drain' && op.kind === 'F') {
      log(`Rank ${action.rank}: last forward placed — draining.`, 'event');
    }
  }
  if (E.isDone(sim)) {
    const s = E.score(sim);
    const beat = s.makespan <= state.ref.score.makespan;
    flashToast(beat
      ? `🎉 Complete! Makespan ${s.makespan} — you matched par (${state.ref.score.makespan}).`
      : `✅ Complete. Makespan ${s.makespan} vs par ${state.ref.score.makespan} — ` +
        `find ${s.makespan - state.ref.score.makespan} slots of bubble to squeeze out.`);
    log(`Schedule complete: makespan ${s.makespan}, bubble ${pct(s.bubble)}, ` +
        `peak memory ${s.peak.join('/')}.`, 'event');
  }
  saveHash();
  renderAll();
}

function undo() {
  const acts = state.sim.actions;
  if (!acts.length) return;
  state.redo.push(acts[acts.length - 1]);
  state.sim = E.replay(state.level.cfg, acts.slice(0, -1));
  saveHash(); renderAll();
}

function redo() {
  const a = state.redo.pop();
  if (a) { E.apply(state.sim, a); saveHash(); renderAll(); }
}

function autoStep() {
  const pick = E.policyPick(state.sim, state.selectedRank, state.level.policy);
  if (!pick) { flashToast('This rank is finished.'); return; }
  if (pick.tie) {
    flashToast('⚖️ Genuine tie — the policy has no preference here. Your call.');
    return;
  }
  tryAction(pick.action);
}

function autoRunUntilStrange() {
  const res = E.autoRun(state.sim, state.level.policy, state.seenEvents);
  state.redo = [];
  if (res.stopped === 'event') {
    flashToast(`⏸ Paused: ${res.event.msg}` +
      (res.event.kind === 'tie' ? ` — choices: ${res.event.choices.join(', ')}` : ''));
    log(res.event.msg, 'event');
  } else if (res.stopped === 'done') {
    afterChange(null, true); return;
  } else if (res.stopped === 'deadlock') {
    flashToast('💀 Deadlock: nothing is ready anywhere and nothing is running. Undo and rethink.');
  }
  for (const e of res.events) if (e.kind !== 'tie') log(e.msg);
  saveHash(); renderAll();
}

function projectRest() {
  const res = E.project(state.sim, state.level.policy);
  state.redo = [];
  if (res.deadlock) flashToast('💀 Projection hit a deadlock — your prefix cannot be completed by this policy.');
  else afterChange(null, true);
  saveHash(); renderAll();
}

// --- rendering ------------------------------------------------------------------

function renderAll() { renderGrid(); renderPicker(); renderStats(); renderButtons(); }

function opTitle(op, sim) {
  const deps = E.depsOf(sim.cfg, op).map(d => {
    const dop = sim.byId.get(d);
    const p = sim.placed.get(d);
    return `${E.label(dop)}${p ? ` (done t=${p.end})` : ' (unscheduled)'}`;
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
    head.innerHTML = `<span class="rname">rank ${r} <span class="phase ${ph}">${ph}</span></span>` +
      `<span class="rmeta">stages ${stages} · mem ${sim.inflight[r]}${cfg.cap != null ? '/' + cfg.cap : ''}</span>`;
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
    const fr = document.createElement('div');
    fr.className = 'frontier';
    fr.style.left = (sim.frontier[r] * CELL) + 'px';
    lane.appendChild(fr);
    lane.onclick = () => { state.selectedRank = r; renderAll(); };
    row.appendChild(lane);
    grid.appendChild(row);
  }
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
  el.textContent = sim.cfg.V > 1 ? `${op.kind}${op.mb}·${Math.floor(op.stage / sim.cfg.P)}`
                                 : `${op.kind}${op.mb}`;
  el.title = opTitle(op, sim);
  if (!isGhost) {
    el.onmouseenter = () => traceDeps(op);
    el.onmouseleave = () => clearTrace();
  }
  return el;
}

// hover: outline upstream deps (red) and unblocked downstream ops (green)
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

function renderPicker() {
  const sim = state.sim;
  const r = state.selectedRank;
  const box = $('picker');
  box.innerHTML = '';
  const t = sim.frontier[r];
  $('pickerTitle').textContent =
    `Place at rank ${r}, t=${t} (${E.phase(sim, r)})`;

  const pending = E.pendingOps(sim, r);
  if (!pending.length) {
    box.innerHTML = '<span class="hint">Rank finished ✓</span>';
    return;
  }
  const kinds = [...new Set(pending.map(o => o.kind))];
  for (const kind of kinds) {
    const group = document.createElement('div');
    group.className = 'kindgroup';
    const lbl = document.createElement('span');
    lbl.className = 'kindlabel';
    lbl.textContent = { F: 'forward', B: kind === 'B' && sim.cfg.model === 'zb' ? 'backward (input grad)' : 'backward', W: 'weight grad' }[kind];
    group.appendChild(lbl);
    for (const op of pending.filter(o => o.kind === kind)
                            .sort((a, b) => a.mb - b.mb || a.stage - b.stage)) {
      const ready = !E.blockReason(sim, op, t);
      if (state.assist !== 'none' && !ready && state.assist === 'ready') {
        // show but dimmed
      }
      const btn = document.createElement('button');
      btn.className = 'opbtn' + (state.assist !== 'none' && !ready ? ' notready' : '');
      const st = cellStyle(state.theme, state.mode, op, sim.cfg);
      btn.style.background = st.bg; btn.style.borderColor = st.border; btn.style.color = st.ink;
      btn.textContent = sim.cfg.V > 1
        ? `${op.kind}${op.mb}·c${Math.floor(op.stage / sim.cfg.P)}` : `${op.kind}${op.mb}`;
      btn.title = opTitle(op, sim);
      btn.onclick = () => tryAction({ rank: r, type: 'op', id: op.id });
      btn.onmouseenter = () => previewConsequence(op, ready);
      btn.onmouseleave = () => { $('hint').textContent = ''; state.hoverGhost = null; renderGrid(); };
      group.appendChild(btn);
    }
    box.appendChild(group);
  }
  const idle = document.createElement('button');
  idle.className = 'opbtn';
  idle.textContent = '⏸ idle';
  idle.title = 'Leave this slot empty. Sometimes waiting is the right move!';
  idle.onclick = () => tryAction({ rank: r, type: 'idle' });
  box.appendChild(idle);

  if (state.assist === 'coach') {
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

// On hover in the picker: if not ready, say why; if ready, ghost-project the
// rest of the schedule after hypothetically taking it, and report the cost.
function previewConsequence(op, ready) {
  const sim = state.sim;
  const r = state.selectedRank;
  if (!ready) {
    const block = E.blockReason(sim, op, sim.frontier[r]);
    $('hint').textContent = `${E.label(op)}: ${block.msg}`;
    if (block.dep) highlightDep(block.dep);
    return;
  }
  if (state.assist === 'none') return;
  // hypothetical: apply, project, diff makespan vs projecting without it
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

function renderButtons() {
  $('undo').disabled = !state.sim.actions.length;
  $('redo').disabled = !state.redo.length;
  const done = E.isDone(state.sim);
  $('autostep').disabled = done;
  $('autorun').disabled = done;
  $('projectbtn').disabled = done;
}

// --- misc UI -------------------------------------------------------------------

let toastTimer = null;
function flashToast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 4200);
}

function log(msg, cls = '') {
  const div = document.createElement('div');
  div.className = 'entry ' + cls;
  div.textContent = msg;
  $('log').prepend(div);
}
function logClear() { $('log').innerHTML = ''; }

// --- URL state -------------------------------------------------------------------
// #level=<key>&a=<compact actions>   op: r:id, idle: r:.

function saveHash() {
  const acts = state.sim.actions.map(a =>
    a.type === 'idle' ? `${a.rank}:.` : `${a.rank}:${a.id}`).join(',');
  const h = `level=${state.level.key}${acts ? '&a=' + acts : ''}`;
  history.replaceState(null, '', '#' + h);
}

function loadHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const level = levelByKey(p.get('level') || LEVELS[0].key);
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

  const lsel = $('levelsel');
  for (const l of LEVELS) {
    const o = document.createElement('option');
    o.value = l.key; o.textContent = l.name;
    lsel.appendChild(o);
  }
  lsel.onchange = () => loadLevel(levelByKey(lsel.value));

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

  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT') return;
    if ((e.metaKey || e.ctrlKey) && e.key === 'z') { e.shiftKey ? redo() : undo(); e.preventDefault(); }
    else if (e.key === 'ArrowDown') { state.selectedRank = Math.min(state.level.cfg.P - 1, state.selectedRank + 1); renderAll(); }
    else if (e.key === 'ArrowUp') { state.selectedRank = Math.max(0, state.selectedRank - 1); renderAll(); }
    else if (e.key === ' ') { autoStep(); e.preventDefault(); }
    else if (e.key === 'i') { tryAction({ rank: state.selectedRank, type: 'idle' }); }
  });

  loadHash();
  lsel.value = state.level.key;
}

init();
