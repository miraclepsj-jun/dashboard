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
  assert.equal(Q.initialRows().length, rows.length);
  assert.equal(Q.confirmRows().filter((r) => r.initial).length, 0);
  // 반영 후 다시 미리보기 → 9번중복(현행 일정에 이미 있음)
  const again = M.preview(parsed, Q);
  assert.equal(again.waves.find((w) => w.part === 'PLDB501AR-B' && w.status !== '지난일정').status, '9번중복');
  // 초기 이관 행을 9번에 붙여넣은 뒤(전환 완료) 다시 불러오면 저장된 이관 행은 겹쳐 쓰지 않는다
  const m2 = Object.assign({}, m, { confirmed: rows.map((r) => Object.assign({}, r, { source: undefined })) });
  const R = new E.Planner(m2, { today: TODAY, manualConfirmed: rows });
  assert.equal(R.transition, false);
  assert.equal(R.manualIgnored, rows.length);
  assert.equal(R.itemByKey[E.itemKey('A1', 'PA', 'PLDB501AR-B')].confirmedQty, 30000, '확정수량이 두 배가 되면 안 됨');
});

test('수기 일정 이관: 수량 표기 유무 혼재·발주별 남은 수량·원본 기간·미등록 호기', () => {
  const m = model();
  m.raw = [
    { planNo: 'G1', productCode: 'PG', partCode: 'PLDB506AR-B', qty: 20000, received: 0, orderDate: TODAY - 10, material: 'SK-4', refMachines: [] },
    { planNo: 'H1', productCode: 'PH', partCode: 'PLDB507AR-B', qty: 100000, received: 0, orderDate: TODAY - 10, material: 'SK-4', refMachines: [] },
    { planNo: 'J1', productCode: 'PJ', partCode: 'PLDB508AR-B', qty: 5000, received: 0, orderDate: TODAY - 10, material: 'SK-4', refMachines: ['9'], progStart: TODAY + 60, progEnd: TODAY + 90 },
    { planNo: 'J2', productCode: 'PJ', partCode: 'PLDB508AR-B', qty: 6000, received: 0, orderDate: TODAY - 5, material: 'SK-4', refMachines: [] },
    { planNo: 'K1', productCode: 'PK', partCode: 'PLDB509AR-B', qty: 4000, received: 0, orderDate: TODAY - 10, material: 'SK-4', refMachines: [] },
    { planNo: 'L1', productCode: 'PL', partCode: 'PLDB510AR-B', qty: 8000, received: 0, orderDate: TODAY - 10, material: 'SK-4', refMachines: [] },
    { planNo: 'L2', productCode: 'PL', partCode: 'PLDB510AR-B', qty: 8000, received: 0, orderDate: TODAY - 5, material: 'SK-4', refMachines: [] },
  ];
  const P = new E.Planner(m, { today: TODAY, useProgramAssignments: false });
  const parsed = {
    firstDate: TODAY - 3,
    segs: [
      // 한 발주(20K)를 수기 블록 셋이 나눠 씀: 15K → 남은 5K만 → 잔량없음
      seg(4, 'PLDB506AR-B', 1, 3, { qty: 15000 }),
      seg(5, 'PLDB506AR-B', 6, 8, { qty: 12000 }),
      seg(6, 'PLDB506AR-B', 12, 13, { qty: 3000 }),
      // 수량 표기 없음 → 근무일 × 일생산량 추정 (발주 전량 100K가 아니라)
      seg(8, 'PLDB507AR-B', 1, 2),
      // 설비1~A에 9호기가 있어도 원본 개시~완료가 두 달 뒤면 근거가 아님 → 수량 일치로 J2
      seg(9, 'PLDB508AR-B', 1, 3, { qty: 6000 }),
      // 설비마스터에 없는 호기도 이관한다
      seg(9999, 'PLDB509AR-B', 1, 3, { qty: 4000 }),
      // 수량 표기 없는 두 블록, 미납 발주 2건 → 확인필요(발주일순 추천)
      seg(10, 'PLDB510AR-B', 1, 2),
      seg(103, 'PLDB510AR-B', 20, 21),
    ],
  };
  const pv = M.preview(parsed, P);
  const by = (part) => pv.waves.filter((w) => w.part === part);
  const sum = (w) => w.rows.reduce((a, r) => a + r.qty, 0);
  const g = by('PLDB506AR-B');
  assert.deepEqual(g.map((w) => w.status), ['정상', '정상', '잔량없음']);
  assert.deepEqual(g.slice(0, 2).map(sum), [15000, 5000]);
  assert.match(g[1].reason, /남은 만큼/);
  assert.match(g[2].reason, /앞 수기 블록/);
  const h = by('PLDB507AR-B')[0];
  assert.equal(h.status, '정상');
  assert.equal(h.estimated, true);
  assert.equal(sum(h), P.cal.count(TODAY + 1, TODAY + 2) * 5000);
  assert.equal(pv.estimated, 1);
  const j = by('PLDB508AR-B')[0];
  assert.deepEqual(j.plans, ['J2']);
  assert.equal(j.how, '수량 일치');
  const k = by('PLDB509AR-B')[0];
  assert.equal(k.status, '정상');
  assert.match(k.reason, /설비마스터 미등록 호기 9999/);
  const [l1, l2] = by('PLDB510AR-B');
  assert.equal(l1.status, '확인필요');
  assert.deepEqual(l1.suggest, ['L1', 'L2']);
  assert.equal(l1.suggestQty, P.cal.count(TODAY + 1, TODAY + 2) * 5000);
  // 담당자 지정은 다른 묶음이 이미 쓴 수량을 뺀다
  assert.equal(M.resolve(l1, ['L1'], 0, P, pv), true);
  assert.equal(sum(l1), 8000);
  assert.equal(M.resolve(l2, ['L1'], 0, P, pv), false);
  assert.equal(M.resolve(l2, ['L2'], 0, P, pv), true);
  assert.equal(pv.counts['확인필요'], 0);
  // 발주별 이관 합계는 미납잔량을 넘지 않는다
  const rows = M.toConfirmed(pv);
  const tot = {};
  for (const r of rows) tot[r.planNo] = (tot[r.planNo] || 0) + r.qty;
  for (const r of m.raw) assert.ok(!(tot[r.planNo] > r.qty), r.planNo + ' 과배정');
  // 미등록 호기 일정은 현행 일정에 남고 점검 목록에 나온다
  const Q = new E.Planner(m, { today: TODAY, manualConfirmed: rows });
  assert.deepEqual(Q.unknownMachines().map((u) => [u.no, u.rows]), [['9999', 1]]);
});
