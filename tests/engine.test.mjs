import { test } from 'node:test';
import assert from 'node:assert';
import * as E from '../js/engine.js';

test('1F1B P=4 M=8 uniform: makespan 22, bubble 3/11, peak = stages-left', () => {
  const cfg = { P: 4, V: 1, M: 8, model: '11', cap: 4 };
  const { done, score } = E.referenceSchedule(cfg);
  assert.ok(done);
  assert.strictEqual(score.makespan, 22);
  assert.ok(Math.abs(score.bubble - 3 / 11) < 1e-9);
  assert.deepStrictEqual(score.peak, [4, 3, 2, 1]);
});

test('GPipe P=4 M=8 uniform: same makespan, peak = M on every rank', () => {
  const cfg = { P: 4, V: 1, M: 8, model: '11', cap: null };
  const { done, score } = E.referenceSchedule(cfg);
  assert.ok(done);
  assert.strictEqual(score.makespan, 22);
  assert.deepStrictEqual(score.peak, [8, 8, 8, 8]);
});

test('GPipe under a cap of P deadlock-free (degrades, still completes)', () => {
  const cfg = { P: 4, V: 1, M: 8, model: '11', cap: 4 };
  const s = E.newState(cfg);
  const { done } = E.project(s, 'gpipe');
  assert.ok(done);
});

test('1:2 model (B=2F) 1F1B completes; makespan = 3M + 3(P-1) = 33', () => {
  const cfg = { P: 4, V: 1, M: 8, model: '12', cap: 4 };
  const { done, score } = E.referenceSchedule(cfg);
  assert.ok(done);
  assert.strictEqual(score.makespan, 33);
});

test('interleaved P=4 V=2 M=8 completes under 1F1B policy with cap', () => {
  const cfg = { P: 4, V: 2, M: 8, model: '11', cap: 8 };
  const { done, score } = E.referenceSchedule(cfg);
  assert.ok(done);
  assert.strictEqual(score.work, 2 * 8 * 8); // 2 chunks/rank * 8 mb * 2 ops... = F+B per (stage,mb)
});

test('zero-bubble model: W ops exist, deps B->W, completes', () => {
  const cfg = { P: 4, V: 1, M: 8, model: 'zb', cap: 4 };
  const { done, score } = E.referenceSchedule(cfg);
  assert.ok(done);
  // 3 ops per (stage, mb): 4*8*3 = 96 unit slots of work
  assert.strictEqual(score.work, 96);
});

