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
