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

test('분산형: 한 품목은 방(조)마다 1대, 반 하루 신규셋팅 한도(인원 × 1인 한도) 준수', () => {
  const m = Demo.build(TODAY);
  // 반별 인원: 3_방마스터 '인원' 열 + 설정값(설정이 우선)
  m.rooms.forEach((r) => (r.headcount = 1));
  const P = new E.Planner(m, { today: TODAY, setupLimitPerWorkerDay: 2, roomHeadcount: E.parseRoomHeadcount('1번방 = 2') });
  assert.equal(P.roomSetupLimit('1번방'), 4);
  assert.equal(P.roomSetupLimit('2번방'), 2);
  assert.equal(new E.Planner(Demo.build(TODAY), { today: TODAY }).roomSetupLimit('1번방'), 0, '인원 미입력 반은 한도 없음');
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
  let checked = 0;
  for (const [k, v] of P.setupCount) {
    if (!k.startsWith('반 ') || Number(k.split('|')[1]) < TODAY + 1) continue;
    checked++;
    const lim = P.roomSetupLimit(k.slice(2).split('|')[0]);
    assert.ok(v <= lim, k + ' 신규셋팅 ' + v + '건 > 한도 ' + lim);
  }
  assert.ok(checked > 0);
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
  const P = new E.Planner(Demo.build(TODAY), { today: TODAY, setupLimitPerWorkerDay: 1, roomHeadcount: { '6번방': 1 } });
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
  // 담당자가 프로그램 설비1~A를 초기 이관 출처로 고른 경우에만
  assert.equal(new E.Planner(m, { today: TODAY }).initial.used, false);
  const P = new E.Planner(m, { today: TODAY, useProgramAssignments: true });
  assert.equal(P.transition, true);
  assert.equal(P.initial.used, true);
  assert.equal(P.initial.rows.length, 2);
  assert.deepEqual(P.initial.rows.map((r) => r.qty), [5001, 5000]);
  assert.equal(P.initial.skipped[0].reason, '개시/완료일 없음');
  assert.equal(P.items[0].status, '배정완료');
  assert.equal(P.timeline.gapStart('3', TODAY + 1, 1), TODAY + 4);
  P.autoPlan();
  assert.equal(P.initialRows().length, 2);
  assert.equal(P.confirmRows().filter((r) => r.initial).length, 0, '초기 이관 행은 가배정 결과와 따로');
  // 9번에 일정이 있으면 전환이 끝난 것: 초기 이관을 쓰지 않는다
  const done = new E.Planner(Demo.build(TODAY), { today: TODAY, useProgramAssignments: true, manualConfirmed: P.initial.rows });
  assert.equal(done.transition, false);
  assert.equal(done.initial.used, false);
  assert.equal(done.manualIgnored, 2);
  assert.equal(done.initialRows().length, 0);
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

test('근무일 달력: 토·일·휴일을 건너뛰고 근무일수로 완료일·빈 구간 계산', () => {
  // 2026-10-09(금) 한글날 휴일, 10-10/11 주말
  const cal = new E.Calendar({ workdays: true, holidays: [{ date: E.serialFromYMD(2026, 10, 9), note: '한글날' }] });
  const d = (m, dd) => E.serialFromYMD(2026, m, dd);
  assert.equal(cal.isWork(d(10, 8)), true);
  assert.equal(cal.isWork(d(10, 9)), false);
  assert.equal(cal.nextWork(d(10, 9)), d(10, 12));
  assert.equal(cal.finish(d(10, 7), 3), d(10, 12)); // 7,8,(9휴),(10,11주말),12
  assert.equal(cal.count(d(10, 5), d(10, 16)), 9);
  const tl = new E.Timeline([{ machine: '1', start: d(10, 13), end: d(10, 14), qty: 1 }], { today: d(10, 6), cal });
  assert.equal(tl.gapStart('1', d(10, 7), 3), d(10, 7)); // 7,8,12 → 13 전에 끝
  assert.equal(tl.gapStart('1', d(10, 7), 4), d(10, 15)); // 4일은 안 들어감
  const m = Demo.build(d(10, 6));
  m.holidays = [{ date: d(10, 9), note: '한글날' }];
  m.raw = [{ planNo: 'W1', productCode: 'A', partCode: 'PLDB301AR-B', qty: 20000, received: 0, reqDate: d(10, 30), material: 'SK-4' }];
  const P = new E.Planner(m, { today: d(10, 6) });
  assert.equal(P.cal.workdays, true);
  assert.equal(P.baseDate, d(10, 7));
  P.autoPlan();
  const x = P.drafts[0];
  assert.equal(x.end, P.cal.finish(x.start, x.days));
  assert.ok(P.cal.isWork(x.start));
  // 토요일 기준게시일 → 월요일
  assert.equal(new E.Planner(m, { today: d(10, 6), baseDate: d(10, 10) }).baseDate, d(10, 12));
});

test('재질호기제외: 28번 지정·전용구분 아세탈/BG 호기는 추천과 수기배정 모두 차단', () => {
  const m = Demo.build(TODAY);
  m.raw = [{ planNo: 'M1', productCode: 'A', partCode: 'PLDB401AR-B', qty: 5000, received: 0, reqDate: TODAY + 20, material: 'SK-4' }];
  m.matExclusions = [{ machine: '1', material: 'SK-4' }, { machine: '2', material: 'SK' }];
  m.machines.find((x) => x.no === '3').exclusiveType = '아세탈';
  const P = new E.Planner(m, { today: TODAY });
  const c = P.candidates(P.items[0]).candidates.map((x) => x.machine);
  for (const no of ['1', '2', '3']) assert.ok(!c.includes(no), no + '호기는 제외');
  assert.ok(c.includes('4'));
  assert.equal(P.checkMachines(P.items[0], ['1', '4']).length, 1);
  assert.match(P.checkMachines(P.items[0], ['999'])[0], /설비마스터에 없음/);
});

test('묶음배정: 같은 부품·재질 발주를 호기 1대에 발주일순으로 이어서', () => {
  const m = Demo.build(TODAY);
  m.raw = [
    { planNo: 'G1', productCode: 'A', partCode: 'PLDB701AR-B', qty: 4000, received: 0, orderDate: TODAY - 9, material: 'SK-4' },
    { planNo: 'G2', productCode: 'B', partCode: 'PLDB701AR-B', qty: 6000, received: 0, orderDate: TODAY - 5, material: 'SK-4' },
    { planNo: 'G3', productCode: 'C', partCode: 'PLDB701AR-B', qty: 5000, received: 0, orderDate: TODAY - 7, material: 'C1730' },
  ];
  const P = new E.Planner(m, { today: TODAY });
  const pool = P.poolCandidates(P.items[0]);
  assert.deepEqual(pool.map((x) => x.planNo), ['G1', 'G2']); // 재질 다른 G3 제외, 발주일순
  const r = P.poolAssign(pool, '4');
  assert.equal(r.ok, true);
  assert.equal(r.days, 3); // 올림(10000/5000)+1
  const ds = P.drafts.slice().sort((a, b) => a.start - b.start);
  assert.deepEqual(ds.map((d) => d.planNo), ['G1', 'G2']);
  assert.ok(ds[1].start > ds[0].end);
  assert.equal(ds.reduce((a, d) => a + d.days, 0), 3);
  assert.equal(P.confirmRows().find((x) => x.planNo === 'G2').newSetup, 'N'); // 이어서 가공 → 신규셋팅 아님
  assert.equal(P.poolAssign(pool, '4').ok, false); // 이미 배정됨
  const P2 = new E.Planner(m, { today: TODAY });
  assert.equal(P2.poolAssign(P2.poolCandidates(P2.items[0]), '4', 1).ok, false); // 하루로는 1만 개 불가
});

test('원본 세부행: 같은 계획/제품/부품 여러 행은 한 품목으로 합산', () => {
  const m = Demo.build(TODAY);
  m.confirmed = [];
  m.raw = [
    { planNo: 'S1', productCode: 'PS', partCode: 'PLDB601AR-B', qty: 20900, received: 0, reqDate: TODAY + 30, orderDate: TODAY - 5, material: 'SK-4', refMachines: ['3'] },
    { planNo: 'S1', productCode: 'PS', partCode: 'PLDB601AR-B', qty: 3300, received: 3300, reqDate: TODAY + 20, orderDate: TODAY - 9, material: 'SK-4', refMachines: ['4'] },
    { planNo: 'S1', productCode: 'PS', partCode: 'PLDB601AR-B', qty: 135800, received: 800, reqDate: TODAY + 40, material: 'SK-4', refMachines: ['3'] },
  ];
  const items = E.buildItems(m, { baseDate: TODAY + 1 });
  assert.equal(items.length, 1);
  const it = items[0];
  assert.equal(it.detailRows, 3);
  assert.equal(it.qty, 160000);
  assert.equal(it.openQty, 20900 + 135000);
  assert.equal(it.due, TODAY + 20);
  assert.equal(it.orderDate, TODAY - 9);
  assert.deepEqual(it.refMachines, ['3', '4']);
  assert.equal(it.dupOf, undefined);
});

test('원본 반복 붙여넣기(번호·발주량·입고량 동일)는 한 번만, 다른 세부번호는 합산 (v738 fix18)', () => {
  const m = Demo.build(TODAY);
  m.confirmed = [];
  const row = { planNo: 'R1', productCode: 'PR', partCode: 'PLDB602AR-B', lineNo: '1', qty: 965, received: 764, reqDate: TODAY + 30, material: 'SK-4', refMachines: [] };
  m.raw = [row, Object.assign({}, row), Object.assign({}, row, { lineNo: '2', qty: 1000, received: 0 })];
  const [it] = E.buildItems(m, { baseDate: TODAY + 1 });
  assert.equal(it.detailRows, 2);
  assert.equal(it.repeatRows, 1);
  assert.equal(it.qty, 1965);
  assert.equal(it.openQty, 201 + 1000);
});

test('발주별로 나눈 9번 행: 같은 날 시작하면 늦게 끝나는 행이 현재 작업, 간트는 막대 하나', () => {
  const m = Demo.build(TODAY);
  m.raw = [
    { planNo: 'Q1', productCode: 'PQ', partCode: 'PLDB603AR-B', qty: 1500, received: 0, reqDate: TODAY + 30, material: 'SK-4', refMachines: [] },
    { planNo: 'Q2', productCode: 'PQ', partCode: 'PLDB603AR-B', qty: 4600, received: 0, reqDate: TODAY + 30, material: 'SK-4', refMachines: [] },
  ];
  m.confirmed = [
    { planNo: 'Q1', productCode: 'PQ', partCode: 'PLDB603AR-B', machine: '3', start: TODAY - 4, end: TODAY - 4, qty: 1500 },
    { planNo: 'Q2', productCode: 'PQ', partCode: 'PLDB603AR-B', machine: '3', start: TODAY - 4, end: TODAY + 1, qty: 4600 },
  ];
  const P = new E.Planner(m, { today: TODAY });
  assert.equal(P.timeline.status('3').delayed, false);
  assert.equal(P.timeline.status('3').latest.planNo, 'Q2');
  const g = P.timeline.displaySegments('3');
  assert.equal(g.length, 1);
  assert.equal(g[0].segs.length, 2);
  assert.equal(g[0].qty, 6100);
  assert.equal(g[0].e, TODAY + 1);
});

test('반별 인원·1인 한도가 날짜별로 늘어나면 그날부터 한도가 커진다', () => {
  const m = Demo.build(TODAY);
  const ymd = (d) => E.fmtYMD(d);
  const plan = E.parseSetupPlan(['1번방 = 1', '2번방 = 1', '3번방 = 1', '4번방 = 1', '5번방 = 1', '6번방 = 1', '6번방 = 3 (' + ymd(TODAY + 10) + '부터)', '1인 = 2 @' + ymd(TODAY + 20), '엉터리 줄'].join('\n'), TODAY);
  assert.deepEqual(plan.bad, ['엉터리 줄']);
  const P = new E.Planner(m, { today: TODAY, setupLimitPerWorkerDay: 1, setupPlan: plan });
  assert.equal(P.roomSetupLimit('6번방', TODAY + 9), 1);
  assert.equal(P.roomSetupLimit('6번방', TODAY + 10), 3);
  assert.equal(P.roomSetupLimit('6번방', TODAY + 20), 6);
  assert.equal(P.roomSetupLimit('1번방', TODAY + 20), 2);
  assert.deepEqual(P.setupChanges().map((c) => [c.room, c.n]), [['6번방', 3], [null, 2]]);
  P.autoPlan();
  for (const d of P.drafts) {
    if (P._isContinuation(d.machine, d.start, d.partCode)) continue;
    const lim = P.roomSetupLimit(P.groupOf[d.machine], d.start);
    assert.ok(P.setupsOn(d.machine, d.start) <= lim, d.machine + ' ' + ymd(d.start) + ' 셋팅 ' + P.setupsOn(d.machine, d.start) + ' > ' + lim);
  }
  // 월/일만 쓰면 두 달 넘게 지난 날짜는 다음 해
  assert.equal(E.parseSetupPlan('1번방 = 2 (1/5부터)', E.serialFromYMD(2026, 10, 26)).rooms['1번방'][0].from, E.serialFromYMD(2027, 1, 5));
});

test('수기 지정호기 (v738 fix21): 희망 시작일, 완료확인 필요 호기는 현장 확인 시 실제 빈 구간만', () => {
  const m = Demo.build(TODAY);
  m.holidays = [];
  m.raw = [{ planNo: 'F1', productCode: 'PF', partCode: 'PLDB801AR-B', qty: 10000, received: 0, reqDate: TODAY + 30, material: 'SK-4', refMachines: [] }];
  m.confirmed = [
    // 3호기: 지난 일정 실적 미입력(완료확인 필요) + 뒤에 확정 일정
    { planNo: 'X1', productCode: 'PX', partCode: 'PLDB802AR-B', machine: '3', start: TODAY - 6, end: TODAY - 2, qty: 5000 },
    { planNo: 'X2', productCode: 'PX', partCode: 'PLDB803AR-B', machine: '3', start: TODAY + 4, end: TODAY + 6, qty: 5000 },
  ];
  const P = new E.Planner(m, { today: TODAY, calendarMode: 'calendar' });
  const it = P.items[0];
  assert.equal(P.timeline.status('3').delayed, true);
  assert.deepEqual(P.checkMachines(it, ['3']), ['3호기: 완료확인 필요 (9번 실적 입력)']);
  assert.deepEqual(P.checkMachines(it, ['3'], { allowDelayed: true }), []);
  assert.deepEqual(P.delayedMachines(['3', '4']), ['3']);
  assert.equal(P.allocate(['3'], 4000, 2, TODAY + 1, it.partCode), null, '확인 없이는 배정 불가');
  const a = P.manualAssign(it, ['3'], { qty: 4000, days: 2, from: TODAY + 1, release: ['3'] });
  assert.deepEqual([a[0].start, a[0].end, a[0].released], [TODAY + 1, TODAY + 2, true]);
  assert.match(P.confirmRows()[0].note, /실적완료 미확인 \/ 일정충돌 없음/);
  // 희망 시작일: 그날 이후의 빈 구간 (뒤 확정 일정과 겹치면 그 뒤로)
  const b = P.manualAssign(it, ['4'], { qty: 2000, days: 3, from: TODAY + 10 });
  assert.equal(b[0].start, TODAY + 10);
  assert.equal(P.checkDesiredStart(TODAY), '희망 시작일은 오늘 이후 날짜로 입력하세요');
  assert.equal(P.checkDesiredStart(TODAY + 3), '');
  // 3호기는 여전히 자동배정 후보에서는 완료확인 필요
  assert.equal(P.timeline.status('3').delayed, true);
});
