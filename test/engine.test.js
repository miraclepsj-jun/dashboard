const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/engine.js');
const Demo = require('../src/demo.js');

const TODAY = E.serialFromYMD(2026, 9, 28);

test('날짜 변환', () => {
  assert.equal(E.serialFromYMD(2026, 9, 28), 46293);
  assert.equal(E.fmtYMD(46293), '2026-09-28');
  assert.equal(E.toSerial('2026-09-28'), 46293);
  assert.equal(E.toSerial('9/28', 2026), 46293);
  assert.equal(E.toSerial('9월28일', 2026), 46293);
  assert.equal(E.toSerial(46293.6), 46293);
  assert.equal(E.toSerial(''), null);
});

test('품목 분류: 우선순위 순으로 첫 규칙 적용, 대분류는 앞 2자리', () => {
  const rules = E.prepareRules(Demo.build(TODAY).rules);
  assert.deepEqual(E.classifyPart('BDLMG100AM-GP1', rules), { main: 'BD', detail: 'AM', prod: '커터' });
  assert.deepEqual(E.classifyPart('PLDB1639AR-B', rules), { main: 'PL', detail: 'AR', prod: 'AR' });
  // 본체끝문자: '-' 앞 본체가 C로 끝남
  assert.equal(E.classifyPart('PLDB445C-B', rules).prod, '커터');
  assert.equal(E.classifyPart('BG-35-120', rules).main, 'BG');
  assert.equal(E.classifyPart('XX123', rules).main, '기타');
});

test('권장 장비대수 구간', () => {
  assert.equal(E.recommendMachineRange(0), '');
  assert.equal(E.recommendMachineRange(5), '1');
  assert.equal(E.recommendMachineRange(8), '2');
  assert.equal(E.recommendMachineRange(15), '2~3');
  assert.equal(E.recommendMachineRange(30), '3~5');
  assert.equal(E.recommendMachineRange(41), 'Manual Review');
});

test('필요 장비일수 = 올림(수량/일생산량) + 여유일', () => {
  const m = Demo.build(TODAY);
  m.raw = [{ planNo: 'P1', productCode: 'X', partCode: 'BDLMG100AM-GP1', qty: 20000, reqDate: TODAY + 5, material: 'TK-1' }];
  const [it] = E.buildItems(m, { baseDate: TODAY + 1 });
  assert.equal(it.daily, 3000);
  assert.equal(it.machineDays, 8); // ceil(6.67)=7 + 1
  assert.equal(it.rec, '2');
  assert.equal(it.availDays, 5);
});

test('소재계열/현재소재 비교', () => {
  assert.equal(E.materialGroup('C1730'), 'BECU');
  assert.equal(E.materialGroup('H3J'), 'TK');
  assert.equal(E.materialGroup('SK-42(TK-B)'), 'TK');
  assert.equal(E.materialGroup('C3604'), '');
  assert.equal(E.materialGroup('H5J-1', E.parseMaterialMap('H5J=TK')), 'TK');
  assert.equal(E.settingMatch('C1730', 'BECU', 'C1730').score, 60);
  assert.equal(E.settingMatch('C1730', 'BECU', 'BECU 1.5').score, 25);
  assert.equal(E.settingMatch('C1730', 'BECU', 'TK(0.7)').score, -20);
  assert.equal(E.settingMatch('C1730', 'BECU', '').text, '현재소재 미기록');
});

test('방 판정: "TK/H3J" 방은 TK 품목을 받는다 (토큰 일치)', () => {
  const room = { name: '5번방', matGroup: 'TK/H3J', prodClass: '', mainAllowed: 'PL/TE', special: 'N', autoUse: 'Y' };
  const r = E.roomEligible(room, { main: 'TE', prod: '커터', matGroup: 'TK' });
  assert.ok(r);
  assert.equal(r.score, 110);
  assert.equal(E.roomEligible(room, { main: 'BD', prod: 'BD', matGroup: 'TK' }), null);
  assert.equal(E.roomEligible({ name: '8번방', autoUse: 'N' }, { main: 'PL' }), null);
});

test('수량 100개 단위 배분, 총량 보존', () => {
  assert.deepEqual(E.distributeQtyHundreds(13200, [5, 5]), [6600, 6600]);
  const q = E.distributeQtyHundreds(10050, [3, 2, 2]);
  assert.equal(q.reduce((a, b) => a + b, 0), 10050);
  assert.ok(q.every((v, i) => i === 0 || v % 100 === 0));
  assert.deepEqual(E.distributeQtyHundreds(777, [0, 4]), [0, 777]);
});