test('illegal: forward before upstream forward', () => {
  const cfg = { P: 2, V: 1, M: 2, model: '11', cap: null };
  const s = E.newState(cfg);
  assert.throws(() => E.apply(s, { rank: 1, type: 'op', id: E.opId('F', 1, 0) }),
    /hasn't been scheduled/);
});

test('illegal: dep finishes too late (comm-free adjacency)', () => {
  const cfg = { P: 2, V: 1, M: 2, model: '11', cap: null };
  const s = E.newState(cfg);
  E.apply(s, { rank: 0, type: 'op', id: E.opId('F', 0, 0) }); // ends t=1
  // rank 1 at frontier t=0 can't run F1_0 (ready at t=1)
  assert.throws(() => E.apply(s, { rank: 1, type: 'op', id: E.opId('F', 1, 0) }),
    /finishes at t=1/);
  E.apply(s, { rank: 1, type: 'idle' });
  E.apply(s, { rank: 1, type: 'op', id: E.opId('F', 1, 0) }); // now legal
});

test('memory cap blocks forwards', () => {
  const cfg = { P: 1, V: 1, M: 3, model: '11', cap: 2 };
  const s = E.newState(cfg);
  E.apply(s, { rank: 0, type: 'op', id: E.opId('F', 0, 0) });
  E.apply(s, { rank: 0, type: 'op', id: E.opId('F', 0, 1) });
  assert.throws(() => E.apply(s, { rank: 0, type: 'op', id: E.opId('F', 0, 2) }),
    /memory cap/);
  E.apply(s, { rank: 0, type: 'op', id: E.opId('B', 0, 1) });
  E.apply(s, { rank: 0, type: 'op', id: E.opId('F', 0, 2) }); // legal again
});

test('readySet respects rank ownership and frontier', () => {
  const cfg = { P: 2, V: 2, M: 2, model: '11', cap: null };
  const s = E.newState(cfg);
  // rank 0 hosts stages 0,2; rank 1 hosts 1,3
  const r0 = E.readySet(s, 0).map(o => o.id);
  assert.deepStrictEqual(r0.sort(), ['F0_0', 'F0_1']);
  assert.deepStrictEqual(E.readySet(s, 1), []);
});

test('autoRun stops on first backward (end of warmup)', () => {
  const cfg = { P: 4, V: 1, M: 8, model: '11', cap: 4 };
  const s = E.newState(cfg);
  const seen = new Set();
  const res = E.autoRun(s, '1f1b', seen);
  assert.strictEqual(res.stopped, 'event');
});

test('replay reproduces state (undo support)', () => {
  const cfg = { P: 2, V: 1, M: 4, model: '11', cap: 2 };
  const s = E.newState(cfg);
  E.project(s, '1f1b');
  const s2 = E.replay(cfg, s.actions.slice(0, 5));
  assert.strictEqual(s2.actions.length, 5);
  const s3 = E.replay(cfg, s.actions);
  assert.deepStrictEqual(E.score(s3), E.score(s));
});

test('planViolations: catches overlap, dep-late, dep-missing, memory', () => {
  const cfg = { P: 2, V: 1, M: 2, model: '11', cap: 1 };
  const plan = new Map([
    ['F0_0', 0], ['F0_1', 0],          // overlap on rank 0
    ['F1_0', 0],                        // dep-late: needs F0_0 to end (t=1)
    ['B1_0', 2],                        // ok given F1_0 hypothetically
    ['B0_0', 5],                        // dep ok (B1_0 ends 3)
  ]);
  const v = E.planViolations(cfg, plan);
  const codes = v.map(x => x.code).sort();
  assert.ok(codes.includes('overlap'));
  assert.ok(codes.includes('dep-late'));
  // overlap suppresses the memory check; fix overlap and check memory
  const plan2 = new Map([['F0_0', 0], ['F0_1', 1], ['F1_0', 1], ['B1_0', 2], ['B0_0', 3]]);
  const v2 = E.planViolations(cfg, plan2);
  assert.ok(v2.some(x => x.code === 'memory'));
  // dep-missing: backward placed but its upstream backward isn't
  const plan3 = new Map([['F0_0', 0], ['F1_0', 1], ['B0_0', 3]]);
  const v3 = E.planViolations(cfg, plan3);
  assert.ok(v3.some(x => x.code === 'dep-missing' && x.dep === 'B1_0'));
});

test('planToActions round-trips a valid complete schedule', () => {
  const cfg = { P: 2, V: 1, M: 4, model: '11', cap: 2 };
  const ref = E.referenceSchedule(cfg);
  const plan = new Map([...ref.state.placed.entries()].map(([id, p]) => [id, p.start]));
  assert.strictEqual(E.planViolations(cfg, plan).length, 0);
  const actions = E.planToActions(cfg, plan);
  const sim = E.replay(cfg, actions);
  assert.ok(E.isDone(sim));
  assert.deepStrictEqual(E.score(sim).makespan, ref.score.makespan);
});

test('planCompletion: speculative op with fillable deps is feasible; forced slots found', () => {
  const cfg = { P: 2, V: 1, M: 2, model: '11', cap: null };
  // place only F1_0 at t=1 (its dep F0_0 unplaced but fits at t=0 — uniquely)
  const plan = new Map([['F1_0', 1]]);
  const res = E.planCompletion(cfg, plan);
  assert.ok(res.feasible);
  assert.ok(res.required.has('F0_0'));
  assert.strictEqual(res.forced.get('F0_0'), 0); // only slot that works
});

test('planCompletion: infeasible when no room for deps', () => {
  const cfg = { P: 2, V: 1, M: 2, model: '11', cap: null };
  // F1_0 at t=0: its dep F0_0 must END by t=0 — impossible
  const plan = new Map([['F1_0', 0]]);
  const res = E.planCompletion(cfg, plan);
  assert.strictEqual(res.feasible, false);
});

test('recognizeSchedule: identifies 1F1B, GPipe, ZB-H1, and novel', () => {
  const c1 = { P: 4, V: 1, M: 8, model: '11', cap: 4 };
  const s1 = E.newState(c1); E.project(s1, '1f1b');
  assert.strictEqual(E.recognizeSchedule(s1).name, '1F1B');

  const c2 = { P: 4, V: 1, M: 8, model: '11', cap: null };
  const s2 = E.newState(c2); E.project(s2, 'gpipe');
  assert.strictEqual(E.recognizeSchedule(s2).name, 'GPipe');

  const c3 = { P: 4, V: 1, M: 8, model: 'zb', cap: 4 };
  const s3 = E.newState(c3); E.project(s3, 'zb');
  assert.strictEqual(E.recognizeSchedule(s3).name, 'ZB-H1');

  const c4 = { P: 4, V: 1, M: 8, model: 'zb', cap: 8, warmup: 'zb2' };
  const s4 = E.newState(c4); E.project(s4, 'zb');
  assert.strictEqual(E.recognizeSchedule(s4).name, 'ZB-H2');

  // novel: 1F1B config but scramble drain order (swap last two W... no W here;
  // use a GPipe-ish order under the cap — differs from both references)
  const s5 = E.newState(c1);
  E.project(s5, 'gpipe'); // gpipe under cap=4 degrades: not GPipe-canonical, not 1F1B
  const r5 = E.recognizeSchedule(s5);
  // whatever it is, the call must not crash and must return an object
  assert.ok(r5 !== null);
});

test('criticalPath: walks back through gaters; clean 1F1B has no breaks', () => {
  const cfg = { P: 4, V: 1, M: 8, model: '11', cap: 4 };
  const s = E.newState(cfg); E.project(s, '1f1b');
  const { ids, breaks } = E.criticalPath(s);
  assert.ok(ids.length >= 8);
  assert.strictEqual(breaks.length, 0);
  // path ends at the very last op
  const last = ids[ids.length - 1];
  assert.strictEqual(s.placed.get(last).end, E.score(s).makespan);
});

test('explainIdle: names the blocking dep for a forced bubble', () => {
  const cfg = { P: 2, V: 1, M: 4, model: '11', cap: null };
  const s = E.newState(cfg); E.project(s, 'gpipe');
  // rank 0 idles at t=4..6 waiting for B1_0 etc.
  const idle = s.rows[0].find(it => !it.id);
  assert.ok(idle);
  const ex = E.explainIdle(s, 0, idle.start);
  assert.strictEqual(ex.reason, 'dep');
  assert.match(ex.msg, /waiting for/);
});

test('gaterOf: voluntary delay detected', () => {
  const cfg = { P: 1, V: 1, M: 2, model: '11', cap: null };
  const s = E.newState(cfg);
  E.apply(s, { rank: 0, type: 'op', id: 'F0_0' });
  E.apply(s, { rank: 0, type: 'idle' });
  E.apply(s, { rank: 0, type: 'op', id: 'F0_1' }); // could have run at t=1
  const g = E.gaterOf(s, 'F0_1');
  assert.strictEqual(g.kind, 'delayed');
});

test('building block: 1F1B block stamps to the full 1F1B schedule', () => {
  const cfg = { P: 4, V: 1, M: 8, model: '11', cap: 4 };
  // hand-build microbatch 0's 1F1B trajectory: F at t=r, B at t=2P-... :
  // canonical 1F1B block: F_r at t=r, B on rank r at t = 2P-2-r + P... derive
  // from the reference schedule instead.
  const ref = E.referenceSchedule(cfg).state;
  const s = E.newState(cfg);
  // place ONLY microbatch 0's ops at their reference times, via idles
  const acts = [];
  for (let r = 0; r < cfg.P; r++) {
    const items = ref.rows[r].filter(it => it.id && ref.byId.get(it.id).mb === 0);
    let t = 0;
    for (const it of items.sort((a, b) => a.start - b.start)) {
      for (; t < it.start; t++) acts.push({ start: t, a: { rank: r, type: 'idle' } });
      acts.push({ start: it.start, a: { rank: r, type: 'op', id: it.id } });
      t = it.start + it.dur;
    }
  }
  acts.sort((x, y) => x.start - y.start || x.a.rank - y.a.rank);
  for (const { a } of acts) E.apply(s, a);
  assert.strictEqual(E.soleMicrobatch(s), 0);
  const bs = E.blockStats(s, 0);
  assert.deepStrictEqual(bs.peak, [4, 3, 2, 1]);  // 1F1B's memory profile
  const res = E.stampBlock(s, 0);
  assert.ok(res.actions, JSON.stringify(res.violations));
  const full = E.replay(cfg, res.actions);
  assert.ok(E.isDone(full));
  assert.strictEqual(E.score(full).makespan, 22);
  assert.strictEqual(E.recognizeSchedule(full).name, '1F1B');
});

test('building block: too-eager block violates the cap when stamped', () => {
  const cfg = { P: 2, V: 1, M: 4, model: '11', cap: 1 };
  const s = E.newState(cfg);
  // GPipe-style block: F0 t=0, B0 needs long lifespan on rank 0
  E.apply(s, { rank: 0, type: 'op', id: 'F0_0' });
  E.apply(s, { rank: 1, type: 'idle' });
  E.apply(s, { rank: 1, type: 'op', id: 'F1_0' });
  E.apply(s, { rank: 1, type: 'op', id: 'B1_0' });
  E.apply(s, { rank: 0, type: 'idle' }); E.apply(s, { rank: 0, type: 'idle' });
  E.apply(s, { rank: 0, type: 'op', id: 'B0_0' });  // lifespan 4 on rank 0
  const res = E.stampBlock(s, 0);
  assert.ok(res.violations?.some(v => v.msg.includes('memory') || v.code === 'memory'));
});

test('V placement: chunks bounce off ends; depth-first reference beats wrap', () => {
  const v = { P: 4, V: 2, M: 8, model: '11', cap: 8 };          // 'v' by default
  const wrap = { ...v, place: 'wrap' };
  assert.deepStrictEqual([0,1,2,3].map(r => E.rankStages(v, r).join(',')),
    ['0,7', '1,6', '2,5', '3,4']);
  assert.deepStrictEqual([0,1,2,3].map(r => E.rankStages(wrap, r).join(',')),
    ['0,4', '1,5', '2,6', '3,7']);
  const rv = E.referenceSchedule(v);
  const rw = E.referenceSchedule(wrap);
  assert.ok(rv.done && rw.done);
  assert.ok(rv.score.makespan < rw.score.makespan,
    `v ${rv.score.makespan} should beat wrap ${rw.score.makespan}`);
  // V=1 unaffected by the default
  const flat = E.referenceSchedule({ P: 4, V: 1, M: 8, model: '11', cap: 4 });
  assert.strictEqual(flat.score.makespan, 22);
});

test('squeezeBlock repairs a depth-first V-placement block into a tiling one', () => {
  const cfg = { P: 4, V: 2, M: 8, model: '11', cap: 8 };
  const acts = [];
  const frontier = [0, 0, 0, 0];
  let t = 0;
  const chain = [];
  for (let s = 0; s < 8; s++) chain.push(['F', s]);
  for (let s = 7; s >= 0; s--) chain.push(['B', s]);
  for (const [k, s] of chain) {
    const r = E.stageRank(cfg, s);
    while (frontier[r] < t) { acts.push({ rank: r, type: 'idle' }); frontier[r]++; }
    acts.push({ rank: r, type: 'op', id: E.opId(k, s, 0) });
    frontier[r]++; t++;
  }
  const sim = E.replay(cfg, acts);
  assert.ok(E.stampBlock(sim, 0).violations);      // raw block overlaps
  const sq = E.squeezeBlock(sim, 0);
  assert.ok(sq);
  const sim2 = E.replay(cfg, E.planToActions(cfg, sq));
  const res = E.stampBlock(sim2, 0);
  assert.ok(res.actions);
  const full = E.replay(cfg, res.actions);
  assert.ok(E.isDone(full));
});

test('stampNextMicrobatch: clean tile for 1F1B block, shoves for tight V block', () => {
  // 1F1B block: stamp strand by strand, no shoves, ends at makespan 22
  const cfg = { P: 4, V: 1, M: 8, model: '11', cap: 4 };
  const ref = E.referenceSchedule(cfg).state;
  let s = E.newState(cfg);
  const acts = [];
  for (let r = 0; r < cfg.P; r++) {
    const items = ref.rows[r].filter(it => it.id && ref.byId.get(it.id).mb === 0);
    let t = 0;
    for (const it of items.sort((a, b) => a.start - b.start)) {
      for (; t < it.start; t++) acts.push({ start: t, a: { rank: r, type: 'idle' } });
      acts.push({ start: it.start, a: { rank: r, type: 'op', id: it.id } });
      t = it.start + it.dur;
    }
  }
  acts.sort((x, y) => x.start - y.start || x.a.rank - y.a.rank);
  for (const { a } of acts) E.apply(s, a);
  let shoveTotal = 0;
  while (E.microbatchPrefix(s) !== null) {
    const res = E.stampNextMicrobatch(s);
    assert.ok(res.plan, res.violations?.[0]?.msg);
    shoveTotal += res.shoves.length;
    s = E.replay(cfg, E.planToActions(cfg, res.plan));
  }
  assert.ok(E.isDone(s));
  assert.strictEqual(shoveTotal, 0);
  assert.strictEqual(E.score(s).makespan, 22);

  // tight V block: strand 1 must get shoved
  const vcfg = { P: 4, V: 2, M: 8, model: '11', cap: 8 };
  const chain = [];
  for (let st = 0; st < 8; st++) chain.push(['F', st]);
  for (let st = 7; st >= 0; st--) chain.push(['B', st]);
  const vacts = [];
  const frontier = [0, 0, 0, 0];
  let t = 0;
  for (const [k, st] of chain) {
    const r = E.stageRank(vcfg, st);
    while (frontier[r] < t) { vacts.push({ rank: r, type: 'idle' }); frontier[r]++; }
    vacts.push({ rank: r, type: 'op', id: E.opId(k, st, 0) });
    frontier[r]++; t++;
  }
  let vsim = E.replay(vcfg, vacts);
  let vShoves = 0;
  while (E.microbatchPrefix(vsim) !== null) {
    const res = E.stampNextMicrobatch(vsim);
    assert.ok(res.plan, res.violations?.[0]?.msg);
    vShoves += res.shoves.length;
    vsim = E.replay(vcfg, E.planToActions(vcfg, res.plan));
  }
  assert.ok(E.isDone(vsim));
  assert.ok(vShoves > 0, 'tight V block should shove somewhere across strands');
});

test('ripplePlan: drag pushes downstream ops, preserves order, slack absorbs', () => {
  const cfg = { P: 2, V: 1, M: 2, model: '11', cap: null };
  const s = E.newState(cfg);
  // tight schedule: r0: F0@0 F1@1 B0@4 B1@6 ; r1: F0@1 B0@2 F1@3(gap)... build simple:
  const base = new Map([
    ['F0_0', 0], ['F0_1', 1], ['B0_0', 4], ['B0_1', 6],
    ['F1_0', 1], ['B1_0', 2], ['F1_1', 3], ['B1_1', 5],
  ]);
  assert.strictEqual(E.planViolations(cfg, base).length, 0);
  // drag F1_0 (rank1 @1) right to 3: F1_1@3 must be pushed (same rank, order kept),
  // B1_0 (dep of it? B1_0 needs F... B1_0 needs F1_0) pushed too.
  const pins = new Map([['F1_0', 3]]);
  const rippled = E.ripplePlan(cfg, s.byId, base, pins, +1);
  assert.ok(rippled);
  assert.strictEqual(rippled.get('F1_0'), 3);
  assert.ok(rippled.get('B1_0') >= 4, 'B1_0 pushed past F1_0');
  assert.ok(rippled.get('F1_1') >= rippled.get('B1_0') + 1, 'rank order preserved');
  assert.strictEqual(E.planViolations(cfg, rippled).filter(v => v.code !== 'memory').length, 0);
  // untouched upstream stays put
  assert.strictEqual(rippled.get('F0_0'), 0);
  // leftward drag: pull B0_1 from 6 to 5 — nothing else needs to move (slack)
  const rip2 = E.ripplePlan(cfg, s.byId, base, new Map([['B0_1', 5]]), -1);
  assert.ok(rip2);
  assert.strictEqual(rip2.get('B0_1'), 5);
  assert.strictEqual(rip2.get('F0_0'), 0);
  // leftward drag that must pull deps: drag B0_0 (rank0@4, needs B1_0@2 end 3) to 2
  // -> B1_0 must move to 1, F1_0 to 0 — but F1_0 needs F0_0 end 1 -> F1_0 can't go below 1 -> null? 
  // B0_0@2 needs B1_0 end<=2 -> B1_0@1; B1_0 needs F1_0 end<=1 -> F1_0@0; F1_0 needs F0_0 end<=0 -> F0_0@-1 -> null
  const rip3 = E.ripplePlan(cfg, s.byId, base, new Map([['B0_0', 2]]), -1);
  assert.strictEqual(rip3, null);
});

test('roundSize balances ragged microbatch counts; policy uses it', () => {
  assert.strictEqual(E.roundSize({ P: 4, M: 8 }), 4);    // divisible: rounds of P
  assert.strictEqual(E.roundSize({ P: 4, M: 10 }), 5);   // 2 rounds of 5, not 4+4+2
  assert.strictEqual(E.roundSize({ P: 4, M: 6 }), 6);    // 1 round of 6
  assert.strictEqual(E.roundSize({ P: 4, M: 3 }), 3);    // fewer than P: one small round
  const cfg = { P: 4, V: 2, M: 10, model: '11', cap: 8, place: 'wrap' };
  const r = E.referenceSchedule(cfg);
  assert.ok(r.done);
  assert.ok(r.score.makespan <= 53, `balanced rounds should reach 53, got ${r.score.makespan}`);
});

test('zb12 model: B=2F with split grads; schedules complete', () => {
  const cfg = { P: 4, V: 1, M: 8, model: 'zb12', cap: 4 };
  assert.deepStrictEqual(E.durations('zb12'), { F: 1, B: 2, W: 1 });
  assert.ok(E.splitGrad('zb12'));
  assert.strictEqual(E.blockInterval(cfg), 4);   // F+B+W = 1+2+1
  const r = E.referenceSchedule(cfg);
  assert.ok(r.done);
  // W still releases memory: peak bounded by cap
  assert.ok(Math.max(...r.score.peak) <= 4);
  // ZB-H2-style warmup also completes under B=2F
  const r2 = E.referenceSchedule({ ...cfg, cap: 8, warmup: 'zb2' });
  assert.ok(r2.done);
});
