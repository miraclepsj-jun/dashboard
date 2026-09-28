const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const E = require('../src/engine.js');
const W = require('../src/workbook.js');
const Demo = require('../src/demo.js');

const TODAY = E.serialFromYMD(2026, 9, 28);

// 기존 통합문서와 같은 시트/헤더 구조의 가상 파일을 만든다
function demoWorkbook() {
  const m = Demo.build(TODAY);
  const wb = XLSX.utils.book_new();
  const add = (name, aoa) => XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name);
  const rawHead = [null, '승인', '발주일', '번호', '계획번호', '코드', '제품코드', '부품코드', '발주량', '입고일', '입고량', '요청일', '도금', '공정순서', 'H2치수', '개시', '완료', '종료', '작업장', '일정'];
  const raw = [rawHead.concat(new Array(24).fill(null), ['재질', '특별(납기)_x000D_\n관리 여부'])];
  raw[0][31] = '설비1';
  for (const r of m.raw) {
    const row = new Array(46).fill(null);
    Object.assign(row, { 4: r.planNo, 6: r.productCode, 7: r.partCode, 8: r.qty, 11: r.reqDate, 18: r.workArea, 44: r.material, 45: r.special });
    raw.push(row);
  }
  add('1_원본붙여넣기', raw);
  add('3_방마스터', [['방', '기본소재계열', '우선생산성분류', '허용대분류', '특수방여부', '특수대상시리즈', '자동후보사용']].concat(m.rooms.map((r) => [r.name, r.matGroup, r.prodClass, r.mainAllowed, r.special, r.series || '', r.autoUse])));
  add('4_설비마스터', [['호기', '방', '원본시트', '소재', '기종', '컷터', '기본운영', '일정표기대상', '전용장비여부', '전용구분', 'BD가공가능', 'BD최소외경', 'BD최대외경', 'BD최대길이', 'PL가공가능', 'TE가공가능', '신규셋팅가능']].concat(m.machines.map((x) => [Number(x.no), x.room, '', x.material, x.model, x.cutter, '', 'Y', '', '', x.bdOk, x.bdMin, x.bdMax, x.bdMaxLen, 'Y', 'Y', 'Y'])));
  const rules = [['우선순위', '조건/키워드', '검색방식', '세부분류', '생산성분류', '설명', '적용여부']].concat(m.rules.map((r) => [Number(r.priority), r.keyword, r.method, r.detail, r.prod, '', 'Y']));
  rules.push([], ['부품군', '최소외경', '최대외경', '가능기종'], ['BD', 0.6, 0.79, 'P033H/P034']);
  add('5_생산성분류', rules);
  add('6_생산성기준', [['품목군', '기준_일생산량', '최소', '최대', '여유일적용']].concat(m.productivity.map((p) => [p.cls, p.daily, null, null, p.buffer])));
  add('9_설비배정_확정', [W.CONFIRM_HEADERS].concat(m.confirmed.map((c) => [c.planNo, c.productCode, c.partCode, Number(c.machine), c.start, c.end, c.qty, 'Y', '', '', '', '', '', c.actualDate || null, c.actualQty || null, c.actualOk || null])));
  add('13_작업자운영마스터', [['호기', '담당작업자', '방', '상태구분', '시작일', '종료일', '신규세팅금지']].concat(m.workers.map((w) => [Number(w.machine), w.worker, w.room, w.status, w.start, w.end, w.noSetup])));
  add('21_BD규격마스터', [['부품명', 'BD외경', 'BD길이', '비고', '상태']].concat(m.bdSpecs.map((b) => [b.part, b.od, b.len])));
  return { buf: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), m };
}

test('통합문서 읽기: 시트/헤더 이름으로 모델 구성', () => {
  const { buf, m } = demoWorkbook();
  const { model, warnings } = W.readWorkbook(buf);
  assert.deepEqual(warnings, []);
  assert.equal(model.raw.length, m.raw.length);
  assert.equal(model.raw[0].partCode, m.raw[0].partCode);
  assert.equal(model.raw[0].reqDate, m.raw[0].reqDate);
  assert.equal(model.machines.length, m.machines.length);
  assert.equal(model.rules.length, m.rules.length, '아래쪽 BD 보조표는 규칙이 아님');
  assert.equal(model.confirmed.length, m.confirmed.length);
  assert.equal(model.workers.find((w) => w.status === '고장').end, TODAY + 3);
  const P = new E.Planner(model, { today: TODAY });
  const Q = new E.Planner(m, { today: TODAY });
  P.autoPlan();
  Q.autoPlan();
  assert.deepEqual(P.summary(), Q.summary());
});

test('클립보드 붙여넣기(TSV) 헤더 인식', () => {
  const text = ['승인\t계획번호\t제품코드\t부품코드\t발주량\t요청일\t재질', '\t260901-001\tDB1\tPLDB1AR-B\t"1,200"\t2026-10-05\tSK-4', '\t260901-002\tGX2\tTEGX2AM-D\t3000\t10/7\tTK-B'].join('\n');
  const rows = W.parsePastedText(text);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].planNo, '260901-001');
  assert.equal(rows[0].reqDate, E.serialFromYMD(2026, 10, 5));
  assert.equal(rows[1].material, 'TK-B');
  assert.equal(rows[1].qty, 3000);
});

test('결과 통합문서: 시트 4개, 9번 붙여넣기 17열', () => {
  const { buf } = demoWorkbook();
  const { model } = W.readWorkbook(buf);
  const P = new E.Planner(model, { today: TODAY });
  P.autoPlan();
  const wb = W.buildExportWorkbook(P, {});
  assert.deepEqual(wb.SheetNames, ['9번확정_붙여넣기', '프로그램입력요약', '품목별결과', '간트(▶가배정)']);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets['9번확정_붙여넣기'], { header: 1 });
  assert.equal(rows[0].length, 17);
  assert.equal(rows.length - 1, P.drafts.length);
});