test('타임라인: 빈 구간 탐색, 실적완료 시 조기해제, 지연 호기 차단', () => {
  const tl = new E.Timeline(
    [
      { machine: '1', start: TODAY + 1, end: TODAY + 3, qty: 100 },
      { machine: '1', start: TODAY + 6, end: TODAY + 8, qty: 100 },
      { machine: '2', start: TODAY - 5, end: TODAY + 5, qty: 100, actualQty: 100, actualDate: TODAY - 1 },
      { machine: '3', start: TODAY - 5, end: TODAY - 1, qty: 100 },
    ],
    { today: TODAY }
  );
  assert.equal(tl.gapStart('1', TODAY + 1, 1), TODAY + 4);
  assert.equal(tl.gapStart('1', TODAY + 1, 2), TODAY + 4); // 4,5일 사이 2일 들어감
  assert.equal(tl.gapStart('1', TODAY + 1, 3), TODAY + 9); // 3일은 안 들어가서 다음 구간 뒤
  assert.equal(tl.gapStart('2', TODAY, 1), TODAY); // 어제 실적완료 → 오늘부터
  assert.equal(tl.status('3').delayed, true);
  assert.equal(tl.gapStart('3', TODAY + 1, 1), null);
  const tl2 = new E.Timeline([{ machine: '3', start: TODAY - 5, end: TODAY - 1, qty: 100 }], { today: TODAY, delayPolicy: 'assumeDone' });
  assert.equal(tl2.gapStart('3', TODAY + 1, 1), TODAY + 1);
});

test('일괄 자동배정: 겹침 없음, 수량 보존, 수기검토 사유 기록', () => {
  const P = new E.Planner(Demo.build(TODAY), { today: TODAY });
  const s = P.autoPlan();
  assert.ok(s.draft > 0, '가배정이 있어야 함');
  assert.equal(s.todo, 0);
  for (const [m, segs] of P.timeline.byMachine) {
    const sorted = segs.slice().sort((a, b) => a.s - b.s);
    for (let i = 1; i < sorted.length; i++) assert.ok(sorted[i].s > sorted[i - 1].effEnd, m + '호기 일정 겹침');
    for (const b of P.timeline.blocks[m] || []) for (const seg of segs) if (seg.kind === 'draft') assert.ok(seg.e < b.s || seg.s > b.e, m + '호기 고장기간 배정');
  }
  for (const it of P.items) {
    if (it.dupOf != null) continue;
    const dq = P.draftQty(it.key);
    if (dq) assert.equal(dq, it.openQty - it.confirmedQty, it.partCode + ' 수량');
    const r = P.results[it.key];
    if (r && r.decision === '수기검토') assert.ok(r.reason.length > 0);
    if (it.main === 'BG') assert.equal(r.decision, '수기검토');
  }
  for (const d of P.drafts) assert.ok(d.start >= TODAY + 1, '기준게시일 이전 배정 금지');
});

test('동일부품 연속가공 호기 우선', () => {
  const m = Demo.build(TODAY);
  const P = new E.Planner(m, { today: TODAY });
  const it = P.items[1]; // 519호기에서 같은 부품이 TODAY+1까지 가공 중
  const c = P.candidates(it, { from: TODAY + 1 }).candidates;
  assert.equal(c[0].machine, '519');
  assert.equal(c[0].sameCont, 1);
});

test('수기 가배정과 취소', () => {
  const P = new E.Planner(Demo.build(TODAY), { today: TODAY });
  const it = P.items.find((i) => i.main === 'BG');
  const a = P.manualAssign(it, ['1', '2'], { qty: 10, days: 2 });
  assert.equal(a.length, 2);
  assert.equal(P.results[it.key].decision, '수기가배정');
  P.autoPlan();
  assert.equal(P.results[it.key].decision, '수기가배정', '자동배정이 수기 결과를 덮지 않음');
  P.clearAutoDrafts();
  assert.equal(P.drafts.filter((d) => d.itemKey === it.key).length, 2);
  P.removeDraftsForItem(it.key);
  assert.equal(P.draftQty(it.key), 0);
});

test('내보내기 행: 9번 확정시트 형식과 설비1~A 요약', () => {
  const P = new E.Planner(Demo.build(TODAY), { today: TODAY });
  P.autoPlan();
  const rows = P.confirmRows();
  assert.equal(rows.length, P.drafts.length);
  assert.ok(rows.every((r) => r.machine > 0 && r.end >= r.start && r.qty > 0));
  const prog = P.programSummary();
  assert.ok(prog.length > 0 && prog.every((p) => p.machines.length >= 1));
});

