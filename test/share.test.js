const test = require('node:test');
const assert = require('node:assert/strict');
const Sh = require('../src/share.js');

const draft = (itemKey, machine, start, end, qty, extra) => Object.assign({ id: Math.random(), itemKey, machine, start, end, qty, manual: false }, extra || {});
function baseState() {
  return {
    app: 'CNC_일정수립',
    rev: 5,
    source: 'v738.xlsm',
    model: { raw: [{ planNo: 'A' }, { planNo: 'B' }, { planNo: 'C' }], machines: [{ no: '1' }], confirmed: [{ machine: '1', start: 100, end: 104 }] },
    plan: {
      drafts: [draft('A', '2', 110, 112, 1000), draft('B', '3', 110, 115, 2000)],
      results: { A: { decision: '가배정' }, B: { decision: '가배정' } },
    },
    settings: { roomHeadcount: '1번방 = 3' },
    manualRows: [],
  };
}
const clone = (x) => JSON.parse(JSON.stringify(x));

test('공유 병합: 내가 바꾼 품목은 내 것, 상대가 바꾼 품목은 상대 것', () => {
  const base = baseState();
  const bd = Sh.digest(base);
  const mine = clone(base);
  mine.plan.drafts[0] = draft('A', '7', 120, 122, 1000, { manual: true }); // 내가 A를 7호기로
  mine.settings.roomHeadcount = '1번방 = 4'; // 내가 인원 변경
  const theirs = clone(base);
  theirs.rev = 6;
  theirs.plan.drafts = theirs.plan.drafts.filter((d) => d.itemKey !== 'B').concat(draft('B', '9', 130, 133, 2000, { manual: true })); // 상대가 B를 9호기로
  theirs.plan.drafts.push(draft('C', '4', 110, 111, 500)); // 상대가 C 새로 배정
  theirs.plan.results.C = { decision: '가배정' };
  theirs.model.raw.push({ planNo: 'D' }); // 상대가 원본 새로 붙여넣음

  assert.equal(Sh.changes(bd, mine).items, 1);
  assert.equal(Sh.changes(bd, mine).settings, true);
  assert.equal(Sh.changes(bd, base).any, false);

  const { state, report } = Sh.merge(bd, mine, theirs, false);
  const by = (k) => state.plan.drafts.filter((d) => d.itemKey === k).map((d) => d.machine);
  assert.deepEqual(by('A'), ['7']);
  assert.deepEqual(by('B'), ['9']);
  assert.deepEqual(by('C'), ['4']);
  assert.equal(state.settings.roomHeadcount, '1번방 = 4');
  assert.equal(state.model.raw.length, 4, '상대가 붙여넣은 원본');
  assert.deepEqual([report.mineItems, report.theirItems, report.bothItems.length], [1, 2, 0]);
  assert.equal(report.model.raw, 'theirs');
  assert.equal(state.rev, 6);
});

test('공유 병합: 같은 품목을 둘 다 고치면 충돌로 알리고, 고른 쪽을 쓴다', () => {
  const base = baseState();
  const bd = Sh.digest(base);
  const mine = clone(base);
  mine.plan.drafts[0].machine = '7';
  const theirs = clone(base);
  theirs.plan.drafts[0].machine = '8';
  const a = Sh.merge(bd, mine, theirs, true);
  assert.deepEqual(a.report.bothItems, ['A']);
  assert.equal(a.state.plan.drafts.find((d) => d.itemKey === 'A').machine, '7');
  const b = Sh.merge(bd, mine, theirs, false);
  assert.equal(b.state.plan.drafts.find((d) => d.itemKey === 'A').machine, '8');
  // 둘이 똑같이 바꾸면 충돌 아님
  const c = Sh.merge(bd, mine, clone(mine), false);
  assert.equal(c.report.bothItems.length, 0);
});

test('공유: 가배정 번호(id)는 비교에서 빼고, 병합 뒤 같은 호기 겹침을 찾는다', () => {
  const base = baseState();
  const again = clone(base);
  again.plan.drafts.forEach((d, i) => (d.id = 1000 + i));
  assert.equal(Sh.changes(Sh.digest(base), again).any, false);
  const st = clone(base);
  st.plan.drafts.push(draft('C', '2', 111, 113, 300)); // A(2호기 110~112)와 겹침
  st.plan.drafts.push(draft('D', '1', 103, 106, 300)); // 1호기 확정(100~104)과 겹침
  const ov = Sh.overlaps(st);
  assert.equal(ov.length, 2);
  assert.ok(ov.some((o) => o.machine === '2') && ov.some((o) => o.machine === '1'));
  assert.match(Sh.backupName(7, Date.UTC(2026, 10, 3, 5, 9), '박 담당'), /^CNC_공유작업_000007_2026110\d-\d{4}_박담당\.json$/);
  assert.throws(() => Sh.parse('{"app":"다른것"}'));
});
