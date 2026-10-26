/*
 * 현장 출력 (v738 25_현장출력 / 26_일일생산지시_출력 / 27_방별간트_출력 대응).
 * 기준일·방을 고르면 그 방 호기의 당일 생산지시(배정총량/누적실적/잔량/가공기간/금일계획)와 14일 간트를 만든다.
 * 금일계획 = 배정총량 ÷ 가공 근무일 (누적실적이 있으면 잔량 ÷ 남은 근무일), 휴일·주말은 0.
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CNCPrint = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';
  const E = typeof module === 'object' && module.exports ? require('./engine.js') : root.CNCEngine;

  /**
   * planner, room, date(기준일), span(일), includeDrafts
   * 반환 {orders:[], overdue:[], gantt:[], days:[{d, work, label}]}
   */
  function build(planner, room, date, span, includeDrafts) {
    span = span || 14;
    const cal = planner.cal;
    const tl = planner.timeline;
    const last = date + span - 1;
    const days = [];
    for (let d = date; d <= last; d++) days.push({ d, work: cal.isWork(d), label: cal.labels[d] || '' });
    const machines = planner.machines.filter((m) => !room || m.room === room).sort((a, b) => Number(a.no) - Number(b.no));
    const orders = [];
    const overdue = [];
    const gantt = [];
    for (const mc of machines) {
      const segs = tl
        .segments(mc.no)
        .filter((s) => includeDrafts || s.kind !== 'draft')
        .slice()
        .sort((a, b) => a.s - b.s);
      const worker = planner.workerByMachine[mc.no] || '';
      for (const s of segs) {
        const qty = s.planQty || s.qty || 0;
        const actual = s.kind === 'confirmed' ? s.actualQty || 0 : 0;
        const remain = Math.max(0, qty - actual);
        const row = {
          machine: mc.no,
          room: mc.room,
          worker,
          partCode: s.partCode,
          productCode: s.productCode,
          planNo: s.planNo,
          kind: s.kind,
          source: s.kind === 'draft' ? '가배정' : '확정',
          qty,
          actual,
          remain,
          start: s.s,
          end: s.e,
          workdays: cal.count(s.s, s.e),
        };
        if (s.s <= date && s.e >= date) {
          const leftDays = cal.count(date, s.e);
          // v738: 근무일 균등배분 기준값, 누적실적이 입력되면 잔량 ÷ 남은 가동일
          row.today = !cal.isWork(date) || leftDays <= 0 ? 0 : actual > 0 ? Math.ceil(remain / leftDays) : Math.ceil(qty / Math.max(1, row.workdays));
          row.mini = days.map((x) => (x.d >= s.s && x.d <= s.e ? (x.work ? 1 : 2) : x.work ? 0 : 3));
          orders.push(row);
        } else if (s.kind === 'confirmed' && s.e < date && !s.complete && date - s.e <= 30) {
          overdue.push(row);
        }
      }
      // 2주 간트: 기간과 겹치는 구간, 같은 호기 동일부품 연속은 한 줄로
      const inSpan = segs.filter((s) => s.e >= date && s.s <= last);
      const merged = [];
      for (const s of inSpan) {
        const prev = merged[merged.length - 1];
        if (prev && E.up(prev.partCode) === E.up(s.partCode) && cal.count(prev.end + 1, s.s - 1) === 0) {
          prev.end = Math.max(prev.end, s.e);
          prev.qty += s.planQty || s.qty || 0;
          prev.actual += s.kind === 'confirmed' ? s.actualQty || 0 : 0;
        } else merged.push({ machine: mc.no, worker, partCode: s.partCode, start: s.s, end: s.e, qty: s.planQty || s.qty || 0, actual: s.kind === 'confirmed' ? s.actualQty || 0 : 0, kind: s.kind });
      }
      for (const g of merged) g.mini = days.map((x) => (x.d >= g.start && x.d <= g.end ? (x.work ? 1 : 2) : x.work ? 0 : 3));
      if (merged.length) gantt.push(...merged);
      else gantt.push({ machine: mc.no, worker, partCode: '', empty: true, mini: days.map((x) => (x.work ? 0 : 3)) });
    }
    return { room, date, span, days, orders, overdue, gantt };
  }

  /** 엑셀용 2차원 배열 (일일 생산지시서 + 방별 간트) */
  function toSheets(out) {
    const dayHead = out.days.map((x) => E.fmtMD(x.d));
    const mark = (v) => (v === 1 ? '■' : v === 2 || v === 3 ? '휴' : '');
    const orders = [['일일 생산지시서 ' + (out.room || '전체') + ' / ' + E.fmtYMD(out.date)], ['호기', '담당작업자', '부품코드', '계획번호', '구분', '배정총량', '누적실적', '잔량', '가공기간', '금일계획', '작업자', '완료'].concat(dayHead)];
    for (const r of out.orders) orders.push([Number(r.machine), r.worker, r.partCode, r.planNo, r.source, r.qty, r.actual, r.remain, E.fmtMD(r.start) + '~' + E.fmtMD(r.end), r.today, '', ''].concat(r.mini.map(mark)));
    if (out.overdue.length) {
      orders.push([]);
      orders.push(['완료일 경과 확인후보 (실적 확인 필요)']);
      for (const r of out.overdue) orders.push([Number(r.machine), r.worker, r.partCode, r.planNo, r.source, r.qty, r.actual, r.remain, E.fmtMD(r.start) + '~' + E.fmtMD(r.end)]);
    }
    const gantt = [['방별 간트 ' + (out.room || '전체') + ' / ' + E.fmtYMD(out.date) + '부터 ' + out.span + '일'], ['호기', '담당작업자', '부품코드', '배정총량', '누적실적', '가공기간'].concat(dayHead)];
    for (const g of out.gantt) gantt.push([Number(g.machine), g.worker, g.partCode, g.empty ? '' : g.qty, g.empty ? '' : g.actual, g.empty ? '' : E.fmtMD(g.start) + '~' + E.fmtMD(g.end)].concat(g.mini.map(mark)));
    return { orders, gantt };
  }

  return { build, toSheets };
});