test('가배정 상태 저장/복원', () => {
  const m = Demo.build(TODAY);
  const P = new E.Planner(m, { today: TODAY });
  P.autoPlan();
  const state = JSON.parse(JSON.stringify(P.exportState()));
  const Q = new E.Planner(m, { today: TODAY });
  assert.equal(Q.importState(state), P.drafts.length);
  assert.deepEqual(Q.summary(), P.summary());
});

test('분산형: 한 품목은 방(조)마다 1대, 작업자 1인 하루 신규셋팅 한도 준수', () => {
  const m = Demo.build(TODAY);
  // 한 작업자가 방 안의 호기 5대씩 담당
  for (const w of m.workers) w.worker = w.room + '-' + Math.floor((Number(w.machine) % 1000) / 5);
  const P = new E.Planner(m, { today: TODAY, setupLimitPerWorkerDay: 1 });
  P.autoPlan();
  assert.equal(P.groupOf['1'], '1번방');
  const byItem = {};
  for (const d of P.drafts) (byItem[d.itemKey] = byItem[d.itemKey] || []).push(d);
  for (const list of Object.values(byItem)) {
    // 방마다 1대씩 먼저 채우고, 가능한 방이 모자랄 때만 같은 방에 고르게 더 넣는다
    const per = {};
    for (const d of list) per[P.groupOf[d.machine]] = (per[P.groupOf[d.machine]] || 0) + 1;
    const n = Object.keys(per).length;
    assert.ok(Math.max(...Object.values(per)) <= Math.ceil(list.length / n), '한 방에 몰림: ' + JSON.stringify(per));
  }
  for (const [k, v] of P.setupCount) if (k.startsWith('작업자') && Number(k.split('|')[1]) >= TODAY + 1) assert.ok(v <= 1, k + ' 신규셋팅 ' + v + '건');
});

test('분산형: 요청일까지 기간을 늘려 대수를 줄이고, 이미 늦은 품목은 최대 대수로 몰지 않음', () => {
  const m = Demo.build(TODAY);
  m.raw = [
    { planNo: 'A', productCode: 'X1', partCode: 'TEGX101AM-DGP', qty: 120000, reqDate: TODAY + 30, material: 'TK-B' }, // 41일분
    { planNo: 'B', productCode: 'X2', partCode: 'TEGX202AM-DGP', qty: 120000, reqDate: TODAY - 10, material: 'TK-B' },
  ];
  const spread = new E.Planner(m, { today: TODAY, maxMachines: 6, minRunDays: 7, maxRunDays: 30 });
  assert.equal(spread._countRange(spread.items[0], 41).min, 2); // 41일 / 30일 → 2대
  assert.deepEqual(spread._countRange(spread.items[1], 41), { min: 6, max: 6 }); // 늦은 품목: 41/7=6 고정
  const fast = new E.Planner(m, { today: TODAY, allocMode: 'fast', maxMachines: 10 });
  assert.equal(fast._countRange(fast.items[1], 41).min, 10);
  spread.autoPlan();
  const a = spread.drafts.filter((d) => d.partCode === 'TEGX101AM-DGP');
  assert.ok(a.length >= 2 && a.length <= 3);
  assert.ok(Math.max(...a.map((d) => d.end)) <= TODAY + 30 + 1);
});

test('셋팅 수: 같은 부품을 이어서 가공하면 신규셋팅으로 세지 않음', () => {
  const P = new E.Planner(Demo.build(TODAY), { today: TODAY, setupLimitPerWorkerDay: 1 });
  const it = P.items[1];
  const day = TODAY + 2; // 519호기 확정이 TODAY+1에 끝남
  assert.equal(P._isContinuation('519', day, it.partCode), true);
  assert.equal(P.startFor('519', TODAY + 1, 3, it.partCode), day);
});

test('방마스터 우선: 1순위 방(소재계열+우선생산성분류 일치) 호기를 먼저 쓴다', () => {
  const m = Demo.build(TODAY);
  m.raw = [{ planNo: 'R1', productCode: 'GX1', partCode: 'TEGX111AM-DGP', qty: 20000, reqDate: TODAY + 10, material: 'TK-B' }];
  const P = new E.Planner(m, { today: TODAY });
  P.autoPlan();
  const ds = P.drafts.filter((d) => d.partCode === 'TEGX111AM-DGP');
  assert.ok(ds.length >= 1);
  // TK 커터 품목: 6번방(TK+커터)이 1순위, 5번방(TK/H3J, 우선생산성 없음)은 1순위가 모자랄 때만
  assert.ok(ds.every((d) => P.groupOf[d.machine] === '6번방'), JSON.stringify(ds.map((d) => d.machine)));
});

