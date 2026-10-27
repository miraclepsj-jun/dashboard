const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/engine.js');
const Pr = require('../src/print.js');
const Demo = require('../src/demo.js');

const d = (m, dd) => E.serialFromYMD(2026, m, dd);

test('현장 출력: 당일 생산지시·금일계획·휴일·2주 간트 통합', () => {
  const today = d(10, 6);
  const m = Demo.build(today);
  m.holidays = [{ date: d(10, 9), note: '한글날' }];
  m.raw = [];
  m.confirmed = [
    { planNo: 'K1', productCode: 'A', partCode: 'PLDB601AR-B', machine: '1', start: d(10, 5), end: d(10, 14), qty: 8000, actualQty: 2000, actualDate: d(10, 6) },
    { planNo: 'K2', productCode: 'A', partCode: 'PLDB601AR-B', machine: '1', start: d(10, 15), end: d(10, 16), qty: 2000 },
    { planNo: 'K3', productCode: 'B', partCode: 'PLDB602AR-B', machine: '2', start: d(9, 28), end: d(10, 2), qty: 5000, actualQty: 1000, actualDate: d(10, 1) },
  ];
  const P = new E.Planner(m, { today });
  const out = Pr.build(P, '1번방', d(10, 7), 14, true);
  const o = out.orders.find((r) => r.machine === '1');
  // 10/7~10/14 근무일: 7,8,12,13,14 = 5일, 잔량 6000 → 1200/일
  assert.equal(o.today, 1200);
  assert.equal(o.remain, 6000);
  assert.equal(out.days.find((x) => x.d === d(10, 9)).work, false);
  assert.equal(o.mini[2], 2); // 10/9 휴일(배정 기간 안)
  assert.equal(out.overdue.length, 1); // 2호기 10/2 완료예정인데 실적 부족
  const g = out.gantt.filter((x) => x.machine === '1' && !x.empty);
  assert.equal(g.length, 1, '동일부품 연속은 한 줄');
  assert.equal(g[0].qty, 10000);
  const sh = Pr.toSheets(out);
  assert.equal(sh.orders[1][9], '금일계획');
  assert.equal(sh.orders[1][4], '신규/계속');
  assert.ok(!sh.orders[1].includes('담당작업자'), '호기별 담당작업자 열 없음');
  // 실적이 없으면 배정총량 ÷ 가공 근무일 (10/15~16, 2일 → 1000)
  assert.equal(Pr.build(P, '1번방', d(10, 16), 14, true).orders.find((r) => r.planNo === 'K2').today, 1000);
  // 휴일에는 금일계획 0
  assert.equal(Pr.build(P, '1번방', d(10, 9), 14, true).orders.find((r) => r.machine === '1').today, 0);
});

test('현장 출력: 직전 근무일 같은 호기·같은 부품이면 계속, 아니면 신규 (v738 fix20)', () => {
  const T = E.serialFromYMD(2026, 10, 26); // 월
  const m = Demo.build(T);
  m.holidays = [];
  m.raw = [
    { planNo: 'N1', productCode: 'PN', partCode: 'PLDB701AR-B', qty: 3000, received: 0, reqDate: T + 30, material: 'SK-4', refMachines: [] },
    { planNo: 'N2', productCode: 'PN', partCode: 'PLDB701AR-B', qty: 3000, received: 0, reqDate: T + 30, material: 'SK-4', refMachines: [] },
    { planNo: 'N3', productCode: 'PO', partCode: 'PLDB702AR-B', qty: 3000, received: 0, reqDate: T + 30, material: 'SK-4', refMachines: [] },
  ];
  m.confirmed = [
    // 1호기: 금요일까지 N1, 월요일부터 같은 부품 N2 → 월요일은 계속
    { planNo: 'N1', productCode: 'PN', partCode: 'PLDB701AR-B', machine: '1', start: T - 7, end: T - 3, qty: 3000 },
    { planNo: 'N2', productCode: 'PN', partCode: 'PLDB701AR-B', machine: '1', start: T, end: T + 2, qty: 3000 },
    // 2호기: 월요일에 다른 부품 시작 → 신규
    { planNo: 'N3', productCode: 'PO', partCode: 'PLDB702AR-B', machine: '2', start: T, end: T + 2, qty: 3000 },
  ];
  const P = new E.Planner(m, { today: T - 1, calendarMode: 'work' });
  const out = Pr.build(P, '1번방', T, 7, false);
  const o1 = out.orders.find((r) => r.machine === '1');
  const o2 = out.orders.find((r) => r.machine === '2');
  assert.equal(o1.startKind, '계속');
  assert.equal(o2.startKind, '신규');
  assert.deepEqual(o2.mini.slice(0, 3), [4, 1, 1]);
  assert.equal(o1.mini[0], 1);
});
