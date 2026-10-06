const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const E = require('../src/engine.js');
const L = require('../src/learn.js');
const Demo = require('../src/demo.js');

const TODAY = E.serialFromYMD(2026, 10, 6);

test('라벨 해석: 부품/수량K/같이 도는 호기/메모', () => {
  assert.deepEqual(L.parseLabel('TEGX4376AM-DGP/640K(519.529.535)(~11/19)'), { part: 'TEGX4376AM-DGP', qty: 640000, group: [519, 529, 535], note: '~11/19' });
  assert.deepEqual(L.parseLabel('PLGC331R-D/1.2K'), { part: 'PLGC331R-D', qty: 1200 });
  assert.deepEqual(L.parseLabel('PLDBF16U-B1SK/35.3(10.48.102)'), { part: 'PLDBF16U-B1SK', qty: 35300, group: [10, 48, 102] });
  assert.deepEqual(L.parseLabel('TEGC210M3-DGP'), { part: 'TEGC210M3-DGP' });
});

// 방별 시트 1장짜리 수기 간트 (색칠 구간 = 가공기간)
function ganttWorkbook() {
  const ws = {};
  const put = (r, c, v, fill) => {
    const a = XLSX.utils.encode_cell({ r, c });
    ws[a] = { t: typeof v === 'number' ? 'n' : 's', v };
    if (fill) ws[a].s = { patternType: 'solid', fgColor: { theme: fill, tint: 0.6 } };
  };
  const blank = (r, c, fill) => {
    ws[XLSX.utils.encode_cell({ r, c })] = { t: 'z', s: { patternType: 'solid', fgColor: { theme: fill, tint: 0.6 } } };
  };
  put(0, 0, '신규호기');
  put(0, 1, '소재');
  put(0, 2, '기종별');
  const days = [28, 29, 30, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  days.forEach((d, i) => put(0, 3 + i, d));
  // 1호기: 9/29~10/3 (5일) 부품A 20K, 10/5~10/6 부품B
  put(1, 0, 1);
  put(1, 3 + 1, 'PLDB101AR-B/20K(1.2)', 6);
  for (let i = 2; i <= 5; i++) blank(1, 3 + i, 6);
  put(1, 3 + 7, 'PLDB102AR-B/2K', 7);
  blank(1, 3 + 8, 7);
  // 2호기: 같은 작업 같은 날 시작
  put(2, 0, 2);
  put(2, 3 + 1, 'PLDB101AR-B/20K(1.2)', 6);
  for (let i = 2; i <= 5; i++) blank(2, 3 + i, 6);
  ws['!ref'] = 'A1:R3';
  return { SheetNames: ['1~102호기(SK)'], Sheets: { '1~102호기(SK)': ws } };
}

test('수기 간트 읽기: 색칠 구간을 가공기간으로, 첫 날짜는 기준일 근처 월로 추정', () => {
  const p = L.parseGantt(ganttWorkbook(), { today: TODAY });
  assert.equal(E.fmtYMD(p.firstDate), '2026-09-28');
  assert.equal(p.horizon, 15);
  const a = p.segs.filter((s) => s.part === 'PLDB101AR-B');
  assert.equal(a.length, 2);
  assert.equal(E.fmtYMD(a[0].startDate), '2026-09-29');
  assert.equal(a[0].days, 5);
  const b = p.segs.find((s) => s.part === 'PLDB102AR-B');
  assert.equal(b.days, 2);
  assert.equal(b.qty, 2000);
});

test('학습 보고서: 수량대별 호기 수·가공기간·분산, 자동배정 요약', () => {
  const m = Demo.build(TODAY);
  m.raw.push({ planNo: 'L1', productCode: 'DB101', partCode: 'PLDB101AR-B', qty: 20000, material: 'SK-4' });
  m.raw.push({ planNo: 'L2', productCode: 'DB102', partCode: 'PLDB102AR-B', qty: 2000, material: 'SK-4' });
  const P = new E.Planner(m, { today: TODAY });
  const rep = L.analyze(L.parseGantt(ganttWorkbook(), { today: TODAY }), P);
  assert.equal(rep.jobs, 2);
  const b2 = rep.bands.find((b) => b.key === 'b2');
  assert.equal(b2.jobs, 1);
  assert.equal(b2.machinesMed, 2);
  assert.equal(b2.runMed, 5);
  assert.equal(b2.ratioMed, 2); // 수기 10장비일 ÷ 기준 5장비일(20000/5000+1)
  assert.equal(rep.spread.multiJobs, 1);
  assert.equal(rep.spread.oneRoom, 1);
  assert.equal(rep.spread.sameDayStart, 1);
  P.autoPlan();
  const sm = L.summarizePlan(P);
  assert.ok(sm.bands.reduce((a, b) => a + b.jobs, 0) > 0);
});

test('가공기간 보정: 수량대별 계수를 기준 장비일수에 곱한다', () => {
  const m = Demo.build(TODAY);
  m.raw = [{ planNo: 'F1', productCode: 'X', partCode: 'PLDB201AR-B', qty: 20000, received: 0, reqDate: TODAY + 40, material: 'SK-4' }];
  const P0 = new E.Planner(m, { today: TODAY });
  const P1 = new E.Planner(m, { today: TODAY, periodFactors: L.DEFAULT_FACTORS });
  const it = P1.items[0];
  assert.equal(P0.planDays(it, 20000), 5); // 20000/5000 + 여유 1
  assert.equal(P1.planDays(it, 20000), 7); // ×1.4
  assert.equal(P1.planDays(it, 1000), 1); // 1만 미만 ×0.5 → 하루
});