test('담당자 조정: 가배정 기간/호기 변경, 겹침 거절, 지연 확인', () => {
  const m = Demo.build(TODAY);
  m.raw = [
    { planNo: 'L1', productCode: 'GX1', partCode: 'TEGX121AM-DGP', qty: 9000, reqDate: TODAY + 2, material: 'TK-B' },
    { planNo: 'L2', productCode: 'GX2', partCode: 'TEGX122AM-DGP', qty: 3000, reqDate: TODAY + 20, material: 'TK-B' },
  ];
  const P = new E.Planner(m, { today: TODAY });
  P.autoPlan();
  const it = P.items[0];
  const d = P.drafts.find((x) => x.itemKey === it.key);
  assert.ok(P.results[it.key].late > 0, '요청일 이틀 뒤라 늦어야 함');
  assert.equal(P.itemState(it).label, '가배정(지연)');
  // 다른 품목 일정과 겹치게 옮기면 거절
  const other = P.drafts.find((x) => x.itemKey !== it.key);
  const bad = P.updateDraft(d.id, { machine: other.machine, start: other.start });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /겹칩니다/);
  // 가공기간 늘리기 (뒤 가배정이 있으면 밀어냄)
  const ok = P.updateDraft(d.id, { days: d.days + 3, pushNext: true });
  assert.equal(ok.ok, true);
  assert.equal(d.end, d.start + d.days - 1);
  assert.equal(P.results[it.key].decision, '수기가배정');
  assert.ok(P.timeline.segments(d.machine).some((s) => s.draftId === d.id && s.e === d.end));
  // 지연 확인 → 상태 분리, 일정 바뀌면 다시 확인 필요
  assert.ok(P.ackLate(it.key, true));
  assert.equal(P.itemState(it).label, '지연확인');
  assert.equal(P.summary().lateAck, 1);
  P.updateDraft(d.id, { days: d.days + 1 });
  assert.equal(P.itemState(it).label, '가배정(지연)');
  // 담당자 조정분은 자동 재계산에도 유지
  P.clearAutoDrafts();
  P.autoPlan();
  assert.equal(P.drafts.filter((x) => x.itemKey === it.key).length, 1);

  // 뒤에 붙은 가배정을 밀고 연장
  const segs = P.timeline.segments(d.machine).filter((x) => x.kind === 'draft' && x.draftId !== d.id && x.s > d.end);
  if (segs.length) {
    const nextS = segs[0].s;
    const gap = nextS - d.end - 1;
    assert.equal(P.updateDraft(d.id, { days: d.days + gap + 1 }).ok, false);
    const r2 = P.updateDraft(d.id, { days: d.days + gap + 1, pushNext: true });
    assert.equal(r2.ok, true);
    const after = P.timeline.segments(d.machine).slice().sort((a, b) => a.s - b.s);
    for (let i = 1; i < after.length; i++) assert.ok(after[i].s > after[i - 1].effEnd);
  }
});

test('v670 수량 규칙: 배정대상수량 = 발주량 - 입고누계, 확정은 누적실적을 뺀 잔량', () => {
  const m = Demo.build(TODAY);
  m.raw = [
    { planNo: 'Q1', productCode: 'LMG100', partCode: 'BDLMG100AM-GP1', qty: 20000, received: 16260, reqDate: TODAY + 5, material: 'TK-1' },
    { planNo: 'Q2', productCode: 'X', partCode: 'PLDB777AR-B', qty: 0, need: 1500, reqDate: TODAY + 5, material: 'SK-4' },
    { planNo: 'Q3', productCode: 'Y', partCode: 'PLDB778AR-B', qty: 5000, received: 5000, reqDate: TODAY + 5, material: 'SK-4' },
    { planNo: 'Q4', productCode: 'Z', partCode: 'PLDB779AR-B', qty: 10000, received: 0, reqDate: TODAY + 5, material: 'SK-4' },
  ];
  m.confirmed = [{ planNo: 'Q4', productCode: 'Z', partCode: 'PLDB779AR-B', machine: '1', start: TODAY - 3, end: TODAY + 1, qty: 10000, actualQty: 4000 }];
  const items = E.buildItems(m, { baseDate: TODAY + 1 });
  assert.equal(items[0].openQty, 3740);
  assert.equal(items[0].machineDays, 3); // ceil(3740/3000)+1
  assert.equal(items[1].openQty, 1500); // 발주량 없으면 필요수량
  assert.equal(items[2].status, '입고완료');
  assert.equal(items[3].confirmedQty, 6000);
  assert.equal(items[3].status, '추가배정');
});

