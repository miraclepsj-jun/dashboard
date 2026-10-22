/*
 * 수기 일정 이관 (v700~v738 "① 수기 일정 읽기 → 22번 미리보기 → 9번 반영" 대응).
 * 담당자가 그리던 방별 수기 간트의 오늘 이후 작업블록을 원본 발주(계획번호/제품코드)와 매칭해
 * 현행 일정(9번 확정 형식)으로 만든다. 확실하지 않은 블록은 '확인필요'로 남겨 담당자가 직접 고친다.
 *
 * 매칭 순서 (v713 RAW-FIRST 단순화):
 *   1) 원본 근거: 같은 부품 발주 중 설비1~A에 수기 호기가 있거나 개시~완료가 수기 기간과 겹치는 발주
 *   2) 미납이 남은 같은 부품 발주가 1건뿐
 *   3) 수기 수량(/xxK)이 발주량 또는 미납잔량과 같은(±0.5%) 발주, 또는 발주일순 연속 발주 합계
 * 수량은 발주 미납잔량 − 9번 미완료 확정잔량(v702)을 수기 블록 근무일 비례 100개 단위로 나눈다.
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CNCManual = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';
  const E = typeof module === 'object' && module.exports ? require('./engine.js') : root.CNCEngine;
  const { up } = E;

  const STATUS = ['정상', '확인필요', '원본완료', '잔량없음', '9번중복', '지난일정'];

  function editDistance(a, b) {
    if (Math.abs(a.length - b.length) > 2) return 9;
    const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++)
      for (let j = 1; j <= b.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return dp[a.length][b.length];
  }
  const near = (a, b) => a > 0 && b > 0 && Math.abs(a - b) <= Math.max(1, b * 0.005);

  /** 같은 부품·같은 수기 수량 표기의 블록 중 기간이 겹치거나 이어지는 것을 한 작업묶음(WAVE)으로 */
  function buildWaves(segs) {
    const groups = new Map();
    for (const s of segs) {
      const k = s.part + '|' + (s.qty || '') + '|' + (s.group ? s.group.join('.') : '');
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(s);
    }
    const waves = [];
    for (const list of groups.values()) {
      list.sort((a, b) => a.startDate - b.startDate);
      let cur = null;
      for (const s of list) {
        if (cur && s.startDate <= cur.end + 3 && (!s.group || !cur.machines.has(s.machine) || s.startDate <= cur.end)) {
          cur.segs.push(s);
          cur.machines.add(s.machine);
          cur.end = Math.max(cur.end, s.endDate);
        } else {
          cur = { part: s.part, qty: s.qty || null, segs: [s], machines: new Set([s.machine]), start: s.startDate, end: s.endDate, note: s.note || '' };
          waves.push(cur);
        }
      }
    }
    return waves;
  }

  /**
   * 수기 간트(learn.parseGantt 결과) → 이관 미리보기.
   * planner: 현재 Planner (원본·9번·달력). 반환 {waves:[{..., status, reason, rows, candidates}], counts}
   */
  function preview(parsed, planner) {
    const today = planner.today;
    const cal = planner.cal;
    const byPart = new Map();
    for (const it of planner.items) if (it.dupOf == null) (byPart.get(up(it.partCode)) || byPart.set(up(it.partCode), []).get(up(it.partCode))).push(it);
    const parts = [...byPart.keys()];
    const confirmed = planner.model.confirmed || [];
    const segs = parsed.segs.filter((s) => s.part);
    const waves = buildWaves(segs);
    waves.forEach((w, i) => (w.id = i + 1));
    for (const w of waves) {
      w.machineList = [...w.machines];
      w.rows = [];
      if (w.end < today) {
        w.status = '지난일정';
        w.reason = '수기 완료일이 오늘 이전';
        continue;
      }
      let cands = byPart.get(w.part) || [];
      if (!cands.length) {
        // 부품코드 오타: 편집거리 1~2이고 원본 설비1~A에 수기 호기가 있는 유일 부품만 보정 (v713)
        const fix = parts.filter((p) => editDistance(p, w.part) <= 2 && byPart.get(p).some((it) => it.refMachines.some((m) => w.machines.has(m))));
        if (fix.length === 1) {
          w.fixedPart = fix[0];
          cands = byPart.get(fix[0]);
        }
      }
      w.candidates = cands.map((it) => ({ key: it.key, planNo: it.planNo, productCode: it.productCode, partCode: it.partCode, qty: it.qty, openQty: it.openQty, left: Math.max(0, it.openQty - it.confirmedQty), orderDate: it.orderDate, refMachines: it.refMachines }));
      if (!cands.length) {
        w.status = '확인필요';
        w.reason = '원본에 같은 부품코드 발주 없음';
        continue;
      }
      if (cands.every((it) => !(it.openQty > 0))) {
        w.status = '원본완료';
        w.reason = '원본 미납잔량 0 (입고 완료)';
        continue;
      }
      const open = cands.filter((it) => it.openQty > 0).sort((a, b) => (a.orderDate || 0) - (b.orderDate || 0));
      let plans = null;
      let how = '';
      // 1) 원본 근거: 설비1~A 호기 또는 개시~완료 겹침
      const raw = open.filter((it) => it.refMachines.some((m) => w.machines.has(m)) || (it.progStart != null && it.progEnd != null && it.progStart <= w.end && it.progEnd >= w.start));
      if (raw.length) {
        plans = raw;
        how = '원본 설비/일정 근거';
      } else if (open.length === 1) {
        plans = open;
        how = '미납 발주 1건';
      } else if (w.qty) {
        const one = open.find((it) => near(w.qty, it.qty) || near(w.qty, it.openQty));
        if (one) {
          plans = [one];
          how = '수량 일치';
        } else {
          for (let i = 0; i < open.length && !plans; i++) {
            let sum = 0;
            for (let j = i; j < open.length; j++) {
              sum += open[j].openQty;
              if (near(w.qty, sum)) {
                plans = open.slice(i, j + 1);
                how = '연속 발주 수량 합 일치';
                break;
              }
              if (sum > w.qty * 1.01) break;
            }
          }
        }
      }
      if (!plans) {
        w.status = '확인필요';
        w.reason = '같은 부품 미납 발주 ' + open.length + '건 중 특정 불가' + (w.qty ? ' (수기 ' + Math.round(w.qty).toLocaleString('ko-KR') + '개)' : ' (수기 수량 표기 없음)');
        continue;
      }
      assign(w, plans, how, planner, confirmed, cal);
    }
    const counts = {};
    for (const s of STATUS) counts[s] = 0;
    for (const w of waves) counts[w.status] = (counts[w.status] || 0) + 1;
    return { waves, counts, firstDate: parsed.firstDate };
  }

  /** 매칭된 발주들의 남은 수량을 작업묶음 블록에 근무일 비례로 나눠 이관 행을 만든다. */
  function assign(w, plans, how, planner, confirmed, cal) {
    const left = plans.map((it) => ({ it, q: Math.max(0, Math.round(it.openQty - it.confirmedQty)) }));
    const total = left.reduce((a, x) => a + x.q, 0);
    w.plans = plans.map((it) => it.planNo);
    w.how = how;
    // 9번에 같은 호기·부품·겹치는 기간이 이미 있으면 중복
    const dup = w.segs.filter((s) => confirmed.some((c) => E.machineNo(c.machine) === s.machine && up(c.partCode) === up(plans[0].partCode) && c.start <= s.endDate && c.end >= s.startDate));
    if (dup.length === w.segs.length) {
      w.status = '9번중복';
      w.reason = '9번 확정에 같은 호기·부품·기간이 이미 있음';
      return;
    }
    if (total <= 0) {
      w.status = '잔량없음';
      w.reason = '미납잔량이 이미 9번 확정으로 모두 배정됨';
      return;
    }
    const segs = w.segs.filter((s) => !dup.includes(s)).sort((a, b) => a.startDate - b.startDate || a.machine - b.machine);
    const days = segs.map((s) => Math.max(1, cal.count(Math.max(s.startDate, planner.today), s.endDate)));
    const qty = E.distributeQtyHundreds(total, days);
    consume(w, segs, qty, left, planner);
    const unknown = segs.filter((s) => !planner.machineByNo[s.machine]).map((s) => s.machine);
    w.status = '정상';
    w.reason = how + (w.fixedPart ? ' / 부품코드 보정 ' + w.part + '→' + w.fixedPart : '') + (unknown.length ? ' / 설비마스터 미등록 호기 ' + unknown.join(',') : '') + (dup.length ? ' / 9번중복 ' + dup.length + '블록 제외' : '');
  }

  /**
   * 발주일순으로 블록 수량을 소진해 이관 행을 만든다.
   * 한 블록이 두 발주에 걸치면 블록 기간을 수량 비율로 앞뒤로 나눠 같은 호기에서 겹치지 않게 한다.
   */
  function consume(w, segs, qty, left, planner) {
    const cal = planner.cal;
    let pi = 0;
    segs.forEach((s, i) => {
      let need = qty[i];
      const pieces = [];
      while (need > 0 && pi < left.length) {
        const take = Math.min(need, left[pi].q);
        if (take > 0) {
          pieces.push({ it: left[pi].it, q: take });
          left[pi].q -= take;
          need -= take;
        }
        if (left[pi].q <= 0) pi++;
      }
      const total = pieces.reduce((a, x) => a + x.q, 0);
      const wd = Math.max(1, cal.count(s.startDate, s.endDate));
      let cur = s.startDate;
      pieces.forEach((pc, k) => {
        const last = k === pieces.length - 1;
        const d = last ? null : Math.max(1, Math.round((wd * pc.q) / total));
        const end = last ? s.endDate : Math.min(s.endDate, cal.finish(cur, d));
        w.rows.push({ planNo: pc.it.planNo, productCode: pc.it.productCode, partCode: pc.it.partCode, machine: s.machine, start: cur, end, qty: pc.q, sheet: s.sheet, label: s.label });
        cur = Math.min(s.endDate, cal.nextWork(end + 1));
      });
    });
  }

  /** 확인필요 묶음을 담당자가 고른 발주(계획번호 목록)와 총수량으로 다시 배분 */
  function resolve(w, planNos, totalQty, planner) {
    const cands = (w.candidates || []).filter((c) => planNos.includes(c.planNo));
    if (!cands.length) return false;
    const items = cands.map((c) => planner.itemByKey[c.key]).filter(Boolean);
    w.rows = [];
    const cal = planner.cal;
    const segs = w.segs.slice().sort((a, b) => a.startDate - b.startDate || a.machine - b.machine);
    const days = segs.map((s) => Math.max(1, cal.count(Math.max(s.startDate, planner.today), s.endDate)));
    const total = totalQty > 0 ? Math.round(totalQty) : items.reduce((a, it) => a + Math.max(0, it.openQty - it.confirmedQty), 0);
    const qty = E.distributeQtyHundreds(total, days);
    const left = items.map((it) => ({ it, q: Math.max(0, Math.round(it.openQty - it.confirmedQty)) }));
    // 담당자가 총수량을 직접 넣으면 마지막 발주가 남은 수량을 받는다
    if (totalQty > 0 && left.length) {
      const sumLeft = left.reduce((a, x) => a + x.q, 0);
      if (total > sumLeft) left[left.length - 1].q += total - sumLeft;
    }
    consume(w, segs, qty, left, planner);
    w.status = '정상';
    w.manualFix = true;
    w.reason = '담당자 지정: ' + planNos.join(', ');
    return true;
  }

  /** 정상 묶음의 이관 행 → 9번 확정 형식(엔진 confirmed 행) */
  function toConfirmed(prev) {
    const out = [];
    for (const w of prev.waves) {
      if (w.status !== '정상' || w.skip) continue;
      for (const r of w.rows) out.push(Object.assign({}, r, { actualQty: 0, source: 'manual', note: '수기이관/' + (w.manualFix ? '담당자지정' : w.how) + '/' + r.sheet }));
    }
    return out;
  }

  return { STATUS, buildWaves, preview, resolve, toConfirmed, editDistance };
});
