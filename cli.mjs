#!/usr/bin/env node
// Text interface to the tutor engine — same rules as the web app.
// Usage:
//   node cli.mjs <level-key>                 show board
//   node cli.mjs <level-key> "0F0 0F1 ..."   apply moves left to right
// Move syntax: <rank><kind><mb>  e.g. 2B5;  <rank>.  = idle;  <rank>F3c1 = VPP chunk 1.
// Or: node cli.mjs <level-key> --project / --auto  to run the policy.

import * as E from './js/engine.js';
import { LEVELS, levelByKey } from './js/levels.js';

const [, , key = '1f1b', ...rest] = process.argv;
if (key === '--list') {
  for (const l of LEVELS) console.log(`${l.key.padEnd(14)} ${l.name}`);
  process.exit(0);
}
const level = levelByKey(key);
const cfg = level.cfg;
const sim = E.newState(cfg);

function parseMove(tok) {
  let m;
  if ((m = tok.match(/^(\d+)\.$/))) return { rank: +m[1], type: 'idle' };
  if ((m = tok.match(/^(\d+)([FBW])(\d+)(?:c(\d+))?$/i))) {
    const rank = +m[1], kind = m[2].toUpperCase(), mb = +m[3], chunk = +(m[4] ?? 0);
    return { rank, type: 'op', id: E.opId(kind, chunk * cfg.P + rank, mb) };
  }
  throw new Error(`can't parse move "${tok}" (want e.g. 0F0, 2B5, 1., 0F3c1)`);
}

const moves = rest.filter(t => !t.startsWith('--')).flatMap(t => t.split(/\s+/)).filter(Boolean);
let err = null;
for (const tok of moves) {
  try { E.apply(sim, parseMove(tok)); }
  catch (e) { err = `move "${tok}": ${e.message}`; break; }
}
if (!err && rest.includes('--auto')) {
  const res = E.autoRun(sim, level.policy, new Set());
  console.log(`[auto stopped: ${res.stopped}${res.events[0] ? ' — ' + res.events[res.events.length-1].msg : ''}]`);
}
if (!err && rest.includes('--project')) E.project(sim, level.policy);

// --- render board ---
const width = Math.max(...sim.frontier, 1);
const cw = cfg.model === 'zb' || cfg.M > 9 ? 4 : 3;
let axis = ' '.repeat(8);
for (let t = 0; t < width; t++) axis += String(t % 2 === 0 ? t : '').padEnd(cw);
console.log(`${level.name}  (P=${cfg.P} V=${cfg.V} M=${cfg.M} model=${cfg.model} cap=${cfg.cap ?? '∞'})`);
console.log(axis);
for (let r = 0; r < cfg.P; r++) {
  let line = `rank ${r} |`;
  for (const it of sim.rows[r]) {
    if (!it.id) { line += '·'.padEnd(cw * it.dur); continue; }
    const op = sim.byId.get(it.id);
    const chunk = Math.floor(op.stage / cfg.P);
    const cell = `${op.kind}${op.mb}${cfg.V > 1 ? "'".repeat(chunk) : ''}`;
    line += cell.padEnd(cw * it.dur);
  }
  console.log(line + `| t=${sim.frontier[r]} mem=${sim.inflight[r]}${cfg.cap != null ? '/' + cfg.cap : ''} [${E.phase(sim, r)}]`);
}

if (err) { console.log(`\n❌ ${err}`); process.exit(1); }

// ready sets
console.log('\nready:');
for (let r = 0; r < cfg.P; r++) {
  const ready = E.readySet(sim, r).map(o =>
    `${o.kind}${o.mb}${cfg.V > 1 ? '(c' + Math.floor(o.stage / cfg.P) + ')' : ''}`);
  const pick = E.policyPick(sim, r, level.policy);
  const coach = pick?.action.type === 'op'
    ? ` coach→${E.label(sim.byId.get(pick.action.id))}${pick.tie ? ' (tie!)' : ''}` : '';
  console.log(`  rank ${r} @t=${sim.frontier[r]}: ${ready.join(' ') || '(nothing — idle)'}${coach}`);
}
const s = E.score(sim);
if (E.isDone(sim)) {
  const ref = E.referenceSchedule(cfg);
  console.log(`\n✅ DONE  makespan=${s.makespan} (par ${ref.score.makespan})  bubble=${(100*s.bubble).toFixed(1)}%  internal=${(100*s.internalBubble).toFixed(1)}% (par ${(100*ref.score.internalBubble).toFixed(1)}%)  peak=${s.peak.join('/')}`);
} else {
  console.log(`\nplaced ${sim.placed.size}/${sim.ops.length}  makespan-so-far=${s.makespan}`);
}
