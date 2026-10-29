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

test('설비1~A: 날짜 일련번호 등 호기가 아닌 값은 빼고 따로 알림', () => {
  const text = ['승인\t계획번호\t제품코드\t부품코드\t발주량\t요청일\t재질\t설비1\t설비2\t설비3', '\t260825-035\tGX\tTEGX1957AM-TGPC\t1000\t2026-10-05\tSK-4\t46155\t121\t121호기'].join('\n');
  const [r] = W.parsePastedText(text);
  assert.deepEqual(r.refMachines, ['121']);
  assert.deepEqual(r.eqBad, ['46155']);
});

test('시트 붙여넣기 (사내망 문서보안 대응): 따옴표 셀, 표시값 숫자·날짜, 시트 자동 판정', () => {
  // 엑셀은 줄바꿈이 든 셀을 "..."로 감싸서 복사한다
  assert.deepEqual(W.parseTSV('a\t"특별(납기)\n관리 여부"\tc\n1\t"x""y"\t\n'), [['a', '특별(납기)\n관리 여부', 'c'], ['1', 'x"y', null]]);
  const mc = ['호기\t방\t원본시트\t소재\t기종\tBD최소외경\tPL가공가능', '1\t1번방\tSK\t\tP033H\t0.6\tY', '0012\t2번방\t\t\tP033\t"1,200"\tN'].join('\n');
  assert.equal(W.guessPastedSheet(mc), 'machines');
  const ms = W.readPastedSheet('machines', mc);
  assert.equal(ms[0].bdMin, 0.6);
  assert.equal(ms[1].bdMin, 1200);
  // 9번: 연도 없는 m/d 날짜, 완료일이 시작일보다 앞서면 다음 해
  const cf = [W.CONFIRM_HEADERS.join('\t'), ['P1', 'C1', 'PLDB1AR-B', '7', '12/28/26', '1/5', '1,000'].join('\t')].join('\n');
  assert.equal(W.guessPastedSheet(cf), 'confirmed');
  const [r] = W.readPastedSheet('confirmed', cf);
  assert.equal(r.start, E.serialFromYMD(2026, 12, 28));
  assert.equal(r.end - r.start, 8, '1/5는 다음 해');
  assert.equal(r.qty, 1000);
  // 날짜 서식이 걸린 설비 칸("05월 10일")은 호기로 쓰지 않음
  const raw = ['계획번호\t제품코드\t부품코드\t발주량\t발주일\t설비1\t설비2', 'A1\tP\tPLDB1AR-B\t"2,000"\t2/24/26\t05월 10일\t131'].join('\n');
  const [rr] = W.readPastedSheet('raw', raw);
  assert.deepEqual([rr.qty, rr.orderDate, rr.refMachines, rr.eqBad], [2000, E.serialFromYMD(2026, 2, 24), ['131'], ['05월 10일']]);
  assert.equal(W.guessPastedSheet('아무 글자\n1\t2'), null);
});

test('날짜 문자열: yyyy-mm-dd, m/d/yy, yy-mm-dd, 한글 월일', () => {
  const ymd = (v) => E.fmtYMD(E.toSerial(v));
  assert.equal(ymd('2026-02-24'), '2026-02-24');
  assert.equal(ymd('2/24/26'), '2026-02-24');
  assert.equal(ymd('26-02-24'), '2026-02-24');
  assert.equal(ymd('2026년 2월 24일'), '2026-02-24');
  assert.equal(ymd('12/31/2026'), '2026-12-31');
  assert.equal(E.toSerial('abc'), null);
});

test('엑셀 매크로 묶음 붙여넣기(CNC_WebCopy_All): 시트 여러 개를 셀 값 그대로 한 번에', () => {
  const { buf } = demoWorkbook();
  const { model } = W.readWorkbook(buf);
  const wb = XLSX.read(buf, { type: 'buffer' });
  // 매크로와 같은 형식: "##CNC_SHEET<탭>시트이름" 줄 + A1부터 Value2(날짜=일련번호, 호기=숫자)를 탭으로
  const cell = (v) => (v == null ? '' : /[\t\n"]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v));
  const bundle = wb.SheetNames.map((n) => '##CNC_SHEET\t' + n + '\n' + XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: null }).map((r) => r.map(cell).join('\t')).join('\n')).join('\n');
  const got = W.readPastedBundle(bundle);
  assert.equal(got.length, wb.SheetNames.length);
  for (const b of got) {
    assert.ok(b.key, b.name + ' 시트 판정');
    // 빈 문자열 칸과 빈 칸은 같은 것으로 본다 (테스트용 통합문서는 빈 칸에 ''를 넣어 만듦)
    const norm = (x) => JSON.parse(JSON.stringify(x, (k, v) => (v === '' ? null : v)));
    assert.deepEqual(norm(b.rows), norm(model[b.key]), b.name + ' 내용이 파일 읽기와 같아야 함');
  }
  assert.equal(W.readPastedBundle('그냥 붙여넣은 글자'), null);
  assert.equal(W.sheetKeyOf('2_원본정리'), null);
});
