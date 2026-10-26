/*
 * 현장 수기 간트 학습.
 * 담당자가 방별 시트에 직접 그린 간트(행=호기, 열=날짜, 시작칸에 "부품코드/수량K(같이 도는 호기)" + 색칠 구간)를 읽어
 * 실제 배정 습관(호기 수, 가공기간, 방 분산·반 하루 셋팅 수, 방마스터 밖 배정)을 수치로 뽑고
 * 자동배정에 쓸 수량대별 가공기간 보정계수와 기준 보완 제안을 만든다.
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CNCLearn = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';
  const E = typeof module === 'object' && module.exports ? require('./engine.js') : root.CNCEngine;
  const getXLSX = () => (root && root.XLSX) || (typeof require === 'function' ? require('xlsx') : null);
  const { up, str } = E;

  // 수량대 (보정계수 단위)
  const BANDS = [
    { key: 'b1', label: '1만 개 미만', max: 10000 },
    { key: 'b2', label: '1만~5만', max: 50000 },
    { key: 'b3', label: '5만~15만', max: 150000 },
    { key: 'b4', label: '15만 이상', max: Infinity },
  ];
  // 가공1팀 수기 간트(2026-09-28~11월) 학습값: 수기 근무일 ÷ 기준 장비일의 중앙값 (토·일·23번 휴일 제외)
  const DEFAULT_FACTORS = { b1: 0.5, b2: 1, b3: 1, b4: 0.8 };
  function bandOf(qty) {
    const k = E.qtyBand(qty);
    return BANDS.find((b) => b.key === k);
  }

  function fillKey(s) {
    if (!s || !s.patternType || s.patternType === 'none') return null;
    const fg = s.fgColor || {};
    if (fg.theme != null) return 't' + fg.theme + ':' + Math.round((fg.tint || 0) * 100);
    if (fg.rgb) return 'r' + fg.rgb;
    if (fg.indexed != null && fg.indexed !== 64) return 'i' + fg.indexed;
    return null;
  }

  /** "TEGX4376AM-DGP/640K(519.529.535)(~11/19)" → {part, qty, group, note} */
  function parseLabel(text) {
    let grp = null;
    const notes = [];
    for (const g of String(text).match(/\(([^()]*)\)/g) || []) {
      const inner = g.slice(1, -1);
      if ((/^[0-9.\s,/]+$/.test(inner) && inner.includes('.')) || /^\s*\d{1,3}\s*$/.test(inner)) grp = inner;
      else notes.push(inner);
    }
    const core = String(text).replace(/\([^()]*\)/g, '').trim();
    const m = core.match(/^([A-Za-z0-9][A-Za-z0-9\-._ ]*?)\s*(?:\/\s*([0-9.,]+)\s*([Kk]?))?\s*$/);
    if (!m) return null;
    const out = { part: up(m[1]) };
    if (m[2]) {
      const v = parseFloat(m[2].replace(/,/g, '').replace(/\.+$/, ''));
      if (isFinite(v)) out.qty = m[3] || v < 1000 ? Math.round(v * 1000) : v;
    }
    if (grp) out.group = grp.split(/[.\s,/]+/).filter((x) => /^\d+$/.test(x)).map(Number);
    if (notes.length) out.note = notes.join(' ');
    return out;
  }

  /**
   * 첫 날짜 칸은 "일"만 있으므로 연·월을 추정한다.
   * 머리행에서 월이 바뀌는 지점(30→1 등)으로 첫 달의 일수를 알아내 그 일수인 달만 후보로 두고,
   * 오늘보다 일주일 넘게 미래가 아닌 날 중 오늘에 가장 가까운 날을 고른다 (수기 간트는 보통 지난 날부터 시작).
   */
  function guessFirstDate(day, today, seq) {
    let monthLen = null;
    for (let i = 1; seq && i < seq.length; i++) if (seq[i] === 1 && seq[i - 1] >= 28) {
      monthLen = seq[i - 1];
      break;
    }
    const t = E.dateFromSerial(today);
    const cands = [];
    for (let dm = -6; dm <= 2; dm++) {
      const d = new Date(t.getFullYear(), t.getMonth() + dm, day);
      if (d.getDate() !== day) continue;
      const len = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      if (monthLen && len !== monthLen) continue;
      cands.push(E.serialFromDate(d));
    }
    if (!cands.length) return null;
    const past = cands.filter((s) => s <= today + 7);
    const pool = past.length ? past : cands;
    return pool.reduce((b, s) => (Math.abs(s - today) < Math.abs(b - today) ? s : b));
  }

  /**
   * 수기 간트 통합문서 → 작업 구간 목록.
   * opts.firstDate: 첫 날짜 칸의 실제 날짜(엑셀 일련번호). 없으면 today 기준 추정.
   */
  /**
   * A열 호기 칸 → {no, tag}. 담당자가 편의상 "430,,", "402(A)", "606(작은거X)", "121호기"처럼 적은 칸도
   * 앞의 숫자를 호기로 읽는다 ("신규호기" 같은 머리행·빈칸은 제외).
   */
  function machineCell(a) {
    if (!a || a.v == null) return null;
    if (typeof a.v === 'number') return a.v > 0 && a.v < 10000 ? { no: String(Math.trunc(a.v)), tag: '' } : null;
    const t = str(a.v);
    const m = /^(\d{1,4})(?!\d)\s*(.*)$/.exec(t);
    if (!m || Number(m[1]) <= 0) return null;
    const tag = m[2].replace(/^[,.\s]+|[,.\s]+$/g, '').replace(/^호기/, '').trim();
    return { no: String(Number(m[1])), tag };
  }

  function parseGantt(data, opts) {
    opts = opts || {};
    const XLSX = getXLSX();
    const wb = data && data.SheetNames ? data : XLSX.read(data, { type: data instanceof ArrayBuffer || ArrayBuffer.isView(data) ? 'array' : 'buffer', cellStyles: true });
    const today = opts.today || E.todaySerial();
    const segs = [];
    const machines = [];
    let firstDate = opts.firstDate || null;
    let horizon = 0;
    for (const name of wb.SheetNames) {
      const ws = wb.Sheets[name];
      if (!ws || !ws['!ref']) continue;
      const range = XLSX.utils.decode_range(ws['!ref']);
      const cell = (r, c) => ws[XLSX.utils.encode_cell({ r, c })];
      // 머리행(1행)의 1~31 숫자 칸 중 연속된 날짜 구간만 사용
      const cols = [];
      let prev = null;
      for (let c = 0; c <= range.e.c; c++) {
        const h = cell(0, c);
        const v = h && typeof h.v === 'number' && Number.isInteger(h.v) && h.v >= 1 && h.v <= 31 ? h.v : null;
        if (v == null) {
          if (cols.length) break;
          continue;
        }
        if (prev != null && !(v === prev + 1 || (v === 1 && prev >= 28))) break;
        cols.push(c);
        prev = v;
      }
      if (cols.length < 5) continue;
      if (firstDate == null) firstDate = guessFirstDate(cell(0, cols[0]).v, today, cols.map((c) => cell(0, c).v));
      horizon = Math.max(horizon, cols.length);
      const headNames = [];
      for (let c = 1; c < cols[0]; c++) headNames.push(str(cell(0, c) && cell(0, c).v));
      for (let r = 1; r <= range.e.r; r++) {
        const mc = machineCell(cell(r, 0));
        if (!mc) continue;
        const m = mc.no;
        const info = mc.tag ? { 호기표기: mc.tag } : {};
        headNames.forEach((h, i) => {
          const x = cell(r, i + 1);
          if (h && x && x.v != null && str(x.v) !== '') info[h] = str(x.v);
        });
        machines.push(Object.assign({ sheet: name, machine: m }, info));
        let cur = null;
        const close = () => {
          if (cur) segs.push(cur);
          cur = null;
        };
        cols.forEach((c, i) => {
          const x = cell(r, c);
          const text = x && x.v != null ? str(x.v) : '';
          const fk = x ? fillKey(x.s) : null;
          if (text) {
            close();
            cur = { sheet: name, machine: m, label: text, start: i, end: i, fill: fk, cont: false };
          } else if (fk && cur && fk === cur.fill && cur.end === i - 1) cur.end = i;
          else if (fk && !cur && i === 0) cur = { sheet: name, machine: m, label: '', start: 0, end: 0, fill: fk, cont: true };
          else if (cur && fk !== cur.fill) close();
        });
        close();
      }
    }
    for (const s of segs) {
      s.days = s.end - s.start + 1;
      s.startDate = firstDate + s.start;
      s.endDate = firstDate + s.end;
      if (s.label) Object.assign(s, parseLabel(s.label) || {});
    }
    return { segs, machines, firstDate, horizon };
  }

  const med = (a) => {
    if (!a.length) return null;
    const b = a.slice().sort((x, y) => x - y);
    return b[Math.floor(b.length / 2)];
  };
  const quant = (a, p) => {
    if (!a.length) return null;
    const b = a.slice().sort((x, y) => x - y);
    return b[Math.min(b.length - 1, Math.floor(p * b.length))];
  };

  /**
   * 수기 간트 구간 + 현재 플래너(마스터/원본) → 학습 보고서.
   */
  function analyze(parsed, planner) {
    const segs = parsed.segs.filter((s) => s.part);
    const byPart = {};
    for (const it of planner.items) if (it.dupOf == null) (byPart[up(it.partCode)] = byPart[up(it.partCode)] || []).push(it);
    const itemFor = (s) => {
      const list = byPart[s.part] || [];
      if (!list.length) return null;
      if (s.qty) {
        let best = list[0];
        for (const it of list) if (Math.abs((it.openQty || it.qty) - s.qty) < Math.abs((best.openQty || best.qty) - s.qty)) best = it;
        return best;
      }
      return list[0];
    };
    const jobsMap = new Map();
    for (const s of segs) {
      const k = s.part + '|' + (s.qty || '');
      if (!jobsMap.has(k)) jobsMap.set(k, []);
      jobsMap.get(k).push(s);
    }
    const jobs = [...jobsMap.values()];
    const lastIdx = parsed.horizon - 1;
    const inside = (l) => l.every((s) => !s.cont && s.start > 0 && s.end < lastIdx - 1);

    // 수량대별 호기 수 / 가공기간 / 보정계수
    const bands = BANDS.map((b) => ({ key: b.key, label: b.label, jobs: 0, machines: [], run: [], ratio: [] }));
    const rates = {};
    for (const l of jobs) {
      const qty = l[0].qty;
      const it = itemFor(l[0]);
      if (!qty || !inside(l)) continue;
      const b = bands.find((x) => x.key === bandOf(qty).key);
      const n = new Set(l.map((s) => s.machine)).size;
      // 계획 엔진과 같은 기준(근무일 달력)으로 센다. 휴일마스터가 없으면 달력일.
      const md = l.reduce((a, s) => a + Math.max(1, planner.cal ? planner.cal.count(s.startDate, s.endDate) : s.days), 0);
      b.jobs++;
      b.machines.push(n);
      b.run.push(Math.round(md / n));
      if (it && it.daily > 0) {
        b.ratio.push(md / (Math.ceil(qty / it.daily) + (it.buffer || 0)));
        (rates[it.prod] = rates[it.prod] || { prod: it.prod, std: it.daily, list: [] }).list.push(qty / md);
      }
    }
    const factors = {};
    for (const b of bands) {
      b.machinesMed = med(b.machines);
      b.machinesMax = b.machines.length ? Math.max(...b.machines) : null;
      b.runMed = med(b.run);
      b.ratioMed = b.ratio.length ? Math.round(med(b.ratio) * 100) / 100 : null;
      if (b.ratio.length >= 5) factors[b.key] = Math.min(3, Math.max(0.3, b.ratioMed));
    }
    const classRates = Object.values(rates)
      .map((r) => ({ prod: r.prod, n: r.list.length, std: r.std, med: Math.round(med(r.list)), p25: Math.round(quant(r.list, 0.25)), p75: Math.round(quant(r.list, 0.75)) }))
      .sort((a, b) => b.n - a.n);

    // 방 분산, 같은 날 시작
    const multi = jobs.filter((l) => new Set(l.map((s) => s.machine)).size > 1);
    const roomOf = (m) => (planner.machineByNo[m] ? planner.machineByNo[m].room : '?');
    const spread = {
      multiJobs: multi.length,
      oneRoom: multi.filter((l) => new Set(l.map((s) => roomOf(s.machine))).size === 1).length,
      sameDayStart: multi.filter((l) => new Set(l.map((s) => s.start)).size === 1).length,
    };
    // 반(방) 하루 신규셋팅 수 (반별 인원 한도 비교용)
    const roomDay = {};
    for (const s of segs) {
      if (s.cont) continue;
      const r = roomOf(s.machine);
      if (r !== '?') roomDay[r + '|' + s.start] = (roomDay[r + '|' + s.start] || 0) + 1;
    }
    const byRoom = {};
    for (const [k, v] of Object.entries(roomDay)) (byRoom[k.split('|')[0]] = byRoom[k.split('|')[0]] || []).push(v);
    const roomSetups = Object.entries(byRoom)
      .map(([room, l]) => ({ room, p50: quant(l, 0.5), p95: quant(l, 0.95), max: Math.max(...l) }))
      .sort((a, b) => a.room.localeCompare(b.room, 'ko', { numeric: true }));

    // 방마스터 적합도와 밖 배정 조합
    const fit = { t0: 0, t1: 0, t2: 0, out: 0, unknown: 0 };
    const outside = new Map();
    const matRooms = new Map();
    for (const s of segs) {
      const it = itemFor(s);
      const mc = planner.machineByNo[s.machine];
      if (!it || !mc) {
        fit.unknown++;
        continue;
      }
      const re = E.roomEligible(planner.rooms[mc.room], it);
      if (!re) {
        fit.out++;
        const k = mc.room + '|' + it.main + '|' + it.prod + '|' + (it.matGroup || up(it.material) || '재질없음');
        outside.set(k, (outside.get(k) || 0) + 1);
      } else if (re.score >= 150) fit.t0++;
      else if (re.score >= 100) fit.t1++;
      else fit.t2++;
      if (!it.matGroup && it.material && ['PL', 'TE'].includes(it.main)) {
        const room = planner.rooms[mc.room];
        const fam = room ? up(room.matGroup) : '';
        const mk = exactKey(it.material);
        if (!matRooms.has(mk)) matRooms.set(mk, {});
        const t = matRooms.get(mk);
        t[fam || '-'] = (t[fam || '-'] || 0) + 1;
      }
    }
    const outsideList = [...outside.entries()]
      .map(([k, n]) => {
        const [room, main, prod, mat] = k.split('|');
        return { room, main, prod, mat, n };
      })
      .sort((a, b) => b.n - a.n);
    // 재질 → 소재계열 매핑 제안: 계열이 정해진 방에 70% 이상 & 3건 이상
    const matHints = [];
    for (const [mat, t] of matRooms) {
      const total = Object.values(t).reduce((a, b) => a + b, 0);
      const [fam, n] = Object.entries(t).sort((a, b) => b[1] - a[1])[0];
      const famTok = fam.split('/')[0];
      if (famTok && famTok !== '-' && total >= 3 && n / total >= 0.7) matHints.push({ material: mat, family: famTok, n, total });
    }
    matHints.sort((a, b) => b.n - a.n);

    return {
      firstDate: parsed.firstDate,
      horizon: parsed.horizon,
      segments: segs.length,
      jobs: jobs.length,
      matched: segs.filter((s) => itemFor(s)).length,
      machinesUsed: new Set(segs.map((s) => s.machine)).size,
      bands,
      factors,
      classRates,
      spread,
      roomSetups,
      fit,
      outsideList,
      matHints,
    };
  }
  function exactKey(material) {
    return up(material).replace(/\s+/g, '').replace(/-\d+$/, '');
  }

  /** 자동배정 결과를 같은 기준(수량대별 호기 수·가공기간)으로 요약해 수기 간트와 나란히 비교. */
  function summarizePlan(planner) {
    const byItem = new Map();
    for (const d of planner.drafts) {
      if (!byItem.has(d.itemKey)) byItem.set(d.itemKey, []);
      byItem.get(d.itemKey).push(d);
    }
    const bands = BANDS.map((b) => ({ key: b.key, label: b.label, jobs: 0, machines: [], run: [] }));
    let oneRoom = 0;
    let multi = 0;
    for (const [k, l] of byItem) {
      const it = planner.itemByKey[k];
      const qty = l.reduce((a, d) => a + d.qty, 0);
      const b = bands.find((x) => x.key === bandOf(qty).key);
      b.jobs++;
      b.machines.push(l.length);
      b.run.push(Math.round(l.reduce((a, d) => a + d.days, 0) / l.length));
      if (l.length > 1) {
        multi++;
        if (new Set(l.map((d) => planner.groupOf[d.machine])).size === 1) oneRoom++;
      }
      void it;
    }
    for (const b of bands) {
      b.machinesMed = med(b.machines);
      b.machinesMax = b.machines.length ? Math.max(...b.machines) : null;
      b.runMed = med(b.run);
    }
    return { bands, multi, oneRoom };
  }

  return { BANDS, DEFAULT_FACTORS, bandOf, machineCell, parseLabel, parseGantt, analyze, summarizePlan };
});
