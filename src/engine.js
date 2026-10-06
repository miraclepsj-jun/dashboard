/*
 * CNC 가공일정 자동수립 엔진
 *
 * 기존 엑셀 매크로(modCNCPlanEngine v666)의 판정 규칙을 그대로 옮기고,
 * 품목을 하나씩 조회/확정하던 흐름을 "전체 품목 일괄 가배정"으로 확장한 순수 계산 모듈.
 * 브라우저(window.CNCEngine)와 Node(require) 양쪽에서 동작한다.
 *
 * 날짜는 모두 엑셀 일련번호(1900 날짜 체계, 정수 일)로 다룬다.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CNCEngine = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ───────────────────────── 공통 유틸 ─────────────────────────
  const DAY_MS = 86400000;
  const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30);

  function serialFromYMD(y, m, d) {
    return Math.round((Date.UTC(y, m - 1, d) - EXCEL_EPOCH_UTC) / DAY_MS);
  }
  function serialFromDate(dt) {
    return serialFromYMD(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
  }
  function dateFromSerial(serial) {
    const t = new Date(EXCEL_EPOCH_UTC + Math.round(serial) * DAY_MS);
    return new Date(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
  }
  function todaySerial() {
    return serialFromDate(new Date());
  }
  function fmtMD(serial) {
    if (serial == null || !isFinite(serial)) return '';
    const d = dateFromSerial(serial);
    return (d.getMonth() + 1) + '/' + d.getDate();
  }
  function fmtYMD(serial) {
    if (serial == null || !isFinite(serial)) return '';
    const d = dateFromSerial(serial);
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  /** 셀 값을 엑셀 날짜 일련번호로 변환 (숫자/Date/"2026-09-28"/"9/28"/"9월28일"). */
  function toSerial(v, refYear) {
    if (v == null || v === '') return null;
    if (v instanceof Date && !isNaN(v)) return serialFromDate(v);
    if (typeof v === 'number') return v > 0 && v < 2958466 ? Math.floor(v) : null;
    let s = String(v).trim();
    if (!s) return null;
    if (/^\d+(\.\d+)?$/.test(s)) {
      const n = Number(s);
      return n > 20000 && n < 2958466 ? Math.floor(n) : null;
    }
    s = s.replace(/월/g, '/').replace(/일/g, '').replace(/[.\-]/g, '/').replace(/\s+/g, '');
    const parts = s.split('/').filter((x) => x !== '');
    let y, m, d;
    if (parts.length === 2) {
      y = refYear || new Date().getFullYear();
      m = parseInt(parts[0], 10);
      d = parseInt(parts[1], 10);
    } else if (parts.length === 3) {
      y = parseInt(parts[0], 10);
      m = parseInt(parts[1], 10);
      d = parseInt(parts[2], 10);
      if (y < 100) y += 2000;
    } else return null;
    if (!(y >= 1900 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
    return serialFromYMD(y, m, d);
  }

  function toNum(v) {
    if (v == null || v === '') return 0;
    if (typeof v === 'number') return isFinite(v) ? v : 0;
    const n = Number(String(v).replace(/,/g, '').trim());
    return isFinite(n) ? n : 0;
  }
  function isNumLike(v) {
    if (v == null || v === '') return false;
    if (typeof v === 'number') return isFinite(v);
    return /^-?\d+(\.\d+)?$/.test(String(v).replace(/,/g, '').trim());
  }
  function str(v) {
    return v == null ? '' : String(v).trim();
  }
  function up(v) {
    return str(v).toUpperCase();
  }
  function isYes(v) {
    if (v === true) return true;
    const s = up(v);
    return s === 'Y' || s === 'YES' || s === '1' || s === 'TRUE';
  }
  function isExplicitNo(v) {
    if (v === false) return true;
    const s = up(v);
    return s === 'N' || s === 'NO' || s === '0' || s === 'FALSE';
  }
  function appendText(base, add) {
    base = str(base);
    add = str(add);
    if (!add) return base;
    if (!base) return add;
    return base + ' / ' + add;
  }
  /** "호기" 셀에서 숫자만 추출 ("527호기" → "527"). */
  function machineNo(v) {
    if (typeof v === 'number') return String(Math.trunc(v));
    const s = str(v);
    const m = s.match(/(\d+)(?!.*\d)/);
    return m ? String(parseInt(m[1], 10)) : s;
  }
  function parseMachineList(text) {
    return str(text)
      .split(/[\/,\s]+/)
      .map((t) => machineNo(t))
      .filter((t) => t !== '');
  }
  function itemKey(planNo, productCode, partCode) {
    return up(planNo) + '|' + up(productCode) + '|' + up(partCode);
  }
  function partKey(v) {
    return up(v).replace(/　/g, ' ').replace(/ {2,}/g, ' ');
  }

  // ───────────────────────── 품목 분류 ─────────────────────────
  const MAIN_PREFIXES = ['PL', 'TE', 'BD', 'IS', 'ST', 'HD', 'BG'];

  function getMainClass(partCode) {
    const s = up(partCode);
    const p = s.slice(0, 2);
    return MAIN_PREFIXES.includes(p) ? p : '기타';
  }
  function partBody(partCode) {
    const s = up(partCode);
    const p = s.indexOf('-');
    return p > 0 ? s.slice(0, p) : s;
  }
  function methodCode(method) {
    const m = str(method);
    if (m === '앞2자리') return 'prefix';
    if (m === '끝일치') return 'ends';
    if (m === '본체끝문자' || m === '본체끝' || m === '본체끝일치') return 'bodyEnd';
    return 'contains';
  }

  /** 5_생산성분류 규칙 정리: 적용여부 Y, 키워드가 숫자가 아닌 행만, 우선순위 오름차순. */
  function prepareRules(rules) {
    return rules
      .filter((r) => str(r.keyword) && up(r.active == null ? 'Y' : r.active) === 'Y' && !isNumLike(r.keyword))
      .map((r, i) => ({
        keyword: up(r.keyword),
        method: methodCode(r.method),
        detail: str(r.detail) || str(r.prod),
        prod: str(r.prod),
        priority: isNumLike(r.priority) ? toNum(r.priority) : 9999,
        order: i,
      }))
      .sort((a, b) => a.priority - b.priority || a.order - b.order);
  }

  function classifyPart(partCode, preparedRules) {
    const main = getMainClass(partCode);
    const text = up(partCode);
    const body = partBody(text);
    let detail = '';
    let prod = '';
    for (const r of preparedRules) {
      let hit;
      if (MAIN_PREFIXES.includes(r.keyword)) hit = text.slice(0, 2) === r.keyword;
      else if (r.method === 'prefix') hit = text.startsWith(r.keyword);
      else if (r.method === 'ends') hit = text.endsWith(r.keyword);
      else if (r.method === 'bodyEnd') hit = body.endsWith(r.keyword);
      else hit = text.includes(r.keyword);
      if (hit) {
        detail = r.detail;
        prod = r.prod;
        break;
      }
    }
    if (!prod) prod = detail;
    if (!prod) prod = '미분류';
    return { main, detail, prod };
  }

  function recommendMachineRange(machineDays) {
    if (machineDays <= 0) return '';
    if (machineDays <= 5) return '1';
    if (machineDays <= 10) return '2';
    if (machineDays <= 20) return '2~3';
    if (machineDays <= 40) return '3~5';
    return 'Manual Review';
  }
  function parseRecRange(text) {
    const s = str(text);
    if (!s || /manual/i.test(s)) return null;
    const nums = s.match(/\d+/g);
    if (!nums) return null;
    const a = parseInt(nums[0], 10);
    const b = nums.length > 1 ? parseInt(nums[1], 10) : a;
    return { min: Math.min(a, b), max: Math.max(a, b) };
  }

  // ───────────────────────── 소재 계열 ─────────────────────────
  /** 품목 재질 → 방 기본소재계열(BECU/TK/SK). v509 규칙. */
  function materialGroup(materialText, extraMap) {
    const s = up(materialText);
    if (!s) return '';
    // 사용자 추가 매핑(설정: "H5J=TK") 우선
    for (const [k, v] of Object.entries(extraMap || {})) if (k && s.includes(up(k))) return up(v);
    if (s.includes('C1730') || s.includes('BECU') || s.includes('BE-CU')) return 'BECU';
    if (s.includes('H5A') || s.includes('H3J') || s.includes('TK-') || s.startsWith('TK') || s.includes('GPC')) return 'TK';
    if (s.includes('SK-') || s.startsWith('SK')) return 'SK';
    return '';
  }
  /** "SK 커터 = 4번방, 6번방" → [{mat:'SK', prod:'커터', rooms:Set(['4번방','6번방'])}] ('*'는 전체) */
  function parseRoomRules(text) {
    const out = [];
    for (const line of String(text || '').split(/\n+/)) {
      const [l, r] = line.split('=');
      if (!r) continue;
      const toks = l.trim().split(/[\s/]+/).filter(Boolean);
      if (toks.length < 2) continue;
      const rooms = new Set(
        r.split(/[,\s/]+/)
          .map((x) => x.trim())
          .filter(Boolean)
          .map((x) => (/^\d+$/.test(x) ? x + '번방' : x))
      );
      if (rooms.size) out.push({ mat: up(toks[0]), prod: up(toks[1]), rooms, text: line.trim() });
    }
    return out;
  }

  /** "H5J=TK\nC3604=BECU" → {H5J:'TK', C3604:'BECU'} */
  function parseMaterialMap(text) {
    const map = {};
    for (const line of String(text || '').split(/[\n,;]+/)) {
      const m = line.split(/[=:→]/);
      if (m.length === 2 && str(m[0]) && str(m[1])) map[up(m[0])] = up(m[1]);
    }
    return map;
  }
  function exactMaterial(text) {
    const s = up(text).replace(/[ \-]/g, '');
    if (!s) return '';
    const order = ['C1730', 'H5A', 'H3J', 'PBT', 'BECU', 'TK', 'SK', 'C3604', 'C18150', 'SUM24'];
    for (const k of order) if (s.includes(k)) return k;
    return '';
  }
  function settingFamily(currentSetting) {
    const e = exactMaterial(currentSetting);
    if (e === 'C1730' || e === 'BECU') return 'BECU';
    if (e === 'H5A' || e === 'H3J' || e === 'TK') return 'TK';
    if (e === 'SK') return 'SK';
    return e;
  }
  /** 설비 현재소재와 품목 재질 비교 점수 (v580). */
  function settingMatch(targetMaterial, targetGroup, currentSetting) {
    if (!str(currentSetting)) return { score: 0, text: '현재소재 미기록' };
    const te = exactMaterial(targetMaterial);
    const ce = exactMaterial(currentSetting);
    const cf = settingFamily(currentSetting);
    if (te && ce && te === ce) return { score: 60, text: '정확일치(' + te + ')' };
    if (targetGroup && cf && up(targetGroup) === up(cf)) return { score: 25, text: '계열일치(' + cf + ')' };
    if (ce) return { score: -20, text: '다른소재(' + ce + ')' };
    return { score: 0, text: '소재판단불가' };
  }

  // ───────────────────────── 방/설비 판정 ─────────────────────────
  function containsToken(groupText, token) {
    const t = up(token);
    if (!t) return false;
    return up(groupText)
      .replace(/,/g, '/')
      .replace(/\s/g, '')
      .split('/')
      .some((p) => p === t);
  }
  function isRoom7(name) {
    return str(name) === '7번방';
  }
  const ROOM7_DEFAULT_SERIES = 'G105/G135/G1353/GS135/GS105/GSS135/G230/G240/G265';
  function room7SeriesMatch(productCode, partCode, seriesList) {
    const list = str(seriesList) || ROOM7_DEFAULT_SERIES;
    let stripped = up(partCode);
    if (['PL', 'TE', 'BD'].includes(stripped.slice(0, 2))) stripped = stripped.slice(2);
    const pc = up(productCode);
    return list
      .replace(/,/g, '/')
      .replace(/\s/g, '')
      .split('/')
      .filter(Boolean)
      .some((tok) => pc.startsWith(up(tok)) || stripped.startsWith(up(tok)));
  }

  /** 방마스터 기준 적합 판정 (v509). null = 부적합. */
  function roomEligible(room, item) {
    if (!room) return null;
    if (up(room.autoUse) === 'N') return null;
    const roomMat = up(room.matGroup);
    const roomProd = up(room.prodClass);
    const roomMain = up(room.mainAllowed);
    if (up(room.special) === 'Y' && isRoom7(room.name)) {
      if (!room7SeriesMatch(item.productCode, item.partCode, room.series)) return null;
      if (!containsToken(roomMain, item.main)) return null;
      return { score: 1000, reason: '특수대상시리즈 일치', conditional: true };
    }
    if (roomMain && !containsToken(roomMain, item.main)) return null;
    let score = 0;
    let reason = '';
    // 기존 매크로는 문자열 완전일치라 "TK/H3J"(5번방)가 TK 품목과 연결되지 않았다 → 토큰 일치로 판정
    if (roomMat) {
      if (!item.matGroup) return null;
      if (!containsToken(roomMat, item.matGroup)) return null;
      score += 100;
      reason = '기본소재계열 일치';
    }
    if (roomProd) {
      if (!containsToken(roomProd, item.prod)) {
        if (score === 0) return null;
      } else {
        score += 50;
        reason = reason ? reason + ' + 우선생산성분류 일치' : '우선생산성분류 일치';
      }
    }
    if (roomMain) {
      score += 10;
      if (!reason) reason = '허용대분류 일치';
    }
    return { score, reason, conditional: false };
  }

  function lookupBDSpec(bdSpecs, partCode) {
    const key = partKey(partCode);
    if (!key) return { status: '미등록' };
    const hits = bdSpecs.filter((b) => partKey(b.part) === key);
    if (hits.length === 0) return { status: '미등록' };
    if (hits.length > 1) return { status: '중복' };
    const h = hits[0];
    if (!isNumLike(h.od) || !isNumLike(h.len) || toNum(h.od) <= 0 || toNum(h.len) <= 0) return { status: '규격미완료' };
    return { status: '정상', od: toNum(h.od), len: toNum(h.len) };
  }

  function parseBGCode(partCode) {
    const arr = up(partCode).replace(/\s/g, '').split('-');
    if (arr.length < 3 || arr[0].slice(0, 2) !== 'BG') return null;
    if (!isNumLike(arr[1]) || !isNumLike(arr[2])) return null;
    return { od: toNum(arr[1]), len: toNum(arr[2]) };
  }
  function bgNote(partCode, bgRules) {
    const p = parseBGCode(partCode);
    if (!p) return 'BG 코드 형식 확인 필요';
    const od = p.od >= 10 ? p.od / 10 : p.od;
    const rooms = (bgRules || [])
      .filter((r) => isNumLike(r.odMin) && isNumLike(r.odMax) && od >= toNum(r.odMin) && od < toNum(r.odMax))
      .map((r) => r.room);
    const band = '외경구간<=' + p.od.toFixed(1) + ', 길이구간<=' + p.len + 'mm';
    return rooms.length ? 'BG 전용방 추정(' + rooms.join('/') + '): ' + band : 'BG전용기준 확인 필요: ' + band;
  }

  // ───────────────────────── 배정대상 생성 ─────────────────────────
  /**
   * 원본 붙여넣기 행 → 배정대상 품목 목록 (CNC_CreatePlan_Stage1 + 상태갱신 v592).
   * opts.baseDate: 기준게시일(기본: 오늘+1)
   */
  function buildItems(model, opts) {
    const baseDate = opts && opts.baseDate != null ? opts.baseDate : todaySerial() + 1;
    const rules = prepareRules(model.rules || []);
    const prodDict = {};
    for (const p of model.productivity || []) {
      const k = up(p.cls).replace(/\s/g, '');
      if (k) prodDict[k] = { daily: toNum(p.daily), buffer: parseBuffer(p.buffer) };
    }
    const confirmedQty = {};
    for (const c of model.confirmed || []) {
      const k = itemKey(c.planNo, c.productCode, c.partCode);
      // v670: 확정수량은 누적실적을 뺀 잔량으로 본다
      confirmedQty[k] = (confirmedQty[k] || 0) + Math.max(0, toNum(c.qty) - toNum(c.actualQty));
    }
    const classCache = {};
    const items = [];
    (model.raw || []).forEach((r, idx) => {
      if (!str(r.planNo) && !str(r.productCode) && !str(r.partCode)) return;
      const partCode = str(r.partCode);
      const ck = up(partCode);
      const cls = classCache[ck] || (classCache[ck] = classifyPart(partCode, rules));
      const qty = toNum(r.qty);
      const received = toNum(r.received);
      // v670 배정대상수량: 발주량 - 입고누계, 발주량이 없으면 필요수량
      const openQty = qty > 0 ? Math.max(0, qty - received) : Math.max(0, toNum(r.need));
      const pd = prodDict[up(cls.prod).replace(/\s/g, '')];
      let daily = pd ? pd.daily : 0;
      let machineDays = 0;
      if (daily > 0 && openQty > 0) machineDays = Math.ceil(openQty / daily) + (pd ? pd.buffer : 0);
      const due = r.reqDate != null ? r.reqDate : null;
      let availDays = 1;
      if (due != null) availDays = Math.max(1, due - baseDate + 1);
      let rec = recommendMachineRange(machineDays);
      let note = '';
      if (cls.main === 'BG') {
        daily = 0;
        machineDays = 0;
        rec = '';
        note = bgNote(partCode, model.bgRules);
      } else if (up(partCode).includes('U')) {
        note = 'U품목: P033 전용';
      }
      const key = itemKey(r.planNo, r.productCode, partCode);
      const cq = confirmedQty[key] || 0;
      let status = '대상';
      if (openQty > 0 && cq > 0) status = cq < openQty ? '추가배정' : cq === openQty ? '배정완료' : '배정초과';
      else if (qty > 0 && openQty <= 0) status = '입고완료';
      items.push({
        id: idx,
        key,
        planNo: str(r.planNo),
        productCode: str(r.productCode),
        partCode,
        qty,
        due,
        baseDate,
        availDays,
        workArea: str(r.workArea),
        material: str(r.material),
        matGroup: materialGroup(r.material, opts && opts.materialMap),
        special: str(r.special),
        h2: r.h2,
        main: cls.main,
        detail: cls.detail,
        prod: cls.prod,
        daily,
        buffer: pd ? pd.buffer : 0,
        machineDays,
        rec,
        note,
        refMachines: r.refMachines || [],
        confirmedQty: cq,
        received,
        openQty,
        orderDate: r.orderDate != null ? r.orderDate : null,
        progStart: r.progStart != null ? r.progStart : null,
        progEnd: r.progEnd != null ? r.progEnd : null,
        remainQty: Math.max(0, openQty - cq),
        status,
      });
    });
    // 동일 계획/제품/부품이 여러 행이면 확정수량이 중복 차감되지 않도록 첫 행만 기존확정을 인정한다.
    const seen = {};
    for (const it of items) {
      if (seen[it.key]) {
        it.dupOf = seen[it.key].id;
      } else seen[it.key] = it;
    }
    return items;
  }

  function parseBuffer(v) {
    if (isNumLike(v)) return toNum(v);
    const s = up(v).replace(/\s/g, '');
    return s === 'Y' || s === 'YES' || s === 'TRUE' || s === '1' ? 1 : 0;
  }

  /** 수량대 (현장 학습 가공기간 보정 단위): b1 <1만, b2 <5만, b3 <15만, b4 그 이상 */
  function qtyBand(qty) {
    return qty < 10000 ? 'b1' : qty < 50000 ? 'b2' : qty < 150000 ? 'b3' : 'b4';
  }

  /** 잔량 기준 필요 장비일수. */
  function daysForQty(item, qty) {
    if (!(item.daily > 0) || !(qty > 0)) return 0;
    return Math.ceil(qty / item.daily) + (item.buffer || 0);
  }

  // ───────────────────────── 호기 일정(타임라인) ─────────────────────────
  /**
   * 호기별 확정/가배정 구간을 관리한다.
   * - 확정(9_설비배정_확정)은 실적 완료 시 실제완료일까지만 점유
   * - 오늘 기준 가장 최근 시작 구간이 계획완료일을 지났는데 미완료이면 "지연진행" → 완료확인 전 신규배정 불가
   */
  class Timeline {
    constructor(confirmed, opts) {
      this.today = (opts && opts.today) || todaySerial();
      this.requireActualOk = !!(opts && opts.requireActualOk);
      this.delayPolicy = (opts && opts.delayPolicy) || 'block'; // 'block' | 'assumeDone'
      this.blocks = (opts && opts.blocks) || {}; // machine -> [{s,e,label}] (고장 등)
      this.byMachine = new Map();
      (confirmed || []).forEach((c, i) => this._addConfirmed(c, i));
      for (const list of this.byMachine.values()) list.sort((a, b) => a.s - b.s || a.e - b.e);
    }
    _list(m) {
      let l = this.byMachine.get(m);
      if (!l) this.byMachine.set(m, (l = []));
      return l;
    }
    _addConfirmed(c, idx) {
      const m = machineNo(c.machine);
      const s = c.start;
      const f = c.end;
      if (!m || s == null || f == null || f < s) return;
      const planQty = toNum(c.qty);
      const actualQty = toNum(c.actualQty);
      const actualDate = c.actualDate;
      const okFlag = this.requireActualOk ? isYes(c.actualOk) : true;
      const complete = okFlag && planQty > 0 && actualQty >= planQty && actualDate != null;
      let effEnd = f;
      if (complete && actualDate < effEnd) effEnd = actualDate;
      this._list(m).push({
        s,
        e: f,
        effEnd,
        complete,
        planQty,
        actualQty,
        kind: 'confirmed',
        ref: idx,
        partCode: c.partCode,
        productCode: c.productCode,
        planNo: c.planNo,
        material: c.material || '',
        qty: planQty,
      });
    }
    addDraft(m, s, e, info) {
      const l = this._list(m);
      const seg = Object.assign({ s, e, effEnd: e, complete: false, kind: 'draft' }, info || {});
      l.push(seg);
      l.sort((a, b) => a.s - b.s || a.e - b.e);
      return seg;
    }
    removeDrafts(pred) {
      for (const [m, l] of this.byMachine) {
        const kept = l.filter((seg) => !(seg.kind === 'draft' && pred(seg, m)));
        if (kept.length !== l.length) this.byMachine.set(m, kept);
      }
    }
    segments(m) {
      return this.byMachine.get(m) || [];
    }
    /** 오늘 기준 작업상태 (v560). */
    status(m) {
      const today = this.today;
      let latest = null;
      for (const seg of this.segments(m)) {
        if (seg.kind !== 'confirmed') continue;
        if (seg.s > today) continue;
        if (!latest || seg.s > latest.s) latest = seg;
      }
      const out = { work: '현재가용', remain: null, delayed: false, latest };
      if (!latest) return out;
      if (today <= latest.effEnd) {
        if (latest.complete) {
          out.work = '완료 100%';
          out.remain = 0;
        } else if (latest.planQty > 0 && latest.actualQty > 0) {
          out.work = '진행중 ' + Math.round(Math.min(latest.actualQty / latest.planQty, 1) * 100) + '%';
          out.remain = Math.max(latest.planQty - latest.actualQty, 0);
        } else {
          out.work = '실적없음';
          if (latest.planQty > 0) out.remain = latest.planQty;
        }
      } else if (today > latest.e && !latest.complete) {
        out.delayed = this.delayPolicy === 'block';
        if (out.delayed) {
          if (latest.planQty > 0 && latest.actualQty > 0) {
            out.work = '지연진행 ' + Math.round(Math.min(latest.actualQty / latest.planQty, 1) * 100) + '%';
            out.remain = Math.max(latest.planQty - latest.actualQty, 0);
          } else {
            out.work = '지연진행 / 실적없음';
            if (latest.planQty > 0) out.remain = latest.planQty;
          }
        }
      }
      return out;
    }
    _occupied(m) {
      const segs = this.segments(m).map((x) => ({ s: x.s, e: x.effEnd }));
      for (const b of this.blocks[m] || []) segs.push({ s: b.s, e: b.e });
      return segs.sort((a, b) => a.s - b.s);
    }
    /**
     * from 이후 requiredDays 연속으로 비어 있는 첫 시작일 (v555).
     * 지연진행(완료확인 필요) 호기는 null.
     */
    gapStart(m, from, requiredDays) {
      requiredDays = Math.max(1, requiredDays || 1);
      let cand = Math.max(this.today, from);
      if (this.status(m).delayed) return null;
      const segs = this._occupied(m);
      for (let guard = 0; guard < segs.length + 5; guard++) {
        let moved = false;
        for (const x of segs) {
          if (x.s <= cand && x.e >= cand) {
            cand = x.e + 1;
            moved = true;
          }
        }
        if (moved) continue;
        let next = null;
        for (const x of segs) if (x.s > cand && (next == null || x.s < next)) next = x.s;
        if (next == null || cand + requiredDays - 1 < next) return cand;
        let blockEnd = next;
        for (const x of segs) if (x.s === next && x.e > blockEnd) blockEnd = x.e;
        cand = blockEnd + 1;
      }
      return cand;
    }
    /** 가용구간 표시 문자열과 가용점수 (v560). */
    availability(m, from) {
      const st = this.status(m);
      if (st.delayed) return { text: '완료확인 필요', score: 0, start: null, status: st };
      const start = this.gapStart(m, from, 1);
      let next = null;
      for (const x of this._occupied(m)) if (x.s > start && (next == null || x.s < next)) next = x.s;
      const text = next != null ? fmtMD(start) + '~' + fmtMD(next - 1) + ' 가용' : fmtMD(start) + ' 이후 가용';
      const delta = start - Math.max(this.today, from);
      const score = delta <= 0 ? 8 : delta <= 3 ? 6 : delta <= 7 ? 4 : delta <= 14 ? 2 : 0;
      return { text, score, start, status: st };
    }
    /** start 직전(=start-1)에 끝나는 구간. 동일부품 연속가공 판단용. */
    prevSegmentEndingAt(m, day) {
      let best = null;
      for (const seg of this.segments(m)) if (seg.e < day + 1 && (!best || seg.e > best.e)) best = seg;
      return best && best.e === day ? best : null;
    }
    lastEnd(m) {
      let e = null;
      for (const seg of this.segments(m)) if (e == null || seg.effEnd > e) e = seg.effEnd;
      return e;
    }
  }

  // ───────────────────────── 작업자 운영 제약 ─────────────────────────
  function operationConstraint(workers, m, refSerial, targetGroup, currentFamily) {
    let penalty = 0;
    let availNote = '';
    let note = '';
    for (const w of workers || []) {
      if (machineNo(w.machine) !== m) continue;
      const status = str(w.status);
      const noSetup = isYes(w.noSetup);
      const s = w.start;
      const e = w.end;
      let active = true;
      if (s != null && refSerial < s) active = false;
      if (e != null && refSerial > e) active = false;
      if (s == null && e == null) active = !!(status || noSetup);
      if (!active) continue;
      if (status) {
        let t = '운영제약:' + status;
        if (e != null) {
          const days = Math.max(0, e + 1 - refSerial);
          penalty += days <= 0 ? 0 : days <= 3 ? -2 : days <= 7 ? -4 : days <= 14 ? -6 : -8;
          t += '->' + fmtMD(e + 1);
        } else penalty -= 8;
        availNote = appendText(availNote, t);
        note = appendText(note, '운영제약:' + status + (w.worker ? '(' + w.worker + ')' : ''));
      }
      if (noSetup) {
        if (targetGroup && currentFamily && up(targetGroup) !== up(currentFamily)) {
          penalty -= 6;
          note = appendText(note, '신규세팅금지/소재계열불일치');
        } else note = appendText(note, '신규세팅금지');
      }
    }
    return { penalty, availNote, note };
  }

  /** 고장 등 기간이 명시된 운영제약 → 일정 차단 구간. */
  function buildBlocks(workers, hardKeywords) {
    const kw = hardKeywords || ['고장'];
    const blocks = {};
    for (const w of workers || []) {
      const status = str(w.status);
      if (!status || w.start == null || w.end == null) continue;
      if (!kw.some((k) => status.includes(k))) continue;
      const m = machineNo(w.machine);
      (blocks[m] = blocks[m] || []).push({ s: w.start, e: w.end, label: status });
    }
    return blocks;
  }

  // ───────────────────────── 등급/정렬 ─────────────────────────
  function opPriority(work) {
    const w = str(work);
    if (w.includes('지연진행')) return 0;
    if (w === '현재가용') return 3;
    if (w.includes('진행중') || w.includes('실적없음') || w.includes('완료')) return 2;
    return 1;
  }
  function operationalGrade(base, work) {
    if (base[0] !== 'A') return base;
    const p = opPriority(work);
    if (p === 3) return 'A-즉시추천';
    if (p === 2) return 'A-예약추천';
    if (p === 0) return 'A-일정주의';
    return base;
  }
  function gradeRank(g) {
    const c = str(g)[0];
    return c === 'A' ? 3 : c === 'B' ? 2 : c === 'C' ? 1 : 0;
  }

  // ───────────────────────── 계획 컨텍스트 ─────────────────────────
  /**
   * 한 번의 일정수립 세션. 마스터/확정일정/가배정을 들고 있고
   * 품목별 후보조회, 배분 미리보기, 가배정, 일괄 자동배정을 제공한다.
   */
  class Planner {
    constructor(model, opts) {
      opts = opts || {};
      this.model = model;
      this.opts = opts;
      this.today = opts.today || todaySerial();
      this.baseDate = opts.baseDate != null ? opts.baseDate : this.today + 1;
      // v670 초기일정이관: 9번 확정일정이 하나도 없으면 원본의 설비1~A + 개시/완료를 현행 일정으로 쓴다
      this.initial = { used: false, rows: [], skipped: [] };
      if (!(model.confirmed || []).length && opts.useProgramAssignments !== false) {
        const pre = buildItems(model, { baseDate: this.baseDate, materialMap: opts.materialMap });
        const init = programAssignments(pre);
        if (init.rows.length) {
          this.initial = { used: true, rows: init.rows, skipped: init.skipped };
          model = Object.assign({}, model, { confirmed: init.rows });
          this.model = model;
        } else this.initial.skipped = init.skipped;
      }
      this.items = buildItems(model, { baseDate: this.baseDate, materialMap: opts.materialMap });
      this.itemByKey = {};
      for (const it of this.items) if (it.dupOf == null) this.itemByKey[it.key] = it;
      this.rooms = {};
      for (const r of model.rooms || []) if (str(r.name)) this.rooms[str(r.name)] = r;
      this.machines = (model.machines || []).filter((m) => machineNo(m.no) && str(m.room));
      for (const m of this.machines) m.no = machineNo(m.no);
      this.machineByNo = {};
      for (const m of this.machines) this.machineByNo[m.no] = m;
      this.workerByMachine = {};
      this.workerRows = {};
      this.machinesByWorker = {};
      for (const w of model.workers || []) {
        const m = machineNo(w.machine);
        if (!m) continue;
        (this.workerRows[m] = this.workerRows[m] || []).push(w);
        if (str(w.worker) && !this.workerByMachine[m]) {
          this.workerByMachine[m] = str(w.worker);
          (this.machinesByWorker[str(w.worker)] = this.machinesByWorker[str(w.worker)] || []).push(m);
        }
      }
      this._buildGroups(model);
      this.roomRules = parseRoomRules(opts.roomRules);
      // 확정행의 재질(동일부품 연속가공 판단용)은 원본 품목에서 찾는다.
      const confirmed = (model.confirmed || []).map((c) => {
        const it = this.itemByKey[itemKey(c.planNo, c.productCode, c.partCode)];
        return Object.assign({}, c, { material: it ? it.material : '' });
      });
      this.timeline = new Timeline(confirmed, {
        today: this.today,
        requireActualOk: opts.requireActualOk,
        delayPolicy: opts.delayPolicy,
        blocks: buildBlocks(model.workers, opts.hardBlockKeywords),
      });
      this._rebuildSetupCount();
      this.drafts = []; // {id, itemKey, machine, start, end, days, qty, auto, note}
      this._draftSeq = 1;
      this.results = {}; // itemKey -> {decision, reason, ...}
    }

    /**
     * 조 = 방 (4_설비마스터 '방' 열, 없으면 13_작업자운영마스터 '방' 열).
     * 신규셋팅 한도는 사람 기준: 13_작업자운영마스터 담당작업자 1인당 하루 N건.
     * 담당작업자가 없는 호기는 한도를 적용하지 않는다(호기 단독으로 계산).
     */
    _buildGroups(model) {
      const workerRoom = {};
      for (const w of model.workers || []) {
        const m = machineNo(w.machine);
        if (m && str(w.room) && !workerRoom[m]) workerRoom[m] = str(w.room);
      }
      this.groupOf = {};
      this.setupKeyOf = {};
      for (const m of this.machines) {
        this.groupOf[m.no] = str(m.room) || workerRoom[m.no] || '방 미지정';
        const w = this.workerByMachine[m.no];
        this.setupKeyOf[m.no] = w ? '작업자 ' + w : '호기 ' + m.no;
      }
    }
    _isContinuation(m, start, partCode) {
      const prev = this.timeline.prevSegmentEndingAt(m, start - 1);
      return !!(prev && partCode && up(prev.partCode) === up(partCode));
    }
    _rebuildSetupCount() {
      this.setupCount = new Map();
      for (const [m, segs] of this.timeline.byMachine) for (const seg of segs) this._countSetup(m, seg.s, seg.partCode, 1);
    }
    _countSetup(m, day, partCode, delta) {
      if (this._isContinuation(m, day, partCode)) return;
      const k = this.setupKeyOf[m] + '|' + day;
      this.setupCount.set(k, (this.setupCount.get(k) || 0) + delta);
    }
    setupsOn(m, day) {
      return this.setupCount.get(this.setupKeyOf[m] + '|' + day) || 0;
    }
    /** 빈 구간 + 작업자 1인 하루 신규셋팅 한도를 함께 만족하는 시작일. */
    startFor(m, from, days, partCode) {
      const tl = this.timeline;
      let s = tl.gapStart(m, from, days);
      const limit = this.opts.setupLimitPerWorkerDay != null ? this.opts.setupLimitPerWorkerDay : 5;
      if (!limit || s == null) return s;
      for (let guard = 0; guard < 90 && s != null; guard++) {
        if (this._isContinuation(m, s, partCode) || this.setupsOn(m, s) < limit) return s;
        s = tl.gapStart(m, s + 1, days);
      }
      return s;
    }

    /**
     * 계획용 장비일수: 기준 장비일수(6_생산성기준)에 현장 학습 보정계수(수량대별)를 곱한다.
     * opts.periodFactors가 없으면 기준값 그대로.
     */
    planDays(item, qty) {
      const base = daysForQty(item, qty);
      const f = this.opts.periodFactors && this.opts.periodFactors[qtyBand(qty)];
      if (!base || !(f > 0)) return base;
      return Math.max(1, Math.round(base * f));
    }

    // 품목별 기존확정 + 가배정 수량
    draftQty(key) {
      let q = 0;
      for (const d of this.drafts) if (d.itemKey === key) q += d.qty;
      return q;
    }
    workQty(item) {
      return Math.max(0, item.openQty - item.confirmedQty - this.draftQty(item.key));
    }
    assignedMachines(item) {
      const set = new Set();
      for (const c of this.model.confirmed || [])
        if (itemKey(c.planNo, c.productCode, c.partCode) === item.key) set.add(machineNo(c.machine));
      for (const d of this.drafts) if (d.itemKey === item.key) set.add(d.machine);
      return set;
    }

    /** 품목이 자동 일정수립 대상인지. 아니면 사유 반환. */
    autoBlockReason(item) {
      if (item.dupOf != null) return '중복행(동일 계획/제품/부품)';
      if (item.main === 'BG') return 'BG 전용품 - 수기배정 (' + item.note + ')';
      if (!['PL', 'TE', 'BD'].includes(item.main)) return '대분류 ' + item.main + ' - 자동추천 미지원 대분류';
      if (item.status === '입고완료') return '입고완료 - 미납잔량 없음';
      if (!(item.openQty > 0)) return '발주량 확인 필요';
      if (!(item.daily > 0)) return '생산성기준 미등록 (' + item.prod + ') - 6_생산성기준 확인';
      return '';
    }

    /**
     * 후보 호기 목록 (CNC_Query_Selected_Machines 판정 + 정렬 규칙).
     * 반환: {candidates, diag, bd}
     */
    candidates(item, opts) {
      opts = opts || {};
      const from = opts.from != null ? opts.from : this.baseDate;
      const diag = { total: 0, room: 0, sched: 0, tech: 0, existing: 0, bdOd: 0, bdLen: 0 };
      const out = [];
      const main = up(item.main);
      let bd = null;
      if (main === 'BD') bd = lookupBDSpec(this.model.bdSpecs || [], item.partCode);
      const existing = opts.includeExisting ? new Set() : this.assignedMachines(item);
      const history = this._partHistory(item.partCode);
      const needDays = opts.requiredDays || 1;

      for (const mc of this.machines) {
        diag.total++;
        const room = this.rooms[str(mc.room)];
        const re = roomEligible(room, item) || this._roomExtension(room, item);
        if (!re) continue;
        diag.room++;
        if (isExplicitNo(mc.scheduleTarget) || isExplicitNo(mc.newSetupOk)) continue;
        diag.sched++;
        let tech = false;
        let conditional = re.conditional;
        let note = '';
        if (main === 'PL') tech = isYes(mc.plOk);
        else if (main === 'TE') tech = isYes(mc.teOk);
        else if (main === 'BD') {
          tech = isYes(mc.bdOk);
          if (bd && bd.status === '정상') {
            if (tech) {
              if (isNumLike(mc.bdMin) && isNumLike(mc.bdMax)) {
                if (bd.od < toNum(mc.bdMin) || bd.od > toNum(mc.bdMax)) {
                  tech = false;
                  diag.bdOd++;
                }
              } else {
                conditional = true;
                note = appendText(note, '설비 BD 외경범위 확인 필요');
              }
            }
            if (tech) {
              if (isNumLike(mc.bdMaxLen)) {
                if (bd.len > toNum(mc.bdMaxLen)) {
                  tech = false;
                  diag.bdLen++;
                }
              } else {
                conditional = true;
                note = appendText(note, '설비 BD 최대길이 확인 필요');
              }
            }
            note = appendText(note, 'BD ' + bd.od + ' / L' + bd.len);
            if (isRoom7(mc.room)) {
              if (!tech && up(mc.model).includes('B12')) tech = true;
              conditional = true;
              note = appendText(note, '7번방 BD 전장 30mm 이상 도면 확인');
            }
          } else {
            conditional = true;
            note = appendText(note, 'BD마스터 ' + ((bd && bd.status) || '확인필요') + ' / 도면확인');
            if (isRoom7(mc.room)) {
              if (!tech && up(mc.model).includes('B12')) tech = true;
              note = appendText(note, '7번방 BD 전장 30mm 이상 도면 확인');
            }
          }
        }
        if (tech && up(item.partCode).includes('U') && !up(mc.model).includes('P033')) tech = false;
        if (!tech) continue;
        diag.tech++;
        if (existing.has(mc.no)) {
          diag.existing++;
          continue;
        }

        const sm = settingMatch(item.material, item.matGroup, mc.material);
        const av = this.timeline.availability(mc.no, from);
        const st = av.status;
        let availScore = av.score;
        let availText = av.text;
        const oc = operationConstraint(this.workerRows[mc.no], mc.no, from, item.matGroup, settingFamily(mc.material));
        availScore += oc.penalty;
        availText = appendText(availText, oc.availNote);
        note = appendText(note, oc.note);
        const hScore = this._historyScore(history, mc.no);
        if (hScore > 0) note = appendText(note, '동일부품 확정이력+' + hScore);

        const score = re.score + sm.score + availScore + hScore;
        let grade;
        if (conditional) grade = 'C-조건부';
        else if (re.score >= 150 || (re.score >= 100 && sm.score > 0)) grade = 'A-1차우선';
        else grade = 'B-2차후보';
        grade = operationalGrade(grade, st.work);

        // 연속가공: 가용시작일 직전날 같은 부품+같은 재질로 끝나는 구간
        let sameCont = 0;
        let start = null;
        if (av.start != null) {
          start = needDays > 1 ? this.timeline.gapStart(mc.no, from, needDays) : av.start;
          const prev = start != null ? this.timeline.prevSegmentEndingAt(mc.no, start - 1) : null;
          if (prev && up(prev.partCode) === up(item.partCode) && up(prev.material) && up(prev.material) === up(item.material)) sameCont = 1;
        }
        const worker = this.workerByMachine[mc.no] || '';
        out.push({
          machine: mc.no,
          room: str(mc.room),
          model: str(mc.model),
          material: str(mc.material),
          cutter: str(mc.cutter),
          grade,
          settingText: sm.text,
          work: st.work,
          remain: st.remain,
          availText,
          start,
          bdMaxLen: mc.bdMaxLen,
          status: conditional ? '조건부가능' : '가능',
          score,
          roomScore: re.score,
          ext: !!re.ext,
          roomReason: re.reason,
          note,
          sameCont,
          worker,
          setupLoad: worker && start != null ? this._workerSetups(worker, start) : 0,
          cont: this._continuationScore(history, mc.no, from),
          roomNo: parseInt(str(mc.room), 10) || 99,
        });
      }

      out.sort((a, b) => {
        if (a.sameCont !== b.sameCont) return b.sameCont - a.sameCont;
        const g = gradeRank(b.grade) - gradeRank(a.grade);
        if (g) return g;
        const o = opPriority(b.work) - opPriority(a.work);
        if (o) return o;
        if (a.score !== b.score) return b.score - a.score;
        if (a.worker && b.worker && a.setupLoad !== b.setupLoad) return a.setupLoad - b.setupLoad;
        if (a.cont !== b.cont) return b.cont - a.cont;
        if (a.roomNo !== b.roomNo) return a.roomNo - b.roomNo;
        return Number(a.machine) - Number(b.machine);
      });
      out.forEach((c, i) => (c.rank = i + 1));
      return { candidates: out, diag, bd };
    }

    diagText(item, diag, bd) {
      if (!item.matGroup && diag.room === 0) return '재질계열 매핑 없음: ' + (item.material || '(재질 공란)') + ' - 방마스터 기본소재계열과 연결 불가';
      if (diag.room === 0) return '방마스터 기준 후보 0대 - 재질계열=' + item.matGroup + ' / 대분류=' + item.main + ' / 생산성=' + item.prod;
      if (diag.sched === 0) return '설비마스터 일정표기/신규세팅 기준 통과 0대';
      if (diag.tech === 0) {
        if (item.main === 'BD' && bd && bd.status === '정상') return 'BD 규격범위 초과 - 외경 ' + bd.od + ' / 길이 ' + bd.len;
        return '설비마스터 기술가능(' + item.main + ') 기준 통과 0대';
      }
      if (diag.existing > 0 && diag.existing === diag.tech) return '기존 배정호기 제외 후 신규 추천후보 0대';
      return '후보 생성 후 최종 통과 0대 - 기준 점검 필요';
    }

    _partHistory(partCode) {
      const k = up(partCode).replace(/\s/g, '');
      const h = {};
      for (const [m, segs] of this.timeline.byMachine) {
        for (const seg of segs) {
          if (up(seg.partCode).replace(/\s/g, '') !== k) continue;
          if (h[m] == null || seg.e > h[m]) h[m] = seg.e;
        }
      }
      return h;
    }
    _historyScore(h, m) {
      if (h[m] == null) return 0;
      const ago = this.today - h[m];
      return ago <= 30 ? 6 : ago <= 90 ? 4 : 2;
    }
    _continuationScore(h, m, post) {
      if (h[m] == null) return 0;
      const gap = post - h[m];
      return gap <= 0 ? 2 : gap <= 3 ? 1 : 0;
    }
    _workerSetups(worker, day) {
      let n = 0;
      for (const m of this.machinesByWorker[worker] || []) for (const seg of this.timeline.segments(m)) if (seg.s === day) n++;
      return n;
    }

    /**
     * 추천 조합 (v559/v632/v633): A-즉시 → A-예약 → B-2차, C-조건부/일정주의/완료확인 필요 제외.
     */
    pickCombo(cands, count, opts) {
      const allowB = !(opts && opts.allowB === false);
      const picked = [];
      const ok = (c) => c.start != null && !String(c.availText).includes('완료확인 필요');
      const pass = (pred) => {
        for (const c of cands) {
          if (picked.length >= count) return;
          if (!picked.includes(c) && ok(c) && pred(c)) picked.push(c);
        }
      };
      pass((c) => c.grade[0] === 'A' && opPriority(c.work) === 3);
      pass((c) => c.grade[0] === 'A' && opPriority(c.work) > 0 && opPriority(c.work) !== 3);
      if (allowB) pass((c) => c.grade[0] === 'B' && opPriority(c.work) > 0);
      return picked;
    }

    /**
     * 선택 호기에 장비일수/수량 배분 (AllocationPreviewV561 + DistributeQtyHundredsV569).
     * 반환: [{machine, start, end, days, qty}] 또는 null
     */
    allocate(machines, totalQty, totalDays, from, partCode) {
      from = from != null ? from : this.baseDate;
      const ms = machines.map(machineNo).filter(Boolean);
      if (!ms.length || !(totalQty > 0) || !(totalDays > 0)) return null;
      const start = ms.map((m) => this.startFor(m, from, 1, partCode));
      const valid = start.map((s) => s != null);
      const days = ms.map(() => 0);
      const spread = () => {
        days.fill(0);
        for (let d = 0; d < totalDays; d++) {
          let best = -1;
          let bestFin = 0;
          for (let i = 0; i < ms.length; i++) {
            if (!valid[i]) continue;
            const fin = start[i] + days[i];
            if (best < 0 || fin < bestFin || (fin === bestFin && days[i] < days[best])) {
              best = i;
              bestFin = fin;
            }
          }
          if (best >= 0) days[best]++;
        }
      };
      if (!valid.some(Boolean)) return null;
      for (let pass = 0; pass < 4; pass++) {
        spread();
        let fit = true;
        for (let i = 0; i < ms.length; i++) {
          if (!valid[i] || days[i] <= 0) continue;
          const g = this.startFor(ms[i], from, days[i], partCode);
          if (g == null) {
            valid[i] = false;
            fit = false;
          } else if (g !== start[i]) {
            start[i] = g;
            fit = false;
          }
        }
        if (!valid.some(Boolean)) return null;
        if (fit) break;
      }
      spread();
      // 같은 품목의 여러 호기가 한 작업자에게 같은 날 몰리지 않도록, 앞 호기의 시작을 임시로 세면서 확정
      const temp = [];
      const release = () => temp.forEach(([m, d]) => this._countSetup(m, d, partCode, -1));
      for (let i = 0; i < ms.length; i++) {
        if (!valid[i] || days[i] <= 0) continue;
        const g = this.startFor(ms[i], from, days[i], partCode);
        if (g == null) {
          release();
          return null;
        }
        start[i] = g;
        this._countSetup(ms[i], g, partCode, 1);
        temp.push([ms[i], g]);
      }
      release();
      const qty = distributeQtyHundreds(totalQty, days);
      const res = [];
      for (let i = 0; i < ms.length; i++) {
        if (!valid[i] || days[i] <= 0) continue;
        res.push({ machine: ms[i], start: start[i], end: start[i] + days[i] - 1, days: days[i], qty: qty[i] });
      }
      return res;
    }

    /** 가배정 추가. */
    addDrafts(item, allocs, meta) {
      const added = [];
      for (const a of allocs) {
        const d = Object.assign(
          {
            id: this._draftSeq++,
            itemKey: item.key,
            planNo: item.planNo,
            productCode: item.productCode,
            partCode: item.partCode,
            material: item.material,
            machine: a.machine,
            start: a.start,
            end: a.end,
            days: a.days,
            qty: a.qty,
            multi: allocs.length > 1,
          },
          meta || {}
        );
        this.drafts.push(d);
        this.timeline.addDraft(d.machine, d.start, d.end, {
          draftId: d.id,
          itemKey: item.key,
          partCode: item.partCode,
          productCode: item.productCode,
          planNo: item.planNo,
          material: item.material,
          qty: d.qty,
          auto: d.auto,
        });
        this._countSetup(d.machine, d.start, d.partCode, 1);
        added.push(d);
      }
      return added;
    }
    removeDraftsForItem(key) {
      this.drafts = this.drafts.filter((d) => d.itemKey !== key);
      this.timeline.removeDrafts((seg) => seg.itemKey === key);
      this._rebuildSetupCount();
      delete this.results[key];
    }
    removeDraft(id) {
      const d = this.drafts.find((x) => x.id === id);
      this.drafts = this.drafts.filter((x) => x.id !== id);
      this.timeline.removeDrafts((seg) => seg.draftId === id);
      this._rebuildSetupCount();
      if (d) this._refreshResult(d.itemKey);
      return d;
    }
    clearAutoDrafts() {
      const keys = new Set(this.drafts.filter((d) => d.auto).map((d) => d.itemKey));
      this.drafts = this.drafts.filter((d) => !d.auto);
      this.timeline.removeDrafts((seg) => seg.auto);
      this._rebuildSetupCount();
      for (const k of keys) delete this.results[k];
      for (const k of Object.keys(this.results)) if (this.results[k].decision !== '수기가배정') delete this.results[k];
    }

    /** 자동배정 우선순위: 특별관리 → 요청일 빠른 순 → (요청일 없으면) 발주일 빠른 순 → 장비일수 큰 순. */
    queue() {
      const list = this.items.filter((it) => it.dupOf == null && this.workQty(it) > 0);
      return list.sort((a, b) => {
        const sa = isYes(a.special) ? 0 : 1;
        const sb = isYes(b.special) ? 0 : 1;
        if (sa !== sb) return sa - sb;
        const da = a.due == null ? 1e9 : a.due;
        const db = b.due == null ? 1e9 : b.due;
        if (da !== db) return da - db;
        const oa = a.orderDate == null ? 1e9 : a.orderDate;
        const ob = b.orderDate == null ? 1e9 : b.orderDate;
        if (oa !== ob) return oa - ob;
        return b.machineDays - a.machineDays;
      });
    }

    /**
     * 장비 대수 결정.
     * - 분산형(기본, 현장방식): 가공기간을 요청일까지 늘려 최소 대수로 편성.
     *   목표기간 T = 요청일까지 일수를 [최소 가공기간, 최대 가공기간]으로 자른 값, 대수 = 올림(장비일수 / T).
     *   요청일이 최소 가공기간 이상 남은 경우에만, 늦어지면 한 대씩 늘린다 (이미 늦은 품목에 호기를 몰지 않음).
     * - 집중형: 기존 권장대수(1/2/2~3/3~5) 하한부터, 늦으면 상한까지 확장.
     */
    _countRange(item, days) {
      const maxMachines = this.opts.maxMachines || 6;
      if (this.opts.allocMode === 'fast') {
        const rec = parseRecRange(recommendMachineRange(days));
        if (rec) return { min: rec.min, max: Math.min(this.opts.expandToDue === false ? rec.min : rec.max, maxMachines) };
        const need = Math.ceil(days / Math.max(1, item.availDays));
        const n = Math.min(Math.max(need, 3), maxMachines);
        return { min: n, max: this.opts.expandToDue === false ? n : Math.max(n, Math.min(maxMachines, n + 2)) };
      }
      const minRun = Math.max(1, this.opts.minRunDays || 7);
      const maxRun = Math.max(minRun, this.opts.maxRunDays || 30);
      const toDue = item.due != null ? item.due - this.baseDate + 1 : null;
      const target = Math.min(Math.max(toDue == null ? maxRun : toDue, minRun), maxRun);
      const n = Math.min(Math.max(1, Math.ceil(days / target)), maxMachines);
      const canExpand = this.opts.expandToDue !== false && toDue != null && toDue >= minRun;
      return { min: n, max: canExpand ? maxMachines : n };
    }

    /**
     * 방 허용 확장(기준 설정): 방마스터로는 갈 수 없는 품목을 지정한 방에도 허용한다.
     * 규칙 예: "SK 커터 = 4번방" (소재계열 생산성분류 = 방). 방의 허용대분류·자동후보사용은 그대로 지킨다.
     */
    _roomExtension(room, item) {
      if (!room || up(room.autoUse) === 'N' || isRoom7(room.name)) return null;
      if (str(room.mainAllowed) && !containsToken(room.mainAllowed, item.main)) return null;
      for (const r of this.roomRules) {
        if (!r.rooms.has(str(room.name))) continue;
        if (r.mat !== '*' && r.mat !== up(item.matGroup)) continue;
        if (r.prod !== '*' && r.prod !== up(item.prod)) continue;
        return { score: 5, reason: '방 허용 확장(' + r.text + ')', conditional: false, ext: true };
      }
      return null;
    }

    /**
     * 방마스터 적합 단계: 0 = 기본소재계열과 우선생산성분류가 모두 맞는 방(1순위),
     * 1 = 그 밖의 A등급(소재계열만 맞고 현재소재도 같은 호기), 2 = 방 허용 확장, 3 = B-2차후보.
     */
    roomTier(c) {
      if (c.ext) return 2;
      if (c.grade[0] === 'B') return 3;
      return c.roomScore >= 150 ? 0 : 1;
    }

    /**
     * 일괄배정용 호기 선택. 방마스터 기준을 최대한 지키되, 앞 단계 방이 많이 밀려 있으면 다음 단계 방을 쓴다:
     * - 정렬 키 = 시작 가능일 + 단계 × 방 대기 허용일(기본 14일) − 동일부품 연속가공 1일.
     *   즉 1순위 방이 다음 단계 방보다 14일 넘게 늦게 비어야 다음 단계 방을 쓴다.
     * - 가장 앞선 후보와 같은 단계·비슷한 시기(대기 허용일 안) 호기끼리는 방(조)당 perGroup대, 다른 담당작업자 우선으로 나누고,
     *   모자라면 정렬 순서대로 채운다.
     * - B-2차후보는 기본 대수가 모자랄 때(allowBFill)만, C-조건부·일정주의·완료확인 필요는 자동선택하지 않는다.
     */
    batchPick(cands, count, perDays, from, partCode, allowBFill) {
      const allowB = this.opts.allowB !== false && allowBFill !== false;
      const perGroup = this.opts.allocMode === 'fast' ? 0 : this.opts.perGroupMax != null ? this.opts.perGroupMax : 1;
      const wait = this.opts.roomWaitDays != null ? this.opts.roomWaitDays : 14;
      const pool = [];
      for (const c of cands) {
        if (c.grade[0] === 'C') continue;
        if (opPriority(c.work) === 0 || String(c.availText).includes('완료확인 필요')) continue;
        const tier = this.roomTier(c);
        if (tier === 3 && !allowB) continue;
        const start = this.startFor(c.machine, from, perDays, partCode);
        if (start == null) continue;
        pool.push({ c, tier, key: start - (c.sameCont ? 1 : 0) + tier * wait, group: this.groupOf[c.machine], worker: this.workerByMachine[c.machine] || 'm' + c.machine });
      }
      pool.sort((a, b) => a.key - b.key || b.c.score - a.c.score || a.c.rank - b.c.rank);
      if (!pool.length) return [];
      const picked = [];
      const usedGroup = new Map();
      const usedWorker = new Set();
      const take = (p) => {
        picked.push(p);
        usedGroup.set(p.group, (usedGroup.get(p.group) || 0) + 1);
        usedWorker.add(p.worker);
      };
      if (perGroup) {
        const head = pool.filter((p) => p.tier === pool[0].tier && p.key <= pool[0].key + wait);
        for (let lim = perGroup; picked.length < count && lim <= count; lim++)
          for (const newWorkerOnly of [true, false])
            for (const p of head) {
              if (picked.length >= count) break;
              if (picked.includes(p) || (usedGroup.get(p.group) || 0) >= lim) continue;
              if (newWorkerOnly && usedWorker.has(p.worker)) continue;
              take(p);
            }
      }
      for (const newWorkerOnly of perGroup ? [true, false] : [false])
        for (const p of pool) {
          if (picked.length >= count) break;
          if (picked.includes(p) || (newWorkerOnly && usedWorker.has(p.worker))) continue;
          take(p);
        }
      return picked.map((p) => p.c);
    }

    /** 품목 1건 자동 가배정 시도. */
    autoAssignItem(item) {
      const block = this.autoBlockReason(item);
      if (block) return (this.results[item.key] = { decision: '수기검토', reason: block });
      const qty = this.workQty(item);
      if (qty <= 0) return (this.results[item.key] = { decision: '배정완료', reason: '' });
      const days = this.planDays(item, qty);
      const from = this.baseDate;
      const q = this.candidates(item, { from });
      const cands = q.candidates;
      if (!cands.length) return (this.results[item.key] = { decision: '수기검토', reason: this.diagText(item, q.diag, q.bd) });
      const range = this._countRange(item, days);
      let best = null;
      for (let n = range.min; n <= range.max; n++) {
        const combo = this.batchPick(cands, n, Math.ceil(days / n), from, item.partCode, n === range.min);
        if (!combo.length) break;
        const a = this.allocate(
          combo.map((c) => c.machine),
          qty,
          days,
          from,
          item.partCode
        );
        if (!a) continue;
        const finish = Math.max(...a.map((x) => x.end));
        if (!best || finish < best.finish) best = { combo, allocs: a, finish };
        if (item.due == null || finish <= item.due || combo.length < n) break;
      }
      if (!best) {
        const cond = cands.filter((c) => c.grade[0] === 'C').length;
        const delayed = cands.filter((c) => String(c.availText).includes('완료확인 필요')).length;
        let reason;
        if (item.main === 'BD' && q.bd && q.bd.status !== '정상' && cond === cands.length)
          reason = 'BD규격 ' + q.bd.status + ' - 21_BD규격마스터에 외경/길이 등록 시 자동배정 (조건부 ' + cond + '대)';
        else {
          reason = '자동선택 가능한 안전후보 없음';
          if (cond) reason += ' / 조건부 ' + cond + '대(도면확인)';
          if (delayed) reason += ' / 완료확인 필요 ' + delayed + '대';
        }
        return (this.results[item.key] = { decision: '수기검토', reason, candidateCount: cands.length });
      }
      const { combo, allocs, finish } = best;
      const late = item.due != null && finish > item.due ? finish - item.due : 0;
      const used = new Set(allocs.map((a) => a.machine));
      this.addDrafts(item, allocs, { auto: true, grade: combo.filter((c) => used.has(c.machine)).map((c) => c.grade).join('/') });
      return (this.results[item.key] = {
        decision: late > 0 ? '가배정(납기지연)' : '가배정',
        reason: late > 0 ? '예상완료 ' + fmtMD(finish) + ' (요청일 +' + late + '일)' : '',
        finish,
        late,
        machines: allocs.map((a) => a.machine),
      });
    }

    /** 전체 미배정 품목 일괄 자동 가배정. */
    autoPlan(onProgress) {
      const queue = this.queue();
      let i = 0;
      for (const it of queue) {
        const r = this.results[it.key];
        if (r && r.decision === '수기가배정') continue;
        this.autoAssignItem(it);
        i++;
        if (onProgress && i % 50 === 0) onProgress(i, queue.length);
      }
      return this.summary();
    }

    /** 수기 가배정: 담당자가 고른 호기로 잔량 배분. */
    manualAssign(item, machines, opts) {
      const qty = opts && opts.qty > 0 ? Math.min(opts.qty, this.workQty(item) || opts.qty) : this.workQty(item);
      const days = opts && opts.days > 0 ? opts.days : this.planDays(item, qty) || 1;
      const allocs = this.allocate(machines, qty, days, opts && opts.from, item.partCode);
      if (!allocs) return null;
      this.addDrafts(item, allocs, { auto: false, manual: true });
      const finish = Math.max(...allocs.map((x) => x.end));
      const late = item.due != null && finish > item.due ? finish - item.due : 0;
      this.results[item.key] = {
        decision: '수기가배정',
        reason: late > 0 ? '예상완료 ' + fmtMD(finish) + ' (요청일 +' + late + '일)' : '',
        finish,
        late,
        machines: allocs.map((a) => a.machine),
      };
      return allocs;
    }

    /**
     * 담당자 조정: 가배정 1건의 호기/시작일/장비일/수량 변경.
     * 다른 일정(확정·가배정·고장)과 겹치거나 완료확인 필요 호기면 거절. 반환 {ok, error}
     */
    updateDraft(id, change) {
      const d = this.drafts.find((x) => x.id === id);
      if (!d) return { ok: false, error: '가배정을 찾을 수 없습니다' };
      const m = change.machine != null ? machineNo(change.machine) : d.machine;
      if (!this.machineByNo[m]) return { ok: false, error: m + '호기는 설비마스터에 없습니다' };
      const start = change.start != null ? change.start : d.start;
      const days = Math.max(1, Math.round(change.days != null ? change.days : d.days));
      const qty = change.qty != null ? Math.max(0, Math.round(change.qty)) : d.qty;
      const end = start + days - 1;
      if (start < this.today) return { ok: false, error: '시작일이 오늘보다 빠릅니다' };
      if (this.timeline.status(m).delayed) return { ok: false, error: m + '호기는 완료확인 필요 상태입니다 (9번 시트 실적 입력 필요)' };
      // 겹치는 뒤쪽 가배정은 pushNext면 길이를 유지한 채 뒤로 민다(확정·고장 일정은 움직이지 않음)
      const moves = [];
      let cursor = end;
      const others = this.timeline
        .segments(m)
        .filter((seg) => seg.draftId !== id)
        .sort((a, b) => a.s - b.s);
      const fixed = others
        .filter((seg) => seg.kind !== 'draft')
        .map((seg) => ({ s: seg.s, e: seg.effEnd, label: seg.partCode + '(확정)' }))
        .concat((this.timeline.blocks[m] || []).map((b) => ({ s: b.s, e: b.e, label: b.label })));
      const hit = (a, b, list) => list.find((x) => x.s <= b && x.e >= a);
      let c = hit(start, end, fixed);
      if (c) return { ok: false, error: m + '호기 ' + fmtMD(c.s) + '~' + fmtMD(c.e) + ' ' + c.label + ' 일정과 겹칩니다' };
      for (const seg of others) {
        if (seg.kind !== 'draft' || seg.e < start) continue;
        if (seg.s > cursor) break;
        if (!change.pushNext) return { ok: false, error: m + '호기 ' + fmtMD(seg.s) + '~' + fmtMD(seg.e) + ' ' + seg.partCode + '(가배정) 일정과 겹칩니다 – [뒤 가배정 밀기]를 켜면 뒤로 밀 수 있습니다' };
        const len = seg.e - seg.s;
        const ns = cursor + 1;
        c = hit(ns, ns + len, fixed);
        if (c) return { ok: false, error: '밀려난 ' + seg.partCode + '가 ' + m + '호기 ' + fmtMD(c.s) + '~' + fmtMD(c.e) + ' ' + c.label + ' 일정과 겹칩니다' };
        moves.push({ draftId: seg.draftId, s: ns, e: ns + len });
        cursor = ns + len;
      }
      this.timeline.removeDrafts((seg) => seg.draftId === id);
      Object.assign(d, { machine: m, start, end, days, qty });
      this.timeline.addDraft(m, start, end, { draftId: d.id, itemKey: d.itemKey, partCode: d.partCode, productCode: d.productCode, planNo: d.planNo, material: d.material, qty });
      const touched = new Set();
      for (const mv of moves) {
        const od = this.drafts.find((x) => x.id === mv.draftId);
        const seg = this.timeline.segments(m).find((x) => x.draftId === mv.draftId);
        od.start = seg.s = mv.s;
        od.end = seg.e = seg.effEnd = mv.e;
        touched.add(od.itemKey);
      }
      this.timeline.segments(m).sort((a, b) => a.s - b.s || a.e - b.e);
      for (const k of touched) if (k !== d.itemKey) this._refreshResult(k);
      this._markManual(d.itemKey);
      this._rebuildSetupCount();
      return { ok: true, pushed: moves.length };
    }
    /** 품목의 가배정을 담당자 조정분으로 고정(자동 재계산 시 유지)하고 결과를 다시 계산. */
    _markManual(key) {
      for (const x of this.drafts)
        if (x.itemKey === key) {
          x.auto = false;
          x.manual = true;
        }
      for (const segs of this.timeline.byMachine.values()) for (const seg of segs) if (seg.itemKey === key) seg.auto = false;
      this._refreshResult(key, '수기가배정');
    }
    _refreshResult(key, decision) {
      const item = this.itemByKey[key];
      const ds = this.drafts.filter((x) => x.itemKey === key);
      const prev = this.results[key] || {};
      if (!ds.length) {
        delete this.results[key];
        return;
      }
      const finish = Math.max(...ds.map((x) => x.end));
      const late = item && item.due != null && finish > item.due ? finish - item.due : 0;
      this.results[key] = {
        decision: decision || prev.decision || '가배정',
        reason: late > 0 ? '예상완료 ' + fmtMD(finish) + ' (요청일 +' + late + '일)' : '',
        finish,
        late,
        lateAck: late > 0 && prev.lateAck && prev.ackFinish === finish ? true : false,
        heavyAck: !!prev.heavyAck,
        ackFinish: prev.ackFinish,
        machines: ds.map((x) => x.machine),
      };
    }
    /**
     * 담당자 조정: 품목을 n대로 다시 배분한다(총 장비일·수량 유지 → 호기가 줄면 가공기간이 길어짐).
     * 지금 쓰는 호기 중 먼저 시작하는 n대를 남긴다. 실패하면 원래대로 되돌린다. 반환 {ok, error}
     */
    reshapeItem(key, n) {
      const item = this.itemByKey[key];
      const ds = this.drafts.filter((d) => d.itemKey === key).sort((a, b) => a.start - b.start || a.machine - b.machine);
      n = Math.max(1, Math.round(n));
      if (!item || !ds.length) return { ok: false, error: '가배정이 없습니다' };
      const machines = [...new Set(ds.map((d) => d.machine))].slice(0, n);
      const qty = ds.reduce((a, d) => a + d.qty, 0);
      const days = ds.reduce((a, d) => a + d.days, 0);
      const backup = ds.map((d) => Object.assign({}, d));
      const prevResult = this.results[key];
      this.removeDraftsForItem(key);
      const allocs = this.allocate(machines, qty, days, Math.min(...backup.map((d) => d.start)), item.partCode);
      if (!allocs) {
        for (const d of backup) this.addDrafts(item, [d], { auto: d.auto, manual: d.manual, grade: d.grade });
        this.results[key] = prevResult;
        return { ok: false, error: '배정 가능한 빈 구간이 없습니다' };
      }
      this.addDrafts(item, allocs, { auto: false, manual: true });
      this._refreshResult(key, '수기가배정');
      this.results[key].heavyAck = true;
      return { ok: true, machines: allocs.length, finish: Math.max(...allocs.map((a) => a.end)) };
    }
    /** 호기 다수 점유 품목: 가배정 호기 수가 기준(heavyMachines, 기본 5) 이상이고 담당자가 아직 검토하지 않음. */
    isHeavy(key) {
      const r = this.results[key];
      const n = new Set(this.drafts.filter((d) => d.itemKey === key).map((d) => d.machine)).size;
      return n >= (this.opts.heavyMachines || 5) && !(r && r.heavyAck);
    }
    ackHeavy(key, on) {
      const r = this.results[key];
      if (!r) return false;
      r.heavyAck = !!on;
      return true;
    }

    /** 납기초과를 담당자가 확인함(목록에서 '지연확인'으로 분리). 일정이 바뀌면 다시 확인 필요. */
    ackLate(key, on) {
      const r = this.results[key];
      if (!r || !(r.late > 0)) return false;
      r.lateAck = !!on;
      r.ackFinish = on ? r.finish : null;
      return true;
    }

    itemState(item) {
      const r = this.results[item.key];
      const dq = this.draftQty(item.key);
      if (item.dupOf != null) return { label: '중복행', cls: 'muted' };
      if (item.status === '배정완료' && !dq) return { label: '배정완료', cls: 'done' };
      if (item.status === '입고완료') return { label: '입고완료', cls: 'done' };
      if (item.status === '배정초과') return { label: '배정초과', cls: 'bad' };
      if (dq > 0) {
        const left = this.workQty(item);
        if (left > 0) return { label: '일부가배정', cls: 'warn' };
        if (r && r.late > 0) return r.lateAck ? { label: '지연확인', cls: 'warn' } : { label: '가배정(지연)', cls: 'late' };
        return { label: '가배정', cls: 'draft' };
      }
      if (r && r.decision === '수기검토') return { label: '수기검토', cls: 'review' };
      if (item.status === '추가배정') return { label: '추가배정', cls: 'warn' };
      return { label: '미배정', cls: 'todo' };
    }

    summary() {
      const s = { items: 0, done: 0, draft: 0, late: 0, lateAck: 0, review: 0, todo: 0, drafts: this.drafts.length, machines: new Set(this.drafts.map((d) => d.machine)).size };
      for (const it of this.items) {
        if (it.dupOf != null) continue;
        s.items++;
        const st = this.itemState(it).label;
        if (st === '배정완료' || st === '배정초과' || st === '입고완료') s.done++;
        else if (st === '가배정') s.draft++;
        else if (st === '가배정(지연)') {
          s.draft++;
          s.late++;
        } else if (st === '지연확인') {
          s.draft++;
          s.lateAck++;
        } else if (st === '수기검토') s.review++;
        else s.todo++;
      }
      return s;
    }

    /** 9_설비배정_확정 형식 행 (가배정 → 확정 붙여넣기용). 초기이관을 쓴 경우 그 행을 앞에 붙인다. */
    confirmRows() {
      const rows = [];
      if (this.initial.used)
        for (const c of this.initial.rows)
          rows.push({ planNo: c.planNo, productCode: c.productCode, partCode: c.partCode, machine: Number(c.machine), start: c.start, end: c.end, qty: c.qty, newSetup: 'Y', worker: this.workerByMachine[c.machine] || '', note: c.note, initial: true });
      const sorted = this.drafts.slice().sort((a, b) => a.start - b.start || Number(a.machine) - Number(b.machine));
      for (const d of sorted) {
        const worker = this.workerByMachine[d.machine] || '';
        const tl = this.timeline;
        const prev = tl.prevSegmentEndingAt(d.machine, d.start - 1);
        const cont = prev && up(prev.partCode) === up(d.partCode);
        const tags = [d.manual ? '수기선택' : '자동가배정', d.multi ? '다중호기/수량배분' : '', '달력일기준'].filter(Boolean).join('/');
        rows.push({
          planNo: d.planNo,
          productCode: d.productCode,
          partCode: d.partCode,
          machine: Number(d.machine),
          start: d.start,
          end: d.end,
          qty: d.qty,
          newSetup: cont ? 'N' : 'Y',
          worker,
          note: '부품코드: ' + d.partCode + ' / ' + tags,
        });
      }
      return rows;
    }

    /** 11_프로그램입력요약 형식 (계획별 설비1~설비A). */
    programSummary() {
      const byKey = new Map();
      for (const d of this.drafts) {
        const k = d.planNo + '|' + d.productCode;
        let e = byKey.get(k);
        if (!e) byKey.set(k, (e = { planNo: d.planNo, productCode: d.productCode, start: d.start, end: d.end, machines: [] }));
        e.start = Math.min(e.start, d.start);
        e.end = Math.max(e.end, d.end);
        if (!e.machines.includes(d.machine)) e.machines.push(d.machine);
      }
      return [...byKey.values()].map((e) => ({
        planNo: e.planNo,
        productCode: e.productCode,
        start: e.start,
        end: e.end,
        machines: e.machines.map(Number).sort((a, b) => a - b),
        note: e.machines.length > 10 ? '10대 초과 - 9번 확정시트 기준 관리' : '',
      }));
    }

    exportState() {
      return { drafts: this.drafts, results: this.results };
    }
    importState(state) {
      if (!state || !Array.isArray(state.drafts)) return 0;
      let n = 0;
      for (const d of state.drafts) {
        const item = this.itemByKey[d.itemKey];
        if (!item) continue;
        this.addDrafts(item, [d], { auto: d.auto, manual: d.manual, grade: d.grade });
        n++;
      }
      for (const [k, v] of Object.entries(state.results || {})) if (this.itemByKey[k]) this.results[k] = v;
      return n;
    }
  }

  /**
   * 일정관리 프로그램 기존 배정(설비1~A + 개시/완료) → 확정일정 행 (v670 BuildInitialImportPreview).
   * 미납잔량을 호기 수로 균등분할. 개시가 없으면 완료일 하루, 날짜가 없거나 개시>완료이면 제외(skipped).
   */
  function programAssignments(items) {
    const rows = [];
    const skipped = [];
    for (const it of items) {
      if (it.dupOf != null || !it.refMachines || !it.refMachines.length) continue;
      const ms = [...new Set(it.refMachines.filter((m) => /^\d+$/.test(m) && Number(m) > 0))];
      if (!ms.length) continue;
      let s = it.progStart;
      const e = it.progEnd;
      if (s == null && e != null) s = e;
      if (s == null || e == null || s > e || !(it.openQty > 0)) {
        skipped.push({ planNo: it.planNo, partCode: it.partCode, machines: ms, reason: !(it.openQty > 0) ? '미납잔량 없음' : s == null || e == null ? '개시/완료일 없음' : '개시일이 완료일보다 늦음' });
        continue;
      }
      const total = Math.round(it.openQty);
      const base = Math.floor(total / ms.length);
      ms.forEach((m, i) => {
        rows.push({
          planNo: it.planNo,
          productCode: it.productCode,
          partCode: it.partCode,
          machine: m,
          start: s,
          end: e,
          qty: base + (i < total - base * ms.length ? 1 : 0),
          actualQty: 0,
          note: '초기이관/미납잔량 ' + total.toLocaleString('ko-KR') + (ms.length > 1 ? '/수량균등분할' + ms.length + '대' : ''),
          source: 'program',
        });
      });
    }
    return { rows, skipped };
  }

  function distributeQtyHundreds(totalQty, allocDays) {
    const n = allocDays.length;
    const qty = new Array(n).fill(0);
    const active = allocDays.map((d, i) => (d > 0 ? i : -1)).filter((i) => i >= 0);
    if (!active.length || !(totalQty > 0)) return qty;
    if (active.length === 1) {
      qty[active[0]] = totalQty;
      return qty;
    }
    const activeDays = active.reduce((s, i) => s + allocDays[i], 0);
    const blocks = Math.floor(totalQty / 100);
    const residual = totalQty % 100;
    const frac = new Array(n).fill(0);
    const used = new Array(n).fill(false);
    let assigned = 0;
    for (const i of active) {
      const raw = (blocks * allocDays[i]) / activeDays;
      qty[i] = Math.floor(raw) * 100;
      assigned += Math.floor(raw);
      frac[i] = raw - Math.floor(raw);
    }
    let remain = blocks - assigned;
    while (remain > 0) {
      let best = -1;
      for (const i of active) {
        if (used[i]) continue;
        if (best < 0 || frac[i] > frac[best] || (frac[i] === frac[best] && allocDays[i] > allocDays[best])) best = i;
      }
      if (best < 0) {
        used.fill(false);
        continue;
      }
      qty[best] += 100;
      used[best] = true;
      remain--;
    }
    if (residual > 0) {
      let best = active[0];
      for (const i of active) if (allocDays[i] > allocDays[best]) best = i;
      qty[best] += residual;
    }
    return qty;
  }

  return {
    // 날짜
    serialFromYMD,
    serialFromDate,
    dateFromSerial,
    todaySerial,
    toSerial,
    fmtMD,
    fmtYMD,
    // 값
    toNum,
    str,
    up,
    isYes,
    machineNo,
    parseMachineList,
    itemKey,
    // 규칙
    prepareRules,
    classifyPart,
    getMainClass,
    recommendMachineRange,
    parseRecRange,
    materialGroup,
    parseMaterialMap,
    parseRoomRules,
    exactMaterial,
    settingFamily,
    settingMatch,
    roomEligible,
    lookupBDSpec,
    parseBGCode,
    daysForQty,
    qtyBand,
    distributeQtyHundreds,
    opPriority,
    buildItems,
    programAssignments,
    Timeline,
    Planner,
  };
});