test('초기일정이관: 9번이 비어 있으면 일정관리 프로그램 설비1~A + 개시/완료를 현행 일정으로 사용', () => {
  const m = Demo.build(TODAY);
  m.confirmed = [];
  m.raw = [
    { planNo: 'I1', productCode: 'A', partCode: 'PLDB901AR-B', qty: 10001, received: 0, reqDate: TODAY + 20, material: 'SK-4', refMachines: ['3', '4'], progStart: TODAY - 2, progEnd: TODAY + 3 },
    { planNo: 'I2', productCode: 'B', partCode: 'PLDB902AR-B', qty: 5000, received: 0, reqDate: TODAY + 20, material: 'SK-4', refMachines: ['5'] },
  ];
  const P = new E.Planner(m, { today: TODAY });
  assert.equal(P.initial.used, true);
  assert.equal(P.initial.rows.length, 2);
  assert.deepEqual(P.initial.rows.map((r) => r.qty), [5001, 5000]);
  assert.equal(P.initial.skipped[0].reason, '개시/완료일 없음');
  assert.equal(P.items[0].status, '배정완료');
  assert.equal(P.timeline.gapStart('3', TODAY + 1, 1), TODAY + 4);
  P.autoPlan();
  assert.equal(P.confirmRows().filter((r) => r.initial).length, 2);
  // 9번에 일정이 있으면 초기이관을 쓰지 않는다
  assert.equal(new E.Planner(Demo.build(TODAY), { today: TODAY }).initial.used, false);
});

test('호기 다수 점유 품목: 호기 수를 줄여 기간을 늘리고, 검토 완료 표시', () => {
  const m = Demo.build(TODAY);
  m.raw = [{ planNo: 'H1', productCode: 'GX', partCode: 'TEGX901AM-DGP', qty: 300000, received: 0, reqDate: TODAY - 5, material: 'TK-B' }];
  const P = new E.Planner(m, { today: TODAY, maxMachines: 6, heavyMachines: 5 });
  P.autoPlan();
  const key = P.items[0].key;
  const before = P.drafts.filter((d) => d.itemKey === key);
  assert.equal(before.length, 6);
  assert.equal(P.isHeavy(key), true);
  const md = before.reduce((a, d) => a + d.days, 0);
  const res = P.reshapeItem(key, 3);
  assert.equal(res.ok, true);
  const after = P.drafts.filter((d) => d.itemKey === key);
  assert.equal(after.length, 3);
  assert.equal(after.reduce((a, d) => a + d.qty, 0), 300000);
  assert.equal(after.reduce((a, d) => a + d.days, 0), md);
  assert.ok(Math.max(...after.map((d) => d.end)) > Math.max(...before.map((d) => d.end)), '기간이 길어져야 함');
  assert.equal(P.isHeavy(key), false);
  assert.equal(P.results[key].decision, '수기가배정');
});

test('방 허용 확장: 규칙에 지정한 방도 후보가 되고, 1순위 방이 많이 밀릴 때 쓴다', () => {
  const m = Demo.build(TODAY);
  m.raw = [{ planNo: 'X1', productCode: 'DB', partCode: 'PLDB555C-B', qty: 6000, received: 0, reqDate: TODAY + 30, material: 'SK-4' }];
  // 1번방(SK) 전 호기를 40일 막아 둔다
  m.confirmed = m.machines.filter((x) => x.room === '1번방').map((x) => ({ planNo: 'Z', productCode: 'Z', partCode: 'PLZZ1AR-B', machine: x.no, start: TODAY, end: TODAY + 40, qty: 100 }));
  const strict = new E.Planner(m, { today: TODAY });
  strict.autoPlan();
  assert.equal(strict.groupOf[strict.drafts[0].machine], '1번방');
  const ext = new E.Planner(m, { today: TODAY, roomRules: 'SK 커터 = 4번방' });
  const c = ext.candidates(ext.items[0]).candidates;
  assert.ok(c.some((x) => x.ext && x.room === '4번방'));
  ext.autoPlan();
  assert.equal(ext.groupOf[ext.drafts[0].machine], '4번방');
  assert.ok(ext.drafts[0].start < strict.drafts[0].start);
});
