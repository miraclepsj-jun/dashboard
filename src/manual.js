/*
 * 수기 일정 이관 (v700~v738 "① 수기 일정 읽기 → 22번 미리보기 → 9번 반영" 대응).
 * 담당자가 그리던 방별 수기 간트의 오늘 이후 작업블록을 원본 발주(계획번호/제품코드)와 매칭해
 * 현행 일정(9번 확정 형식)으로 만든다. 확실하지 않은 블록은 '확인필요'로 남겨 담당자가 직접 고친다.
 *
 * 매칭 순서 (v713 RAW-FIRST 단순화):
 *   1) 원본 근거: 같은 부품 발주 중 설비1~A에 수기 호기가 있거나 개시~완료가 수기 기간과 겹치는 발주
 *   2) 미납이 남은 같은 부품 발주가 1건뿐
 *   3) 수기 수량(/xxK)이 발주량 또는 미납잔량과 같은(±0.5%) 발주, 또는 발주일순 연속 발주 합계
 * 수량: 수기 표기 수량(/23K) → 없으면 블록 근무일 × 일생산량 추정. 발주별 남은 수량(미납잔량 − 9번 미완료
 * 확정잔량, v702)을 묶음 시작일 순으로 차감하며, 수기 블록 근무일 비례 100개 단위로 나눈다.
 * 수기 간트 A열의 호기는 "430,,", "402(A)"처럼 글자가 붙어 있어도 앞 숫자로 읽는다(learn.machineCell).
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

  const RAW_DATE_TOL = 10; // 원본 개시~완료와 수기 기간 겹침 허용 (일)

  /**
   * 수기 간트(learn.parseGantt 결과) → 이관 미리보기.
   * planner: 현재 Planner (원본·9번·달력). 반환 {waves:[{..., status, reason, rows, candidates}], counts}
   *
   * 담당자가 편의상 적은 간트라 수량 표기가 있는 블록도, 없는 블록도 있다.
   *  - 수량 표기(/23K)가 있으면 그 수량만큼만 이관한다.
   *  - 없으면 블록 근무일 × 품목 일생산량으로 추정한다(w.estimated).
   *  - 발주별 남은 수량(미납잔량 − 9번 확정잔량)을 묶음 시작일 순으로 차감해 한 발주가 여러 블록에 이중으로 잡히지 않게 한다.
   */
  function preview(parsed, planner) {
    const today = planner.today;
    const cal = planner.cal;
    const byPart = new Map();
    for (const it of planner.items) if (it.dupOf == null) (byPart.get(up(it.partCode)) || byPart.set(up(it.partCode), []).get(up(it.partCode))).push(it);
    const parts = [...byPart.keys()];
    const confirmed = planner.model.confirmed || [];
    const segs = parsed.segs.filter((s) => s.part);
    const waves = buildWaves(segs).sort((a, b) => a.start - b.start || (b.qty ? 1 : 0) - (a.qty ? 1 : 0) || a.part.localeCompare(b.part));
    waves.forEach((w, i) => (w.id = i + 1));
    const budget = new Map();
    const leftOf = (it) => (budget.has(it.key) ? budget.get(it.key) : Math.max(0, Math.round(it.openQty - it.confirmedQty)));
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
      w.candidates = cands.map((it) => ({ key: it.key, planNo: it.planNo, productCode: it.productCode, partCode: it.partCode, qty: it.qty, openQty: it.openQty, left: leftOf(it), orderDate: it.orderDate, refMachines: it.refMachines }));
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
      // 9번에 같은 호기·부품·겹치는 기간이 이미 있으면 중복
      const part = up(cands[0].partCode);
      w.dupSegs = w.segs.filter((s) => confirmed.some((c) => E.machineNo(c.machine) === s.machine && up(c.partCode) === part && c.start <= s.endDate && c.end >= s.startDate));
      if (w.dupSegs.length === w.segs.length) {
        w.status = '9번중복';
        w.reason = '9번 확정에 같은 호기·부품·기간이 이미 있음';
        continue;
      }
      const open = cands.filter((it) => it.openQty > 0).sort((a, b) => (a.orderDate || 0) - (b.orderDate || 0));
      const avail = open.filter((it) => leftOf(it) > 0);
      if (!avail.length) {
        w.status = '잔량없음';
        w.reason = open.some((it) => budget.has(it.key)) ? '같은 부품의 앞 수기 블록에서 미납잔량을 이미 모두 배정' : '미납잔량이 이미 9번 확정으로 모두 배정됨';
        continue;
      }
      // 이관할 수량: 수기 표기 → 없으면 근무일 × 일생산량 추정
      const live = w.segs.filter((s) => !w.dupSegs.includes(s));
      const daily = avail[0].daily > 0 ? avail[0].daily : 0;
      let target = w.qty || 0;
      if (!target && daily) {
        target = Math.ceil((live.reduce((a, s) => a + Math.max(1, cal.count(s.startDate, s.endDate)), 0) * daily) / 100) * 100;
        w.estimated = true;
        w.estimate = target;
      }
      let plans = null;
      let how = '';
      // 1) 원본 근거: 설비1~A에 수기 호기가 있고(개시~완료가 있으면 기간도 겹침), 또는 설비 없이 개시~완료만 겹침
      const overlap = (it) => it.progStart != null && it.progEnd != null && it.progStart <= w.end + RAW_DATE_TOL && it.progEnd >= w.start - RAW_DATE_TOL;
      const hasDates = (it) => it.progStart != null && it.progEnd != null;
      let raw = avail.filter((it) => it.refMachines.some((m) => w.machines.has(m)) && (!hasDates(it) || overlap(it)));
      if (!raw.length) raw = avail.filter((it) => !it.refMachines.length && overlap(it));
      const qtyHit = (it) => w.qty && (near(w.qty, it.qty) || near(w.qty, it.openQty) || near(w.qty, leftOf(it)));
      if (raw.length) {
        plans = raw;
        how = '원본 설비/일정 근거';
      } else if (avail.length === 1) {
        plans = avail;
        how = open.length === 1 ? '미납 발주 1건' : '남은 미납 발주 1건';
      } else if (w.qty) {
        const one = avail.find(qtyHit);
        if (one) {
          plans = [one];
          how = '수량 일치';
        } else {
          for (let i = 0; i < avail.length && !plans; i++) {
            let sum = 0;
            for (let j = i; j < avail.length; j++) {
              sum += leftOf(avail[j]);
              if (near(w.qty, sum)) {
                plans = avail.slice(i, j + 1);
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
        w.reason = '같은 부품 미납 발주 ' + avail.length + '건 중 특정 불가' + (w.qty ? ' (수기 ' + nfmt(w.qty) + '개)' : w.estimated ? ' (수기 수량 표기 없음, 추정 ' + nfmt(target) + '개)' : ' (수기 수량 표기 없음)');
        w.suggest = suggestPlans(avail, target, leftOf);
        w.suggestQty = target || null;
        continue;
      }
      // 수기 수량과 딱 맞는 발주가 있으면 그 발주부터 채운다
      if (w.qty && plans.length > 1) plans = plans.filter(qtyHit).concat(plans.filter((it) => !qtyHit(it)));
      assign(w, plans, how, planner, target, leftOf);
      for (const r of w.rows) {
        const it = planner.itemByKey[E.itemKey(r.planNo, r.productCode, r.partCode)];
        if (it) budget.set(it.key, leftOf(it) - r.qty);
      }
    }
    return recount({ waves, firstDate: parsed.firstDate });
  }

  function recount(prev) {
    prev.counts = {};
    for (const s of STATUS) prev.counts[s] = 0;
    for (const w of prev.waves) prev.counts[w.status] = (prev.counts[w.status] || 0) + 1;
    prev.estimated = prev.waves.filter((w) => w.status === '정상' && w.estimated && !w.manualFix).length;
    return prev;
  }

  const nfmt = (n) => Math.round(n).toLocaleString('ko-KR');

  /** 확인필요 묶음에 미리 체크해 둘 발주: 발주일순으로 목표 수량이 찰 때까지 (목표가 없으면 가장 이른 1건) */
  function suggestPlans(avail, target, leftOf) {
    if (!target) return avail.slice(0, 1).map((it) => it.planNo);
    const out = [];
    let sum = 0;
    for (const it of avail) {
      if (sum >= target) break;
      out.push(it.planNo);
      sum += leftOf(it);
    }
    return out;
  }

  /**
   * 매칭된 발주들의 남은 수량(leftOf)을 목표 수량(target, 0이면 남은 전량)만큼 작업묶음 블록에 근무일 비례로 나눠 이관 행을 만든다.
   */
  function assign(w, plans, how, planner, target, leftOf) {
    const cal = planner.cal;
    const left = plans.map((it) => ({ it, q: leftOf(it) }));
    const sumLeft = left.reduce((a, x) => a + x.q, 0);
    const total = target > 0 ? Math.min(sumLeft, Math.round(target)) : sumLeft;
    w.plans = plans.map((it) => it.planNo);
    w.how = how;
    const dup = w.dupSegs || [];
    const segs = w.segs.filter((s) => !dup.includes(s)).sort((a, b) => a.startDate - b.startDate || a.machine - b.machine);
    const days = segs.map((s) => Math.max(1, cal.count(Math.max(s.startDate, planner.today), s.endDate)));
    const qty = E.distributeQtyHundreds(total, days);
    consume(w, segs, qty, left, planner);
    w.plans = [...new Set(w.rows.map((r) => r.planNo))];
    const unknown = [...new Set(segs.filter((s) => !planner.machineByNo[s.machine]).map((s) => s.machine))];
    const notes = [how];
    if (w.estimated) notes.push('추정: 수기 수량 표기 없음 → 근무일×일생산량 ' + nfmt(total) + '개');
    else if (w.qty && sumLeft < w.qty * 0.995) notes.push('수기 ' + nfmt(w.qty) + '개 > 남은 미납 ' + nfmt(sumLeft) + '개 → 남은 만큼');
    if (w.fixedPart) notes.push('부품코드 보정 ' + w.part + '→' + w.fixedPart);
    if (unknown.length) notes.push('설비마스터 미등록 호기 ' + unknown.join(','));
    if (dup.length) notes.push('9번중복 ' + dup.length + '블록 제외');
    w.status = '정상';
    w.reason = notes.join(' / ');
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

  /** 다른 정상 묶음(반영 체크된 것)이 이미 쓴 발주별 수량 */
  function usedByOthers(prev, w) {
    const used = new Map();
    for (const x of (prev && prev.waves) || []) {
      if (x === w || x.status !== '정상' || x.skip) continue;
      for (const r of x.rows) {
        const k = E.itemKey(r.planNo, r.productCode, r.partCode);
        used.set(k, (used.get(k) || 0) + r.qty);
      }
    }
    return used;
  }

  /** 확인필요 묶음을 담당자가 고른 발주(계획번호 목록)와 총수량으로 다시 배분 (prev: 미리보기, 다른 묶음이 쓴 수량을 뺀다) */
  function resolve(w, planNos, totalQty, planner, prev) {
    const cands = (w.candidates || []).filter((c) => planNos.includes(c.planNo));
    if (!cands.length) return false;
    const items = cands.map((c) => planner.itemByKey[c.key]).filter(Boolean);
    const used = usedByOthers(prev, w);
    w.rows = [];
    const cal = planner.cal;
    const segs = w.segs.filter((s) => !(w.dupSegs || []).includes(s)).sort((a, b) => a.startDate - b.startDate || a.machine - b.machine);
    const days = segs.map((s) => Math.max(1, cal.count(Math.max(s.startDate, planner.today), s.endDate)));
    const left = items.map((it) => ({ it, q: Math.max(0, Math.round(it.openQty - it.confirmedQty - (used.get(it.key) || 0))) }));
    const total = totalQty > 0 ? Math.round(totalQty) : left.reduce((a, x) => a + x.q, 0);
    if (!(total > 0)) return false;
    const qty = E.distributeQtyHundreds(total, days);
    // 담당자가 총수량을 직접 넣으면 마지막 발주가 남은 수량을 받는다
    if (totalQty > 0 && left.length) {
      const sumLeft = left.reduce((a, x) => a + x.q, 0);
      if (total > sumLeft) left[left.length - 1].q += total - sumLeft;
    }
    consume(w, segs, qty, left, planner);
    w.plans = [...new Set(w.rows.map((r) => r.planNo))];
    w.status = '정상';
    w.manualFix = true;
    w.reason = '담당자 지정: ' + planNos.join(', ') + ' · ' + nfmt(total) + '개';
    if (prev) recount(prev);
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
