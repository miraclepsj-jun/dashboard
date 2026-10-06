/*
 * 엑셀(.xlsm/.xlsx) ↔ 엔진 모델 변환.
 * 기존 "CNC 생산계획 자동화" 통합문서의 시트/헤더 이름을 기준으로 읽는다.
 * 시트 번호가 바뀌어도 이름 끝부분(예: "설비마스터")으로 찾는다.
 * SheetJS(XLSX 전역 또는 require('xlsx'))가 필요하다.
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CNCWorkbook = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  const E = typeof module === 'object' && module.exports ? require('./engine.js') : root.CNCEngine;
  const getXLSX = () => (root && root.XLSX) || (typeof require === 'function' ? require('xlsx') : null);
  const { toSerial, toNum, str } = E;

  const SHEETS = {
    raw: '원본붙여넣기',
    rooms: '방마스터',
    machines: '설비마스터',
    rules: '생산성분류',
    productivity: '생산성기준',
    workers: '작업자운영마스터',
    bgRules: 'BG전용기준',
    bdSpecs: 'BD규격마스터',
    confirmed: '설비배정_확정',
  };

  function norm(h) {
    return String(h == null ? '' : h)
      .replace(/_x000D_/g, '')
      .replace(/[\s\r\n]+/g, '')
      .trim();
  }

  function findSheet(wb, base) {
    const names = wb.SheetNames;
    return names.find((n) => n === base) || names.find((n) => n.replace(/^\d+_/, '') === base) || names.find((n) => n.endsWith(base)) || null;
  }

  function sheetRows(wb, name) {
    const XLSX = getXLSX();
    const ws = wb.Sheets[name];
    if (!ws) return [];
    return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: true });
  }

  /** 헤더행(앞 10행 중 keyHeader 포함)을 찾아 {이름: 열번호} 맵과 데이터행 반환. */
  function headerMap(rows, keyHeader) {
    for (let r = 0; r < Math.min(rows.length, 10); r++) {
      const row = rows[r] || [];
      const idx = row.findIndex((v) => norm(v) === norm(keyHeader));
      if (idx >= 0) {
        const map = {};
        const all = {};
        row.forEach((v, c) => {
          const k = norm(v);
          if (!k) return;
          if (map[k] == null) map[k] = c;
          (all[k] = all[k] || []).push(c);
        });
        return { map, all, start: r + 1 };
      }
    }
    return null;
  }
  function col(hm, ...names) {
    for (const n of names) {
      const c = hm.map[norm(n)];
      if (c != null) return c;
    }
    return -1;
  }
  const at = (row, c) => (c >= 0 && row ? row[c] : null);

  // ───────────── 원본(일정관리 프로그램 복사분) ─────────────
  // 헤더가 없을 때 쓰는 고정 위치 (기존 매크로: E/G/H/I/L/O/S/AS/AT, 설비1~A = AF~AO)
  // 입고량 K/AB, 필요수량 U, 개시 P, 완료 Q, 종료 R (v670 초기이관·미납잔량 기준)
  const RAW_FIXED = { orderDate: 2, planNo: 4, productCode: 6, partCode: 7, qty: 8, received: [10, 27], need: 20, open: 15, finish: 16, close: 17, reqDate: 11, h2: 14, workArea: 18, schedule: 19, material: 44, special: 45, eq: [31, 32, 33, 34, 35, 36, 37, 38, 39, 40] };

  function rawColumns(rows) {
    const hm = headerMap(rows, '부품코드');
    if (!hm) return { cols: RAW_FIXED, start: 0 };
    const eq = ['설비1', '설비2', '설비3', '설비4', '설비5', '설비6', '설비7', '설비8', '설비9', '설비A'].map((n) => col(hm, n));
    const special = Object.keys(hm.map).find((k) => k.startsWith('특별'));
    return {
      start: hm.start,
      cols: {
        orderDate: col(hm, '발주일', '발주일자'),
        planNo: col(hm, '계획번호'),
        productCode: col(hm, '제품코드'),
        partCode: col(hm, '부품코드'),
        qty: col(hm, '발주량', '발주수량', '수량'),
        received: hm.all[norm('입고량')] || [],
        need: col(hm, '필요수량'),
        open: col(hm, '개시'),
        finish: col(hm, '완료'),
        close: col(hm, '종료'),
        reqDate: col(hm, '요청일', '납기', '납기일'),
        h2: col(hm, 'H2치수'),
        workArea: col(hm, '작업장'),
        schedule: col(hm, '일정'),
        material: col(hm, '재질'),
        special: special ? hm.map[special] : -1,
        eq,
      },
    };
  }

  function parseRawRows(rows) {
    const { cols, start } = rawColumns(rows);
    const out = [];
    for (let r = start; r < rows.length; r++) {
      const row = rows[r];
      if (!row) continue;
      const planNo = str(at(row, cols.planNo));
      const productCode = str(at(row, cols.productCode));
      const partCode = str(at(row, cols.partCode));
      if (!planNo && !productCode && !partCode) continue;
      if (partCode === '부품코드') continue;
      out.push({
        row: r + 1,
        planNo,
        productCode,
        partCode,
        qty: toNum(at(row, cols.qty)),
        // 입고누계: 입고량 열이 둘(K/AB)이면 큰 값 (v670 RawReceivedQty)
        received: Math.max(0, ...cols.received.map((c) => toNum(at(row, c)))),
        need: toNum(at(row, cols.need)),
        progStart: toSerial(at(row, cols.open)),
        progEnd: toSerial(at(row, cols.finish)) != null ? toSerial(at(row, cols.finish)) : toSerial(at(row, cols.close)),
        reqDate: toSerial(at(row, cols.reqDate)),
        orderDate: toSerial(at(row, cols.orderDate)),
        h2: at(row, cols.h2),
        workArea: str(at(row, cols.workArea)),
        schedule: str(at(row, cols.schedule)),
        material: str(at(row, cols.material)),
        special: str(at(row, cols.special)),
        refMachines: cols.eq.map((c) => at(row, c)).filter((v) => v != null && str(v) !== '').map((v) => E.machineNo(v)),
      });
    }
    return out;
  }

  /** 클립보드 붙여넣기 텍스트(TSV) → 원본 행. */
  function parsePastedText(text) {
    const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    const rows = lines.map((l) => (l === '' ? [] : l.split('\t').map((v) => (v === '' ? null : v))));
    // 엑셀에서 복사한 "1,234" 형태 숫자 정리는 toNum이 처리
    return parseRawRows(rows);
  }

  // ───────────── 마스터 ─────────────
  function readRooms(rows) {
    const hm = headerMap(rows, '방');
    if (!hm) return [];
    const c = {
      name: col(hm, '방'),
      basicGroup: col(hm, '기본운영품목군'),
      recGroup: col(hm, '추천품목군'),
      concept: col(hm, '운영개념'),
      priority: col(hm, '일정추천우선순위'),
      opType: col(hm, '운영구분'),
      matGroup: col(hm, '기본소재계열'),
      prodClass: col(hm, '우선생산성분류'),
      mainAllowed: col(hm, '허용대분류'),
      special: col(hm, '특수방여부'),
      series: col(hm, '특수대상시리즈'),
      drawingRule: col(hm, '치수/도면확인조건'),
      autoUse: col(hm, '자동후보사용'),
    };
    return rows
      .slice(hm.start)
      .filter((r) => r && str(at(r, c.name)))
      .map((r) => {
        const o = {};
        for (const k of Object.keys(c)) o[k] = k === 'name' ? str(at(r, c[k])) : at(r, c[k]);
        return o;
      });
  }

  function readMachines(rows) {
    const hm = headerMap(rows, '호기');
    if (!hm) return [];
    const c = {
      no: col(hm, '호기'),
      room: col(hm, '방'),
      sourceSheet: col(hm, '원본시트'),
      material: col(hm, '소재', '현재소재'),
      model: col(hm, '기종'),
      cutter: col(hm, '컷터'),
      basicOp: col(hm, '기본운영'),
      scheduleTarget: col(hm, '일정표기대상'),
      exclusive: col(hm, '전용장비여부'),
      exclusiveType: col(hm, '전용구분'),
      bdOk: col(hm, 'BD가공가능'),
      bdMin: col(hm, 'BD최소외경'),
      bdMax: col(hm, 'BD최대외경'),
      bdMaxLen: col(hm, 'BD최대길이'),
      plOk: col(hm, 'PL가공가능'),
      teOk: col(hm, 'TE가공가능'),
      newSetupOk: col(hm, '신규셋팅가능', '신규세팅가능'),
      memo: col(hm, '비고'),
      group: col(hm, '조', '작업조', '담당조', '반'),
    };
    return rows
      .slice(hm.start)
      .filter((r) => r && at(r, c.no) != null && str(at(r, c.no)) !== '')
      .map((r) => {
        const o = {};
        for (const k of Object.keys(c)) o[k] = at(r, c[k]);
        o.no = E.machineNo(o.no);
        o.room = str(o.room);
        return o;
      });
  }

  function readRules(rows) {
    const hm = headerMap(rows, '조건/키워드');
    if (!hm) return [];
    const c = {
      priority: col(hm, '우선순위'),
      keyword: col(hm, '조건/키워드', '키워드'),
      method: col(hm, '검색방식'),
      detail: col(hm, '세부분류'),
      prod: col(hm, '생산성분류', '자동분류'),
      desc: col(hm, '설명'),
      active: col(hm, '적용여부'),
    };
    const out = [];
    for (let r = hm.start; r < rows.length; r++) {
      const row = rows[r];
      if (!row) continue;
      // 아래쪽 BD 외경별 가능기종 보조표는 헤더 '부품군'부터 시작 - 거기서 중단
      if (norm(at(row, 0)) === '부품군') break;
      if (!str(at(row, c.keyword))) continue;
      out.push({
        priority: at(row, c.priority),
        keyword: str(at(row, c.keyword)),
        method: str(at(row, c.method)),
        detail: str(at(row, c.detail)),
        prod: str(at(row, c.prod)),
        desc: str(at(row, c.desc)),
        active: c.active >= 0 ? str(at(row, c.active)) : null,
      });
    }
    return out;
  }

  function readProductivity(rows) {
    const hm = headerMap(rows, '기준_일생산량') || headerMap(rows, '품목군');
    if (!hm) return [];
    const cCls = col(hm, '생산성분류', '품목군', '품목분류', '세부분류');
    const cQty = col(hm, '기준_일생산량', '일생산량', '기준수량');
    const cBuf = col(hm, '세팅추가일', '셋팅추가일', '여유일', '여유일적용', '여유일수', '추가일', '가산일', '셋업가산일', '세업가산일', '셋업여유일', '세업여유일');
    const cMin = col(hm, '최소');
    const cMax = col(hm, '최대');
    const cNote = col(hm, '비고');
    return rows
      .slice(hm.start)
      .filter((r) => r && str(at(r, cCls)))
      .map((r) => ({ cls: str(at(r, cCls)), daily: toNum(at(r, cQty)), buffer: at(r, cBuf), min: at(r, cMin), max: at(r, cMax), note: str(at(r, cNote)) }));
  }

  function readWorkers(rows) {
    const hm = headerMap(rows, '호기');
    if (!hm) return [];
    const c = { machine: col(hm, '호기'), worker: col(hm, '담당작업자'), room: col(hm, '방'), status: col(hm, '상태구분'), start: col(hm, '시작일'), end: col(hm, '종료일'), noSetup: col(hm, '신규세팅금지'), note: col(hm, '비고'), group: col(hm, '조', '작업조', '담당조', '반') };
    return rows
      .slice(hm.start)
      .filter((r) => r && str(at(r, c.machine)))
      .map((r) => ({
        machine: E.machineNo(at(r, c.machine)),
        worker: str(at(r, c.worker)),
        room: str(at(r, c.room)),
        status: str(at(r, c.status)),
        start: toSerial(at(r, c.start)),
        end: toSerial(at(r, c.end)),
        noSetup: str(at(r, c.noSetup)),
        note: str(at(r, c.note)),
        group: str(at(r, c.group)),
      }));
  }

  function readBGRules(rows) {
    const hm = headerMap(rows, 'BG최소외경');
    if (!hm) return [];
    const c = { room: col(hm, '방'), odMin: col(hm, 'BG최소외경'), odMax: col(hm, 'BG최대외경'), cond: col(hm, '조건') };
    return rows
      .slice(hm.start)
      .filter((r) => r && str(at(r, c.room)))
      .map((r) => ({ room: str(at(r, c.room)), odMin: at(r, c.odMin), odMax: at(r, c.odMax), cond: str(at(r, c.cond)) }));
  }

  function readBDSpecs(rows) {
    const hm = headerMap(rows, 'BD외경');
    if (!hm) return [];
    const c = { part: col(hm, '부품명', '부품코드'), od: col(hm, 'BD외경'), len: col(hm, 'BD길이'), note: col(hm, '비고') };
    return rows
      .slice(hm.start)
      .filter((r) => r && str(at(r, c.part)))
      .map((r) => ({ part: str(at(r, c.part)), od: at(r, c.od), len: at(r, c.len), note: str(at(r, c.note)) }));
  }

  const CONFIRM_HEADERS = ['계획번호', '제품코드', '부품코드', '배정호기', '시작일', '완료일', '수량', '신규세팅여부', '담당작업자', '세팅가능확인', '간트표시', '비고', '검토결과', '최근실적일', '누적실적', '실적확인', '실적비고'];

  function readConfirmed(rows) {
    const hm = headerMap(rows, '배정호기');
    if (!hm) return [];
    const c = {
      planNo: col(hm, '계획번호'),
      productCode: col(hm, '제품코드'),
      partCode: col(hm, '부품코드'),
      machine: col(hm, '배정호기'),
      start: col(hm, '시작일'),
      end: col(hm, '완료일'),
      qty: col(hm, '수량'),
      newSetup: col(hm, '신규세팅여부'),
      worker: col(hm, '담당작업자'),
      note: col(hm, '비고'),
      review: col(hm, '검토결과'),
      actualDate: col(hm, '최근실적일'),
      actualQty: col(hm, '누적실적'),
      actualOk: col(hm, '실적확인'),
      actualNote: col(hm, '실적비고'),
    };
    const out = [];
    for (let r = hm.start; r < rows.length; r++) {
      const row = rows[r];
      if (!row || at(row, c.machine) == null || str(at(row, c.machine)) === '') continue;
      const start = toSerial(at(row, c.start));
      out.push({
        row: r + 1,
        planNo: str(at(row, c.planNo)),
        productCode: str(at(row, c.productCode)),
        partCode: str(at(row, c.partCode)),
        machine: E.machineNo(at(row, c.machine)),
        start,
        end: toSerial(at(row, c.end)),
        qty: toNum(at(row, c.qty)),
        newSetup: str(at(row, c.newSetup)),
        worker: str(at(row, c.worker)),
        note: str(at(row, c.note)),
        review: str(at(row, c.review)),
        actualDate: toSerial(at(row, c.actualDate), start ? E.dateFromSerial(start).getFullYear() : undefined),
        actualQty: toNum(at(row, c.actualQty)),
        actualOk: str(at(row, c.actualOk)),
        actualNote: str(at(row, c.actualNote)),
      });
    }
    return out;
  }

  /** 통합문서 → 엔진 모델. 누락 시트는 warnings에 기록. */
  function readWorkbook(data) {
    const XLSX = getXLSX();
    const wb = XLSX.read(data, { type: data instanceof ArrayBuffer || ArrayBuffer.isView(data) ? 'array' : 'buffer', cellDates: false, bookVBA: false });
    const model = { raw: [], rooms: [], machines: [], rules: [], productivity: [], workers: [], bgRules: [], bdSpecs: [], confirmed: [] };
    const warnings = [];
    const found = {};
    const readers = { raw: parseRawRows, rooms: readRooms, machines: readMachines, rules: readRules, productivity: readProductivity, workers: readWorkers, bgRules: readBGRules, bdSpecs: readBDSpecs, confirmed: readConfirmed };
    for (const [k, base] of Object.entries(SHEETS)) {
      const name = findSheet(wb, base);
      found[k] = name;
      if (!name) {
        if (['rooms', 'machines', 'rules', 'productivity'].includes(k)) warnings.push('필수 시트 없음: ' + base);
        continue;
      }
      model[k] = readers[k](sheetRows(wb, name));
    }
    if (found.machines && !model.machines.length) warnings.push('설비마스터에서 호기를 읽지 못했습니다 (헤더 "호기" 확인)');
    return { model, warnings, sheets: found };
  }

  // ───────────── 내보내기 ─────────────
  function dateCell(serial) {
    return serial == null ? null : { t: 'n', v: serial, z: 'yyyy-mm-dd' };
  }

  function aoaSheet(aoa, widths) {
    const XLSX = getXLSX();
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    if (widths) ws['!cols'] = widths.map((w) => ({ wch: w }));
    ws['!freeze'] = { xSplit: 0, ySplit: 1 };
    return ws;
  }

  /**
   * 결과 통합문서 생성.
   * planner: Engine.Planner, opts.ganttDays: 간트 표시 일수
   */
  function buildExportWorkbook(planner, opts) {
    const XLSX = getXLSX();
    opts = opts || {};
    const wb = XLSX.utils.book_new();

    // 1) 9번 확정시트 붙여넣기용
    const conf = [CONFIRM_HEADERS.slice()];
    for (const r of planner.confirmRows()) {
      conf.push([r.planNo, r.productCode, r.partCode, r.machine, dateCell(r.start), dateCell(r.end), r.qty, r.newSetup, r.worker, null, null, r.note, null, null, null, null, null]);
    }
    XLSX.utils.book_append_sheet(wb, aoaSheet(conf, [12, 20, 20, 8, 11, 11, 9, 8, 10, 8, 8, 44, 8, 10, 8, 8, 10]), '9번확정_붙여넣기');

    // 2) 일정관리 프로그램 입력요약 (설비1~A)
    const eqHeads = ['설비1', '설비2', '설비3', '설비4', '설비5', '설비6', '설비7', '설비8', '설비9', '설비A'];
    const prog = [['계획번호', '제품코드', '게시일', '완료일'].concat(eqHeads, ['비고'])];
    for (const p of planner.programSummary()) {
      const eq = eqHeads.map((_, i) => (p.machines[i] != null ? p.machines[i] : null));
      prog.push([p.planNo, p.productCode, dateCell(p.start), dateCell(p.end)].concat(eq, [p.note]));
    }
    XLSX.utils.book_append_sheet(wb, aoaSheet(prog, [12, 20, 11, 11, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 30]), '프로그램입력요약');

    // 3) 품목별 결과 (전체)
    const res = [['상태', '판정사유', '계획번호', '제품코드', '부품코드', '발주량', '기존확정', '가배정수량', '잔량', '요청일', '예상완료', '대분류', '생산성분류', '재질', '일생산량', '필요장비일수', '권장대수', '가배정호기']];
    for (const it of planner.items) {
      if (it.dupOf != null) continue;
      const st = planner.itemState(it);
      const r = planner.results[it.key] || {};
      const ds = planner.drafts.filter((d) => d.itemKey === it.key);
      const fin = ds.length ? Math.max(...ds.map((d) => d.end)) : null;
      res.push([
        st.label,
        r.reason || '',
        it.planNo,
        it.productCode,
        it.partCode,
        it.qty,
        it.confirmedQty,
        planner.draftQty(it.key),
        planner.workQty(it),
        dateCell(it.due),
        dateCell(fin),
        it.main,
        it.prod,
        it.material,
        it.daily,
        it.machineDays,
        it.rec,
        ds.map((d) => d.machine).join('/'),
      ]);
    }
    XLSX.utils.book_append_sheet(wb, aoaSheet(res, [11, 40, 12, 20, 20, 9, 9, 9, 9, 11, 11, 7, 9, 10, 8, 8, 10, 20]), '품목별결과');

    // 4) 간트 (확정+가배정, 일정 있는 호기만)
    const days = opts.ganttDays || 45;
    const from = opts.ganttFrom != null ? opts.ganttFrom : planner.today - 3;
    const head = ['호기', '방'];
    for (let d = 0; d < days; d++) head.push(dateCell(from + d));
    const g = [head];
    for (const m of planner.machines) {
      const segs = planner.timeline.segments(m.no);
      if (!segs.some((s) => s.e >= from && s.s < from + days)) continue;
      const row = [Number(m.no), m.room];
      for (let d = 0; d < days; d++) {
        const day = from + d;
        const hit = segs.find((s) => s.s <= day && s.e >= day);
        row.push(hit ? (hit.s === day || d === 0 ? (hit.kind === 'draft' ? '▶' : '') + hit.partCode : '■') : null);
      }
      g.push(row);
    }
    const gws = aoaSheet(g, [6, 7].concat(new Array(days).fill(5)));
    for (let c = 2; c < head.length; c++) {
      const ref = XLSX.utils.encode_cell({ r: 0, c });
      if (gws[ref]) gws[ref].z = 'm/d';
    }
    XLSX.utils.book_append_sheet(wb, gws, '간트(▶가배정)');
    return wb;
  }

  function exportFileName(prefix) {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return (prefix || 'CNC_일정수립결과') + '_' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes()) + '.xlsx';
  }

  return { SHEETS, CONFIRM_HEADERS, readWorkbook, parseRawRows, parsePastedText, buildExportWorkbook, exportFileName };
});
