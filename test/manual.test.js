const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/engine.js');
const M = require('../src/manual.js');
const Demo = require('../src/demo.js');

const TODAY = E.serialFromYMD(2026, 10, 6);
const seg = (machine, part, s, e, extra) => Object.assign({ sheet: '시트', machine: String(machine), part, label: part, startDate: TODAY + s, endDate: TODAY + e, days: e - s + 1 }, extra || {});

function model() {
  const m = Demo.build(TODAY);
  m.confirmed = [];
  m.raw = [
    { planNo: 'A1', productCode: 'PA', partCode: 'PLDB501AR-B', qty: 30000, received: 0, orderDate: TODAY - 30, material: 'SK-4', refMachines: [] },
    { planNo: 'B1', productCode: 'PB', partCode: 'PLDB502AR-B', qty: 10000, received: 0, orderDate: TODAY - 30, material: 'SK-4', refMachines: [] },
    { planNo: 'B2', productCode: 'PB', partCode: 'PLDB502AR-B', qty: 20000, received: 0, orderDate: TODAY - 20, material: 'SK-4', refMachines: [] },
    { planNo: 'C1', productCode: 'PC', partCode: 'PLDB503AR-B', qty: 8000, received: 0, orderDate: TODAY - 30, material: 'SK-4', refMachines: ['7'] },
    { planNo: 'C2', productCode: 'PC', partCode: 'PLDB503AR-B', qty: 9000, received: 0, orderDate: TODAY - 20, material: 'SK-4', refMachines: [] },
    { planNo: 'D1', productCode: 'PD', partCode: 'PLDB504AR-B', qty: 5000, received: 5000, material: 'SK-4', refMachines: [] },
    { planNo: 'E1', productCode: 'PE', partCode: 'PLDB505AR-B', qty: 7000, received: 0, orderDate: TODAY - 9, material: 'SK-4', refMachines: [] },
    { planNo: 'E2', productCode: 'PE', partCode: 'PLDB505AR-B', qty: 6000, received: 0, orderDate: TODAY - 8, material: 'SK-4', refMachines: [] },
  ];
  return m;
}

test('수기 일정 이관: 작업묶음 매칭·수량배분·판정', () => {
  const m = model();
  const P = new E.Planner(m, { today: TODAY, useProgramAssignments: false });
  const parsed = {
    firstDate: TODAY - 3,
    segs: [
      // 단일 발주 2대 묶음 (같은 표기·같은 기간)
      seg(1, 'PLDB501AR-B', -2, 7, { qty: 30000, group: [1, 2] }),
      seg(2, 'PLDB501AR-B', -2, 7, { qty: 30000, group: [1, 2] }),
      // 연속 발주 수량 합 일치 (10K + 20K)
      seg(3, 'PLDB502AR-B', 1, 10, { qty: 30000 }),
      // 원본 설비1~A 근거로 C1
      seg(7, 'PLDB503AR-B', 1, 4, { qty: 1000 }),
      // 원본 입고완료
      seg(8, 'PLDB504AR-B', 1, 3),
      // 특정 불가 → 확인필요
      seg(9, 'PLDB505AR-B', 1, 3, { qty: 999 }),
      // 지난 일정
      seg(10, 'PLDB501AR-B', -9, -5, { qty: 30000 }),
      // 부품코드 오타(편집거리 1) + 원본 설비 근거 없음 → 확인필요
      seg(11, 'PLDB50XAR-B', 1, 3),
    ],
  };
  const pv = M.preview(parsed, P);
  const by = (part) => pv.waves.filter((w) => w.part === part);
  const a = by('PLDB501AR-B').find((w) => w.status !== '지난일정');
  assert.equal(a.status, '정상');
  assert.equal(a.rows.length, 2);
  assert.deepEqual(a.rows.map((r) => r.qty), [15000, 15000]);
  const b = by('PLDB502AR-B')[0];
  assert.equal(b.status, '정상');
  assert.equal(b.how, '연속 발주 수량 합 일치');
  assert.deepEqual(b.rows.map((r) => [r.planNo, r.qty]), [['B1', 10000], ['B2', 20000]]);
  assert.equal(by('PLDB503AR-B')[0].plans[0], 'C1');
  assert.equal(by('PLDB504AR-B')[0].status, '원본완료');
  assert.equal(by('PLDB505AR-B')[0].status, '확인필요');
  assert.equal(by('PLDB501AR-B').find((w) => w.status === '지난일정').reason, '수기 완료일이 오늘 이전');
  assert.equal(by('PLDB50XAR-B')[0].status, '확인필요');
  // 담당자 수정
  const e = by('PLDB505AR-B')[0];
  assert.equal(M.resolve(e, ['E2'], 0, P), true);
  assert.equal(e.status, '정상');
  assert.deepEqual(e.rows.map((r) => [r.planNo, r.qty]), [['E2', 6000]]);
  // 반영: 현행 일정으로 쓰고 9번 붙여넣기에 포함, 같은 품목은 배정완료
  const rows = M.toConfirmed(pv);
  const Q = new E.Planner(m, { today: TODAY, manualConfirmed: rows });
  assert.equal(Q.itemByKey[E.itemKey('A1', 'PA', 'PLDB501AR-B')].status, '배정완료');
  assert.equal(Q.timeline.gapStart('1', TODAY + 1, 1), Q.cal.nextWork(TODAY + 8));
  Q.autoPlan();
  assert.equal(Q.confirmRows().filter((r) => r.initial).length, rows.length);
  // 반영 후 다시 미리보기 → 9번중복(현행 일정에 이미 있음)
  const again = M.preview(parsed, Q);
  assert.equal(again.waves.find((w) => w.part === 'PLDB501AR-B' && w.status !== '지난일정').status, '9번중복');
});
