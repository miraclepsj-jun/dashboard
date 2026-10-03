/* CNC 가공일정 수립 - 화면 */
(function () {
  'use strict';
  const E = window.CNCEngine;
  const W = window.CNCWorkbook;
  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const nf = (n) => (n == null || n === '' ? '' : Number(n).toLocaleString('ko-KR'));

  const store = {
    get(k, d) {
      try {
        const v = localStorage.getItem(k);
        return v == null ? d : JSON.parse(v);
      } catch (e) {
        return d;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(k, JSON.stringify(v));
      } catch (e) {
        /* 저장 불가(사생활 보호 모드 등) - 무시 */
      }
    },
  };

  const today = E.todaySerial();
  const SETTINGS_VERSION = 3;
  const DEFAULTS = {
    v: SETTINGS_VERSION,
    baseOffset: 1,
    allocMode: 'spread',
    minRunDays: 7,
    maxRunDays: 30,
    maxMachines: 6,
    perGroupMax: 1,
    setupLimitPerWorkerDay: 5,
    allowB: true,
    bSlackDays: 2,
    expandToDue: true,
    delayPolicy: 'block',
    requireActualOk: false,
    matMap: '',
  };
  const savedSettings = store.get('cnc.settings', {});
  const S = {
    model: null,
    source: '',
    isDemo: true,
    planner: null,
    // 배정방식이 바뀐 이전 버전 저장값은 소재매핑만 이어받는다
    settings: savedSettings.v === SETTINGS_VERSION ? Object.assign({}, DEFAULTS, savedSettings) : Object.assign({}, DEFAULTS, { matMap: savedSettings.matMap || '' }),
    baseDate: today + 1,
    tab: store.get('cnc.tab', 'items'),
    page: 0,
    openKey: null,
    selDraft: null,
  };
  S.baseDate = today + (S.settings.baseOffset != null ? S.settings.baseOffset : 1);

  function plannerOpts() {
    return {
      today,
      baseDate: S.baseDate,
      allocMode: S.settings.allocMode,
      minRunDays: S.settings.minRunDays,
      maxRunDays: S.settings.maxRunDays,
      maxMachines: S.settings.maxMachines,
      perGroupMax: S.settings.perGroupMax,
      setupLimitPerWorkerDay: S.settings.setupLimitPerWorkerDay,
      allowB: S.settings.allowB,
      bSlackDays: S.settings.bSlackDays,
      expandToDue: S.settings.expandToDue,
      delayPolicy: S.settings.delayPolicy,
      requireActualOk: S.settings.requireActualOk,
      materialMap: E.parseMaterialMap(S.settings.matMap),
    };
  }

  function draftStoreKey() {
    return 'cnc.drafts.' + (S.isDemo ? '예시' : S.source);
  }
  function saveDrafts() {
    if (S.planner) store.set(draftStoreKey(), S.planner.exportState());
  }

  /** 모델/설정 변경 시 플래너 재생성. keep: 'all' | 'manual' | 'none' */
  function rebuild(keep) {
    const old = S.planner ? S.planner.exportState() : store.get(draftStoreKey(), null);
    S.planner = new E.Planner(S.model, plannerOpts());
    let restored = 0;
    if (old && keep !== 'none') {
      const drafts = keep === 'manual' ? old.drafts.filter((d) => d.manual) : old.drafts;
      const results = {};
      for (const [k, v] of Object.entries(old.results || {})) if (keep !== 'manual' || v.decision === '수기가배정') results[k] = v;
      restored = S.planner.importState({ drafts, results });
    }
    return restored;
  }

  // ───────────────────────── 공통 UI ─────────────────────────
  let toastTimer = 0;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 3800);
  }
  function busy(text, fn) {
    $('busyText').textContent = text;
    $('busy').hidden = false;
    setTimeout(() => {
      try {
        fn();
      } catch (e) {
        console.error(e);
        toast('처리 중 오류: ' + e.message);
      } finally {
        $('busy').hidden = true;
      }
    }, 30);
  }

  function statePill(it) {
    const st = S.planner.itemState(it);
    return '<span class="pill ' + st.cls + '">' + esc(st.label) + '</span>';
  }
  function gradeHtml(g) {
    return '<span class="grade ' + esc(String(g)[0]) + '">' + esc(g) + '</span>';
  }
  function draftsOf(key) {
    return S.planner.drafts.filter((d) => d.itemKey === key).sort((a, b) => a.start - b.start);
  }
  function draftSummary(key, max) {
    const ds = draftsOf(key);
    if (!ds.length) return '';
    const parts = ds.slice(0, max || 3).map((d) => '<b>' + esc(d.machine) + '</b> ' + E.fmtMD(d.start) + '~' + E.fmtMD(d.end));
    if (ds.length > (max || 3)) parts.push('+' + (ds.length - (max || 3)) + '대');
    return parts.join(' · ');
  }

  // ───────────────────────── 렌더링 ─────────────────────────
  function renderAll() {
    renderSource();
    renderKpis();
    renderTabs();
    if (S.tab === 'items') renderItems();
    if (S.tab === 'gantt') renderGantt();
    if (S.tab === 'review') renderReview();
    if (S.tab === 'master') renderMaster();
    renderReviewCount();
    if (S.openKey) renderDrawer();
  }

  function renderSource() {
    const m = S.model;
    const txt = S.isDemo
      ? '예시 데이터(가상)로 열려 있습니다 · [엑셀 불러오기]로 회사 통합문서(.xlsm)를 여세요'
      : S.source + ' · 원본 ' + nf(m.raw.length) + '행 · 설비 ' + nf(m.machines.length) + '대 · 확정일정 ' + nf(m.confirmed.length) + '건 · 기준게시일 ' + E.fmtYMD(S.baseDate);
    $('sourceLine').textContent = txt;
  }

  function renderKpis() {
    const P = S.planner;
    const s = P.summary();
    const ends = P.drafts.map((d) => d.end);
    const last = ends.length ? Math.max(...ends) : null;
    const delayed = P.machines.filter((m) => P.timeline.status(m.no).delayed).length;
    const kp = [
      { label: '배정 대상 품목', value: nf(s.items), sub: '배정완료 ' + nf(s.done) + '건 포함' },
      { label: '가배정', value: nf(s.draft), sub: (S.settings.allocMode === 'spread' ? '분산형' : '집중형') + ' · 호기 ' + nf(s.machines) + '대 · 배정행 ' + nf(s.drafts), cls: 'draft' },
      { label: '납기 초과 예상', value: nf(s.late), sub: '요청일보다 늦게 끝나는 가배정', cls: 'late' },
      { label: '수기검토', value: nf(s.review), sub: '자동기준 밖 품목', cls: 'review' },
      { label: '미처리', value: nf(s.todo), sub: s.todo ? '[자동 일정수립] 실행 필요' : '남은 품목 없음' },
      { label: '가배정 최종완료', value: last ? E.fmtMD(last) : '-', sub: '완료확인 필요 호기 ' + delayed + '대' },
    ];
    $('kpis').innerHTML = kp
      .map((k) => '<div class="kpi ' + (k.cls || '') + '"><span class="label">' + esc(k.label) + '</span><span class="value">' + esc(k.value) + '</span><span class="sub">' + esc(k.sub) + '</span></div>')
      .join('');
  }

  function renderTabs() {
    for (const b of document.querySelectorAll('.tab')) b.setAttribute('aria-selected', String(b.dataset.tab === S.tab));
    for (const t of ['items', 'gantt', 'review', 'master']) $('panel-' + t).hidden = t !== S.tab;
  }
  function renderReviewCount() {
    const n = S.planner.summary().review;
    $('reviewCount').textContent = n ? nf(n) : '';
  }

  // 품목 목록
  const PAGE = 100;
  function filteredItems() {
    const q = $('itemSearch').value.trim().toUpperCase();
    const st = $('itemState').value;
    const mn = $('itemMain').value;
    return S.planner.items.filter((it) => {
      if (it.dupOf != null) return false;
      if (mn && it.main !== mn) return false;
      if (st && S.planner.itemState(it).label !== st) return false;
      if (q && !(it.planNo + ' ' + it.productCode + ' ' + it.partCode).toUpperCase().includes(q)) return false;
      return true;
    });
  }
  function renderItems() {
    const mains = [...new Set(S.planner.items.map((i) => i.main))].sort();
    const sel = $('itemMain');
    if (sel.dataset.sig !== mains.join('|')) {
      const cur = sel.value;
      sel.innerHTML = '<option value="">전체 대분류</option>' + mains.map((m) => '<option>' + esc(m) + '</option>').join('');
      sel.value = mains.includes(cur) ? cur : '';
      sel.dataset.sig = mains.join('|');
    }
    const list = filteredItems();
    const pages = Math.max(1, Math.ceil(list.length / PAGE));
    if (S.page >= pages) S.page = pages - 1;
    const rows = list.slice(S.page * PAGE, S.page * PAGE + PAGE);
    const P = S.planner;
    $('itemTable').tBodies[0].innerHTML = rows
      .map((it) => {
        const r = P.results[it.key] || {};
        const due = it.due != null ? E.fmtMD(it.due) : '-';
        return (
          '<tr data-key="' + esc(it.key) + '">' +
          '<td>' + statePill(it) + '</td>' +
          '<td class="code">' + esc(it.planNo || '-') + '</td>' +
          '<td class="code">' + esc(it.productCode) + '</td>' +
          '<td class="code">' + esc(it.partCode) + '</td>' +
          '<td class="num">' + nf(it.qty) + '</td>' +
          '<td class="num">' + nf(P.workQty(it)) + '</td>' +
          '<td class="when">' + esc(due) + '</td>' +
          '<td>' + esc(it.main + ' · ' + it.prod) + '</td>' +
          '<td>' + esc(it.material) + '</td>' +
          '<td class="num">' + (it.machineDays || '') + '</td>' +
          '<td>' + esc(it.rec === 'Manual Review' ? '수동' : it.rec) + '</td>' +
          '<td class="when">' + draftSummary(it.key) + '</td>' +
          '<td class="reason">' + esc(r.reason || it.note || '') + '</td>' +
          '</tr>'
        );
      })
      .join('');
    $('itemCountText').textContent = nf(list.length) + '건';
    let pg = '';
    if (pages > 1) {
      pg += '<button class="btn small" data-page="' + (S.page - 1) + '"' + (S.page === 0 ? ' disabled' : '') + '>이전</button>';
      pg += '<span class="hint">' + (S.page + 1) + ' / ' + pages + ' 페이지</span>';
      pg += '<button class="btn small" data-page="' + (S.page + 1) + '"' + (S.page >= pages - 1 ? ' disabled' : '') + '>다음</button>';
    }
    $('itemPager').innerHTML = pg;
  }

  // 부품코드별 색: 같은 부품은 같은 색, 일정이 가까운 부품끼리는 색상환에서 멀리 떨어지도록 황금각으로 배정
  const partColors = new Map();
  function hslRgb(h, s, l) {
    s /= 100;
    l /= 100;
    const k = (n) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return [f(0), f(8), f(4)];
  }
  function buildPartColors() {
    const first = new Map();
    for (const segs of S.planner.timeline.byMachine.values())
      for (const seg of segs) {
        const k = E.up(seg.partCode);
        if (k && (!first.has(k) || seg.s < first.get(k))) first.set(k, seg.s);
      }
    const parts = [...first.entries()].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1));
    partColors.clear();
    parts.forEach(([k], i) => {
      const h = (i * 137.508) % 360;
      const l = [52, 66, 42][i % 3];
      const sat = [62, 55, 58][Math.floor(i / 3) % 3];
      const [r, g, b] = hslRgb(h, sat, l);
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      partColors.set(k, { bg: 'hsl(' + h.toFixed(0) + ' ' + sat + '% ' + l + '%)', fg: lum > 0.5 ? '#10161c' : '#ffffff' });
    });
  }
  function partStyle(part) {
    const c = partColors.get(E.up(part));
    return c ? '--pc:' + c.bg + ';--pt:' + c.fg + ';' : '';
  }

  // 간트
  const G = { rows: [], from: today - 3, days: 60, day: 30, row: 26, left: 112 };
  function ganttMetrics() {
    const cs = getComputedStyle($('gantt'));
    G.day = parseFloat(cs.getPropertyValue('--day')) || 30;
    G.row = parseFloat(cs.getPropertyValue('--row')) || 26;
    G.left = parseFloat(cs.getPropertyValue('--left')) || 112;
  }
  function renderGantt() {
    const P = S.planner;
    ganttMetrics();
    const rooms = [...new Set(P.machines.map((m) => m.room))];
    const rs = $('ganttRoom');
    if (rs.dataset.sig !== rooms.join('|')) {
      const cur = rs.value;
      rs.innerHTML = '<option value="">전체 방</option>' + rooms.map((r) => '<option>' + esc(r) + '</option>').join('');
      rs.value = rooms.includes(cur) ? cur : '';
      rs.dataset.sig = rooms.join('|');
    }
    const ends = P.drafts.map((d) => d.end);
    const last = ends.length ? Math.max(...ends) : today + 30;
    G.from = today - 3;
    G.days = Math.min(150, Math.max(45, last - G.from + 5));
    const room = rs.value;
    const q = $('ganttSearch').value.trim().toUpperCase();
    const busyOnly = $('ganttBusy').checked;
    G.rows = P.machines.filter((m) => {
      if (room && m.room !== room) return false;
      const segs = P.timeline.segments(m.no);
      if (q) {
        const hitM = m.no === q.replace(/[^0-9]/g, '') && /^\d+$/.test(q.replace(/호기/, ''));
        const hitP = segs.some((s) => E.up(s.partCode).includes(q) || E.up(s.productCode).includes(q));
        if (!hitM && !hitP) return false;
      }
      if (busyOnly && !q) {
        const blocked = (P.timeline.blocks[m.no] || []).length > 0;
        if (!blocked && !P.timeline.status(m.no).delayed && !segs.some((s) => s.e >= G.from && s.s < G.from + G.days)) return false;
      }
      return true;
    });
    // 헤더
    let h = '<div class="corner">호기 · 방 (' + nf(G.rows.length) + ')</div>';
    for (let d = 0; d < G.days; d++) {
      const s = G.from + d;
      const dt = E.dateFromSerial(s);
      const we = dt.getDay() === 0 || dt.getDay() === 6;
      const first = d === 0 || dt.getDate() === 1;
      h += '<div class="day' + (we ? ' we' : '') + (s === today ? ' today' : '') + '"><span class="m">' + (first ? dt.getMonth() + 1 + '월' : '') + '</span>' + dt.getDate() + '</div>';
    }
    $('ganttHead').innerHTML = h;
    const body = $('ganttBody');
    body.style.height = G.rows.length * G.row + 'px';
    body.style.width = G.left + G.days * G.day + 'px';
    body.dataset.from = '-1';
    buildPartColors();
    paintGanttRows(true);
  }
  function paintGanttRows(force) {
    if (S.tab !== 'gantt') return;
    const box = $('gantt');
    const body = $('ganttBody');
    const top = Math.max(0, box.scrollTop - 40);
    const first = Math.max(0, Math.floor(top / G.row) - 5);
    const last = Math.min(G.rows.length, Math.ceil((box.scrollTop + box.clientHeight) / G.row) + 5);
    if (!force && body.dataset.from === String(first) && body.dataset.to === String(last)) return;
    body.dataset.from = String(first);
    body.dataset.to = String(last);
    const P = S.planner;
    const tl = P.timeline;
    const width = G.days * G.day;
    const weekends = [];
    for (let d = 0; d < G.days; d++) {
      const wd = E.dateFromSerial(G.from + d).getDay();
      if (wd === 0 || wd === 6) weekends.push('<div class="we" style="left:' + d * G.day + 'px"></div>');
    }
    const weHtml = weekends.join('') + '<div class="todayline" style="left:' + ((today - G.from) * G.day + G.day / 2 - 1) + 'px"></div>';
    let html = '';
    let prevRoom = first > 0 ? G.rows[first - 1].room : null;
    for (let i = first; i < last; i++) {
      const m = G.rows[i];
      const bars = [];
      const place = (s, e) => {
        const a = Math.max(s, G.from);
        const b = Math.min(e, G.from + G.days - 1);
        if (b < a) return null;
        return 'left:' + ((a - G.from) * G.day + 1) + 'px;width:' + ((b - a + 1) * G.day - 2) + 'px';
      };
      for (const b of tl.blocks[m.no] || []) {
        const st = place(b.s, b.e);
        if (st) bars.push('<div class="bar block" style="' + st + '" title="' + esc(b.label + ' ' + E.fmtMD(b.s) + '~' + E.fmtMD(b.e)) + '">' + esc(b.label) + '</div>');
      }
      const status = tl.status(m.no);
      for (const seg of tl.segments(m.no)) {
        const st = place(seg.s, seg.kind === 'confirmed' && seg.complete ? seg.effEnd : seg.e);
        if (!st) continue;
        const key = seg.kind === 'draft' ? seg.itemKey : E.itemKey(seg.planNo, seg.productCode, seg.partCode);
        const item = P.itemByKey[key];
        let cls = 'bar ' + seg.kind;
        if (seg.kind === 'confirmed' && seg.complete) cls += ' done';
        if (seg.kind === 'draft') {
          const d = P.drafts.find((x) => x.id === seg.draftId);
          if (item && item.due != null && seg.e > item.due) cls += ' late';
          if (d && d.manual) cls += ' manual';
          if (S.selDraft === seg.draftId) cls += ' sel';
        }
        const tip = (seg.kind === 'draft' ? '[가배정] ' : '[확정] ') + seg.partCode + ' · ' + (seg.planNo || '') + ' ' + seg.productCode + ' · ' + (P.groupOf[m.no] || '') + ' · ' + nf(seg.qty) + '개 · ' + E.fmtMD(seg.s) + '~' + E.fmtMD(seg.e) + (item && item.due != null ? ' · 요청일 ' + E.fmtMD(item.due) : '');
        bars.push('<div class="' + cls + '" style="' + st + ';' + partStyle(seg.partCode) + '" data-key="' + esc(item ? key : '') + '" data-part="' + esc(E.up(seg.partCode)) + '" data-draft="' + (seg.draftId || '') + '" title="' + esc(tip) + '">' + esc(seg.partCode || seg.productCode) + '</div>');
      }
      if (status.delayed && status.latest) {
        const st = place(status.latest.e + 1, today);
        if (st) bars.push('<div class="bar delayflag" style="' + st + '" title="계획완료일이 지났지만 실적이 없어 완료확인이 필요합니다 (9번 시트 최근실적일/누적실적)">완료확인 필요</div>');
      }
      const roomFirst = m.room !== prevRoom;
      prevRoom = m.room;
      html +=
        '<div class="g-row' + (roomFirst ? ' room-first' : '') + '" style="top:' + i * G.row + 'px">' +
        '<div class="lab"><b>' + esc(m.no) + '</b><span>' + esc(m.room + ' ' + (m.model || '')) + '</span></div>' +
        '<div class="track" style="width:' + width + 'px">' + weHtml + bars.join('') + '</div></div>';
    }
    body.innerHTML = html;
  }

  // 수기검토
  const FIX = [
    [/^BG/, 'BG 전용호기에 직접 배정합니다. 품목을 열어 호기 번호와 장비일수를 입력하세요 (16_BG전용기준 참고).'],
    [/^BD규격/, '21_BD규격마스터에 부품명·BD외경·BD길이를 등록하고 통합문서를 다시 불러오면 자동배정됩니다.'],
    [/^재질계열/, '[기준 설정] → 추가 소재계열 매핑에 "소재=계열"을 넣거나 3_방마스터 기본소재계열을 보완하세요.'],
    [/^대분류/, '자동추천 규칙이 없는 대분류입니다. 품목을 열어 호기를 직접 입력하세요.'],
    [/^생산성기준/, '6_생산성기준에 해당 품목군의 기준_일생산량을 추가하세요.'],
    [/^방마스터/, '3_방마스터의 허용대분류/우선생산성분류/기본소재계열 조합에 맞는 방이 없습니다.'],
    [/완료확인/, '9_설비배정_확정의 최근실적일·누적실적을 입력하면 해당 호기가 다시 후보가 됩니다.'],
    [/조건부/, '도면 확인이 필요한 조건부 후보만 있습니다. 품목을 열어 후보표에서 직접 선택하세요.'],
  ];
  function reasonGroup(reason) {
    return String(reason || '기타')
      .replace(/\s*[:(].*$/, '')
      .replace(/\s*-\s.*$/, '')
      .trim();
  }
  function renderReview() {
    const P = S.planner;
    const groups = new Map();
    for (const it of P.items) {
      if (it.dupOf != null) continue;
      const st = P.itemState(it).label;
      const r = P.results[it.key];
      let g = null;
      if (st === '수기검토') g = reasonGroup(r && r.reason);
      else if (st === '가배정(지연)') g = '납기 초과 예상 (가배정됨)';
      if (!g) continue;
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(it);
    }
    if (!groups.size) {
      $('reviewList').innerHTML = '<p class="hint">수기검토 품목이 없습니다. [자동 일정수립]을 실행하면 자동기준 밖 품목이 여기에 모입니다.</p>';
      return;
    }
    const sorted = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
    $('reviewList').innerHTML = sorted
      .map(([g, list], gi) => {
        const fix = (FIX.find(([re]) => re.test(g)) || [null, g.startsWith('납기') ? '호기를 추가하거나 다른 품목과 순서를 조정하세요. 품목을 열어 [선택호기 가배정]으로 다시 배분할 수 있습니다.' : ''])[1];
        const rows = list
          .slice(0, 300)
          .map((it) => {
            const r = P.results[it.key] || {};
            return '<tr data-key="' + esc(it.key) + '"><td class="code">' + esc(it.planNo || '-') + '</td><td class="code">' + esc(it.partCode) + '</td><td class="num">' + nf(P.workQty(it) || it.qty) + '</td><td class="when">' + (it.due != null ? E.fmtMD(it.due) : '-') + '</td><td>' + esc(it.material) + '</td><td class="reason">' + esc(r.reason || '') + '</td></tr>';
          })
          .join('');
        return (
          '<details class="group"' + (gi === 0 ? ' open' : '') + '><summary><span class="n">' + nf(list.length) + '건</span><b>' + esc(g) + '</b>' + (fix ? '<span class="fix">' + esc(fix) + '</span>' : '') + '</summary>' +
          '<div class="table-wrap"><table class="grid"><thead><tr><th>계획번호</th><th>부품코드</th><th class="num">수량</th><th>요청일</th><th>재질</th><th>사유</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
          (list.length > 300 ? '<p class="hint" style="padding:8px 12px">상위 300건만 표시 · 전체는 결과 엑셀의 품목별결과 시트</p>' : '') +
          '</details>'
        );
      })
      .join('');
  }

  // 기준 점검
  function renderMaster() {
    const P = S.planner;
    const m = S.model;
    const cards = [];
    cards.push(
      '<div class="mcard"><h3>불러온 기준</h3><ul>' +
        [
          ['원본 품목', m.raw.length],
          ['방마스터', m.rooms.length],
          ['설비마스터', m.machines.length],
          ['생산성분류 규칙', m.rules.length],
          ['생산성기준', m.productivity.length],
          ['작업자운영', m.workers.length],
          ['BD규격마스터', m.bdSpecs.length],
          ['9번 확정일정', m.confirmed.length],
        ]
          .map(([k, v]) => '<li>' + esc(k) + ' <b>' + nf(v) + '</b></li>')
          .join('') +
        '</ul></div>'
    );
    // 방별 부하
    const rooms = new Map();
    for (const mc of P.machines) {
      const r = rooms.get(mc.room) || { n: 0, used: 0, days: 0, last: null, delayed: 0 };
      r.n++;
      const ds = P.drafts.filter((d) => d.machine === mc.no);
      if (ds.length) {
        r.used++;
        r.days += ds.reduce((s, d) => s + d.days, 0);
        const e = Math.max(...ds.map((d) => d.end));
        r.last = r.last == null ? e : Math.max(r.last, e);
      }
      if (P.timeline.status(mc.no).delayed) r.delayed++;
      rooms.set(mc.room, r);
    }
    cards.push(
      '<div class="mcard"><h3>방별 가배정 부하</h3><div class="table-wrap"><table class="grid"><thead><tr><th>방</th><th class="num">호기</th><th class="num">사용</th><th class="num">장비일</th><th>최종완료</th><th class="num">완료확인</th></tr></thead><tbody>' +
        [...rooms.entries()]
          .map(([k, r]) => '<tr><td>' + esc(k) + '</td><td class="num">' + r.n + '</td><td class="num">' + r.used + '</td><td class="num">' + nf(r.days) + '</td><td class="when">' + (r.last ? E.fmtMD(r.last) : '-') + '</td><td class="num">' + r.delayed + '</td></tr>')
          .join('') +
        '</tbody></table></div></div>'
    );
    // 조(방) 구성과 작업자 신규셋팅
    const groups = new Map();
    for (const mc of P.machines) groups.set(P.groupOf[mc.no], (groups.get(P.groupOf[mc.no]) || 0) + 1);
    const workers = new Set(P.machines.map((mc) => P.workerByMachine[mc.no]).filter(Boolean));
    let peak = 0;
    let peakKey = '';
    for (const [k, v] of P.setupCount)
      if (Number(k.split('|')[1]) >= S.baseDate && k.startsWith('작업자') && v > peak) {
        peak = v;
        peakKey = k;
      }
    const lim = S.settings.setupLimitPerWorkerDay;
    cards.push(
      '<div class="mcard"><h3>조(방) ' + groups.size + '개 · 담당작업자 ' + workers.size + '명</h3><p class="hint">분산형 배정은 한 품목을 한 방에 ' + S.settings.perGroupMax + '대까지만 넣고 다른 방의 가능한 호기로 나눕니다. ' +
        (lim ? '작업자 1인의 하루 신규셋팅이 ' + lim + '건을 넘으면 다음 날로 미룹니다 (13_작업자운영마스터 담당작업자 기준, 담당작업자가 없는 호기는 제외).' : '작업자 신규셋팅 한도는 꺼져 있습니다.') +
        '</p><ul>' + [...groups.entries()].map(([g, n]) => '<li>' + esc(g) + ' <b>' + n + '대</b></li>').join('') +
        '<li>기준게시일 이후 1인 하루 최대 신규셋팅 <b>' + peak + '건</b>' + (peakKey ? ' (' + esc(peakKey.split('|')[0]) + ', ' + E.fmtMD(Number(peakKey.split('|')[1])) + ')' : '') + '</li></ul></div>'
    );
    // 미매핑 재질
    const mats = new Map();
    for (const it of P.items) {
      if (it.dupOf != null || it.matGroup || !['PL', 'TE'].includes(it.main)) continue;
      const k = it.material || '(공란)';
      mats.set(k, (mats.get(k) || 0) + 1);
    }
    const matList = [...mats.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
    cards.push(
      '<div class="mcard"><h3>소재계열이 정해지지 않은 재질 (PL/TE)</h3><p class="hint">BECU·TK·SK 계열로 연결되지 않으면 1·2·4·5·6번방 후보가 나오지 않습니다. [기준 설정]의 추가 소재계열 매핑으로 보완할 수 있습니다.</p><ul>' +
        (matList.length ? matList.map(([k, v]) => '<li>' + esc(k) + ' <b>' + v + '건</b></li>').join('') : '<li>없음</li>') +
        '</ul></div>'
    );
    // 생산성기준 누락
    const prodMiss = new Map();
    for (const it of P.items) if (it.dupOf == null && it.main !== 'BG' && !(it.daily > 0)) prodMiss.set(it.prod, (prodMiss.get(it.prod) || 0) + 1);
    cards.push(
      '<div class="mcard"><h3>생산성기준 미등록 분류</h3><ul>' +
        (prodMiss.size ? [...prodMiss.entries()].map(([k, v]) => '<li>' + esc(k) + ' <b>' + v + '건</b></li>').join('') : '<li>없음</li>') +
        '</ul></div>'
    );
    // 완료확인 필요 호기
    const delayed = P.machines.filter((mc) => P.timeline.status(mc.no).delayed);
    cards.push(
      '<div class="mcard"><h3>완료확인 필요 호기 ' + delayed.length + '대</h3><p class="hint">계획완료일이 지났는데 누적실적이 계획수량에 못 미쳐 신규배정에서 제외된 호기입니다. 9번 시트에 최근실적일·누적실적을 입력하거나 [기준 설정]에서 처리방식을 바꾸세요.</p><ul>' +
        delayed
          .slice(0, 40)
          .map((mc) => {
            const l = P.timeline.status(mc.no).latest;
            return '<li><b>' + esc(mc.no) + '</b> ' + esc(mc.room) + ' · ' + esc(l.partCode) + ' · 완료예정 ' + E.fmtMD(l.e) + ' · 실적 ' + nf(l.actualQty) + '/' + nf(l.planQty) + '</li>';
          })
          .join('') +
        (delayed.length > 40 ? '<li>외 ' + (delayed.length - 40) + '대</li>' : '') +
        '</ul></div>'
    );
    // BD 규격 미등록
    const bdMiss = new Map();
    for (const it of P.items) {
      if (it.dupOf != null || it.main !== 'BD') continue;
      const b = E.lookupBDSpec(m.bdSpecs, it.partCode);
      if (b.status !== '정상') bdMiss.set(it.partCode, b.status);
    }
    cards.push(
      '<div class="mcard"><h3>BD규격마스터 확인 필요 ' + bdMiss.size + '종</h3><p class="hint">등록되면 외경·길이로 호기를 자동 판정합니다. 아래 목록을 21_BD규격마스터 부품명 열에 붙여넣고 치수를 입력하세요.</p><ul>' +
        [...bdMiss.entries()]
          .slice(0, 30)
          .map(([k, v]) => '<li class="code">' + esc(k) + ' · ' + esc(v) + '</li>')
          .join('') +
        (bdMiss.size > 30 ? '<li>외 ' + (bdMiss.size - 30) + '종</li>' : '') +
        '</ul>' +
        (bdMiss.size ? '<div><button class="btn small" type="button" id="copyBdList">부품명 목록 복사</button></div>' : '') +
        '</div>'
    );
    $('masterList').innerHTML = '<div class="mgrid">' + cards.join('') + '</div>';
    const cb = $('copyBdList');
    if (cb) cb.onclick = () => copyText([...bdMiss.keys()].join('\n'), 'BD 부품명 ' + bdMiss.size + '종을 복사했습니다');
  }

  // ───────────────────────── 품목 상세 ─────────────────────────
  function openItem(key, draftId) {
    if (!key || !S.planner.itemByKey[key]) return;
    S.openKey = key;
    S.selDraft = draftId || null;
    $('drawer').hidden = false;
    renderDrawer();
    if (S.tab === 'gantt') paintGanttRows(true);
  }
  function closeDrawer() {
    S.openKey = null;
    S.selDraft = null;
    $('drawer').hidden = true;
    if (S.tab === 'gantt') paintGanttRows(true);
  }

  function renderDrawer() {
    const P = S.planner;
    const it = P.itemByKey[S.openKey];
    if (!it) return closeDrawer();
    const r = P.results[it.key] || {};
    const work = P.workQty(it);
    const days = E.daysForQty(it, work);
    $('dwEyebrow').innerHTML = statePill(it) + ' &nbsp;' + esc(it.planNo || '계획번호 없음') + ' · ' + esc(it.productCode);
    $('dwTitle').textContent = it.partCode;
    const facts = [
      ['발주량', nf(it.qty)],
      ['기존확정', nf(it.confirmedQty)],
      ['가배정', nf(P.draftQty(it.key))],
      ['남은 수량', nf(work)],
      ['요청일', it.due != null ? E.fmtYMD(it.due) : '-'],
      ['분류', it.main + ' · ' + (it.detail || '-') + ' · ' + it.prod],
      ['재질 / 계열', (it.material || '-') + ' / ' + (it.matGroup || '미매핑')],
      ['일생산량', it.daily ? nf(it.daily) + '개' : '미등록'],
      ['필요 장비일', days ? days + '일' : '-'],
      ['권장대수', it.rec || '-'],
      ['특별관리', it.special || '-'],
      ['프로그램 설비', it.refMachines.length ? it.refMachines.join('/') : '-'],
    ];
    let html = '<dl class="facts">' + facts.map(([k, v]) => '<div><dt>' + esc(k) + '</dt><dd>' + esc(v) + '</dd></div>').join('') + '</dl>';
    if (r.reason || it.note) html += '<div class="box' + (P.itemState(it).label === '수기검토' ? ' warn' : '') + '"><h3>판정</h3><p class="hint">' + esc([r.reason, it.note].filter(Boolean).join(' / ')) + '</p></div>';

    const ds = draftsOf(it.key);
    const confirmedRows = (S.model.confirmed || []).filter((c) => E.itemKey(c.planNo, c.productCode, c.partCode) === it.key);
    html += '<div class="box"><h3>현재 배정</h3>';
    if (!ds.length && !confirmedRows.length) html += '<p class="hint">배정 없음</p>';
    if (confirmedRows.length)
      html += '<div class="alloc">' + confirmedRows.map((c) => '<span class="chip">확정 <b>' + esc(c.machine) + '</b> ' + E.fmtMD(c.start) + '~' + E.fmtMD(c.end) + ' · ' + nf(c.qty) + '</span>').join('') + '</div>';
    if (ds.length)
      html +=
        '<div class="alloc">' +
        ds.map((d) => '<span class="chip draft">' + (d.manual ? '수기' : '자동') + ' <b>' + esc(d.machine) + '</b> ' + esc(P.groupOf[d.machine] || '') + (P.workerByMachine[d.machine] ? ' ' + esc(P.workerByMachine[d.machine]) : '') + ' · ' + E.fmtMD(d.start) + '~' + E.fmtMD(d.end) + ' · ' + nf(d.qty) + '<button type="button" data-rmdraft="' + d.id + '" aria-label="' + esc(d.machine) + '호기 가배정 취소">✕</button></span>').join('') +
        '</div><div class="row"><button class="btn small danger" type="button" id="dwClearDrafts">이 품목 가배정 모두 취소</button></div>';
    html += '</div>';

    // 후보
    const q = P.candidates(it, { from: S.baseDate });
    const cands = q.candidates;
    const want = days > 0 ? P._countRange(it, days).min : 1;
    const preset = work > 0 && cands.length ? P.batchPick(cands, want, Math.ceil((days || 1) / want), S.baseDate, it.partCode).map((c) => c.machine) : [];
    html += '<div class="box"><h3>호기 선택 ' + (cands.length ? '<span class="hint">후보 ' + cands.length + '대 · ' + (S.settings.allocMode === 'spread' ? '방별 분산·' : '') + '먼저 비는 안전후보 ' + preset.length + '대 미리 선택</span>' : '') + '</h3>';
    if (!cands.length) html += '<p class="hint">' + esc(['PL', 'TE', 'BD'].includes(it.main) ? P.diagText(it, q.diag, q.bd) : '자동추천 대상이 아닌 대분류입니다') + ' · 아래에 호기 번호를 직접 입력하세요.</p>';
    html +=
      '<div class="row"><label for="dwMachines">배정 호기</label><input type="text" id="dwMachines" value="' + esc(preset.join('/')) + '" placeholder="527 또는 527/528">' +
      '<label for="dwQty">수량</label><input type="number" id="dwQty" min="1" value="' + (work || '') + '">' +
      '<label for="dwDays">장비일</label><input type="number" id="dwDays" min="1" value="' + (days || 1) + '" style="width:80px"></div>' +
      '<div class="row"><button class="btn" type="button" id="dwPreview">배분 미리보기</button><button class="btn primary" type="button" id="dwApply"' + (work > 0 ? '' : ' disabled') + '>선택호기 가배정</button><span class="hint" id="dwPreviewText"></span></div>';
    if (cands.length) {
      const sel = new Set(preset);
      html +=
        '<div class="table-wrap"><table class="grid cand-table"><thead><tr><th></th><th>순위</th><th>등급</th><th>호기</th><th>방</th><th>담당</th><th>기종</th><th>현재소재</th><th>소재비교</th><th>작업상태</th><th>가용구간</th><th class="num">점수</th><th>비고</th></tr></thead><tbody>' +
        cands
          .slice(0, 80)
          .map(
            (c) =>
              '<tr data-cand="' + esc(c.machine) + '"><td><input type="checkbox" aria-label="' + esc(c.machine) + '호기 선택" data-pick="' + esc(c.machine) + '"' + (sel.has(c.machine) ? ' checked' : '') + '></td><td class="num">' + c.rank + '</td><td>' + gradeHtml(c.grade) + '</td><td class="code"><b>' + esc(c.machine) + '</b></td><td>' + esc(c.room) + '</td><td>' + esc(P.workerByMachine[c.machine] || '') + '</td><td>' + esc(c.model) + '</td><td>' + esc(c.material) + '</td><td>' + esc(c.settingText) + '</td><td>' + esc(c.work) + '</td><td class="when">' + esc(c.availText) + '</td><td class="num">' + c.score + '</td><td class="reason">' + esc([c.roomReason, c.note].filter(Boolean).join(' / ')) + '</td></tr>'
          )
          .join('') +
        '</tbody></table></div>' +
        (cands.length > 80 ? '<p class="hint">상위 80대만 표시</p>' : '');
    }
    html += '</div>';
    $('dwBody').innerHTML = html;
  }

  function drawerMachines() {
    return E.parseMachineList($('dwMachines').value);
  }
  function syncPicks() {
    const list = drawerMachines();
    for (const cb of document.querySelectorAll('[data-pick]')) cb.checked = list.includes(cb.dataset.pick);
  }
  function previewDrawer() {
    const P = S.planner;
    const ms = drawerMachines();
    const unknown = ms.filter((m) => !P.machineByNo[m]);
    const out = $('dwPreviewText');
    if (!ms.length) return (out.textContent = '호기를 선택하거나 입력하세요');
    if (unknown.length) return (out.textContent = '설비마스터에 없는 호기: ' + unknown.join(', '));
    const qty = Number($('dwQty').value);
    const days = Number($('dwDays').value);
    const a = P.allocate(ms, qty, days, S.baseDate);
    if (!a) return (out.textContent = '배정 가능한 빈 구간이 없습니다 (완료확인 필요 호기 포함 여부 확인)');
    out.textContent = a.map((x) => x.machine + ': ' + nf(x.qty) + ' (' + E.fmtMD(x.start) + '~' + E.fmtMD(x.end) + ')').join(' / ');
    return a;
  }
  function applyDrawer() {
    const P = S.planner;
    const it = P.itemByKey[S.openKey];
    const ms = drawerMachines();
    const unknown = ms.filter((m) => !P.machineByNo[m]);
    if (!ms.length || unknown.length) return previewDrawer();
    const qty = Number($('dwQty').value);
    const days = Number($('dwDays').value);
    const a = P.manualAssign(it, ms, { qty, days, from: S.baseDate });
    if (!a) return toast('배정 가능한 빈 구간이 없습니다');
    saveDrafts();
    toast(it.partCode + ' → ' + a.map((x) => x.machine).join('/') + ' 가배정');
    renderAll();
  }

  // ───────────────────────── 동작 ─────────────────────────
  function runAuto() {
    busy('미배정 품목 일괄 가배정 중…', () => {
      const P = S.planner;
      const t0 = performance.now();
      P.clearAutoDrafts();
      const s = P.autoPlan();
      saveDrafts();
      S.page = 0;
      renderAll();
      toast('가배정 ' + nf(s.draft) + '건 · 수기검토 ' + nf(s.review) + '건 · 납기초과 ' + nf(s.late) + '건 (' + ((performance.now() - t0) / 1000).toFixed(1) + '초)');
    });
  }

  function loadModel(model, source, isDemo) {
    S.model = model;
    S.source = source;
    S.isDemo = isDemo;
    S.planner = null;
    S.openKey = null;
    $('drawer').hidden = true;
    const restored = rebuild('all');
    S.page = 0;
    renderAll();
    return restored;
  }

  function handleFile(file) {
    if (!file) return;
    busy('통합문서 읽는 중…', () => {});
    const reader = new FileReader();
    reader.onload = () => {
      busy('통합문서 읽는 중…', () => {
        const { model, warnings } = W.readWorkbook(new Uint8Array(reader.result));
        if (!model.machines.length) {
          toast('설비마스터를 찾지 못했습니다. CNC 생산계획 통합문서인지 확인하세요. ' + warnings.join(' / '));
          return;
        }
        const restored = loadModel(model, file.name, false);
        toast(file.name + ' 불러옴 · 품목 ' + nf(model.raw.length) + '행' + (restored ? ' · 이전 가배정 ' + restored + '건 복원' : '') + (warnings.length ? ' · ' + warnings.join(' / ') : ''));
      });
    };
    reader.onerror = () => toast('파일을 읽지 못했습니다');
    reader.readAsArrayBuffer(file);
  }

  function copyText(text, okMsg) {
    const done = () => toast(okMsg);
    const fallback = () => {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        done();
      } catch (e) {
        toast('복사하지 못했습니다');
      }
      ta.remove();
    };
    try {
      navigator.clipboard.writeText(text).then(done, fallback);
    } catch (e) {
      fallback();
    }
  }
  function tsv(rows) {
    return rows.map((r) => r.map((v) => (v == null ? '' : String(v).replace(/[\t\n]/g, ' '))).join('\t')).join('\n');
  }
  function confirmTsv() {
    return tsv(S.planner.confirmRows().map((r) => [r.planNo, r.productCode, r.partCode, r.machine, E.fmtYMD(r.start), E.fmtYMD(r.end), r.qty, r.newSetup, r.worker, '', '', r.note]));
  }
  function programTsv() {
    return tsv(S.planner.programSummary().map((p) => [p.planNo, p.productCode, E.fmtYMD(p.start), E.fmtYMD(p.end)].concat(Array.from({ length: 10 }, (_, i) => (p.machines[i] != null ? p.machines[i] : '')), [p.note])));
  }

  function exportExcel() {
    if (!S.planner.drafts.length) return toast('가배정이 없습니다. [자동 일정수립]을 먼저 실행하세요');
    const wb = W.buildExportWorkbook(S.planner, {});
    try {
      window.XLSX.writeFile(wb, W.exportFileName());
      toast('결과 엑셀을 저장했습니다');
    } catch (e) {
      toast('파일 저장이 막혀 있습니다. 아래 [복사] 버튼으로 붙여넣으세요');
    }
  }
  function openExportDialog() {
    let dlg = $('dlgExport');
    if (!dlg) {
      dlg = document.createElement('dialog');
      dlg.id = 'dlgExport';
      dlg.className = 'dialog';
      dlg.innerHTML =
        '<form method="dialog"><h2>결과 내보내기</h2>' +
        '<p class="hint">가배정은 아직 통합문서에 반영되지 않았습니다. 검토 후 아래 방법 중 하나로 옮기세요.</p>' +
        '<div class="box"><h3>1. 결과 엑셀 파일</h3><p class="hint">9번확정_붙여넣기 · 프로그램입력요약(설비1~A) · 품목별결과 · 간트 시트를 담은 새 파일을 저장합니다. 원본 통합문서는 바꾸지 않습니다.</p><div class="row"><button class="btn primary" type="button" id="exFile">엑셀 파일 저장</button></div></div>' +
        '<div class="box"><h3>2. 9_설비배정_확정에 바로 붙여넣기</h3><p class="hint">9번 시트의 마지막 행 아래 A열을 선택하고 붙여넣으세요 (계획번호~비고 12열). 그 뒤 기존 매크로로 간트/가용일을 갱신하면 됩니다.</p><div class="row"><button class="btn" type="button" id="exConfirm">9번 붙여넣기용 복사</button><span class="hint" id="exConfirmN"></span></div></div>' +
        '<div class="box"><h3>3. 일정관리 프로그램 설비1~설비A</h3><p class="hint">계획번호 · 제품코드 · 게시일 · 완료일 · 설비1~설비A · 비고 순서입니다.</p><div class="row"><button class="btn" type="button" id="exProgram">설비1~A 요약 복사</button></div></div>' +
        '<div class="dialog-actions"><button class="btn" value="cancel" type="submit">닫기</button></div></form>';
      document.body.appendChild(dlg);
      $('exFile').onclick = exportExcel;
      $('exConfirm').onclick = () => copyText(confirmTsv(), '9번 붙여넣기용 ' + nf(S.planner.drafts.length) + '행을 복사했습니다');
      $('exProgram').onclick = () => copyText(programTsv(), '설비1~A 요약을 복사했습니다');
    }
    $('exConfirmN').textContent = nf(S.planner.drafts.length) + '행';
    dlg.showModal();
  }

  function openSettings() {
    const s = S.settings;
    $('setBase').value = E.fmtYMD(S.baseDate);
    $('setMode').value = s.allocMode;
    $('setMinRun').value = s.minRunDays;
    $('setMaxRun').value = s.maxRunDays;
    $('setMax').value = s.maxMachines;
    $('setPerGroup').value = s.perGroupMax;
    $('setSetupLimit').value = s.setupLimitPerWorkerDay;
    $('setAllowB').value = s.allowB ? '1' : '0';
    $('setSlack').value = s.bSlackDays;
    $('setExpand').value = s.expandToDue ? '1' : '0';
    $('setDelay').value = s.delayPolicy;
    $('setActualOk').value = s.requireActualOk ? '1' : '0';
    $('setMatMap').value = s.matMap;
    $('dlgSettings').showModal();
  }
  function applySettings() {
    const base = E.toSerial($('setBase').value);
    const num = (id, d, lo) => {
      const v = Number($(id).value);
      return isFinite(v) && $(id).value !== '' ? Math.max(lo, v) : d;
    };
    const minRun = num('setMinRun', 7, 1);
    S.settings = {
      v: SETTINGS_VERSION,
      baseOffset: base != null ? base - today : 1,
      allocMode: $('setMode').value,
      minRunDays: minRun,
      maxRunDays: Math.max(minRun, num('setMaxRun', 30, 1)),
      maxMachines: num('setMax', 6, 1),
      perGroupMax: num('setPerGroup', 1, 1),
      setupLimitPerWorkerDay: num('setSetupLimit', 5, 0),
      allowB: $('setAllowB').value === '1',
      bSlackDays: Math.max(0, Number($('setSlack').value) || 0),
      expandToDue: $('setExpand').value === '1',
      delayPolicy: $('setDelay').value,
      requireActualOk: $('setActualOk').value === '1',
      matMap: $('setMatMap').value,
    };
    S.baseDate = base != null ? base : today + 1;
    store.set('cnc.settings', S.settings);
    $('dlgSettings').close();
    busy('기준 적용 중…', () => {
      const hadAuto = S.planner.drafts.some((d) => d.auto);
      rebuild('manual');
      if (hadAuto) S.planner.autoPlan();
      saveDrafts();
      renderAll();
      toast('기준을 적용했습니다' + (hadAuto ? ' · 자동 가배정 다시 계산' : ''));
    });
  }

  function pastePreview() {
    const rows = W.parsePastedText($('pasteText').value);
    $('pastePreview').textContent = rows.length ? '인식된 품목 ' + nf(rows.length) + '행 · 예: ' + rows.slice(0, 2).map((r) => (r.planNo || '-') + ' ' + r.partCode + ' ' + nf(r.qty)).join(', ') : '인식된 품목이 없습니다';
    return rows;
  }
  function applyPaste() {
    const rows = pastePreview();
    if (!rows.length) return;
    $('dlgPaste').close();
    busy('원본 교체 중…', () => {
      S.model = Object.assign({}, S.model, { raw: rows });
      rebuild('all');
      S.page = 0;
      renderAll();
      toast('원본 ' + nf(rows.length) + '행으로 교체했습니다. [자동 일정수립]을 실행하세요');
    });
  }

  // ───────────────────────── 이벤트 ─────────────────────────
  function bind() {
    $('fileInput').addEventListener('change', (e) => {
      handleFile(e.target.files[0]);
      e.target.value = '';
    });
    document.addEventListener('dragover', (e) => e.preventDefault());
    document.addEventListener('drop', (e) => {
      e.preventDefault();
      const f = e.dataTransfer && e.dataTransfer.files[0];
      if (f) handleFile(f);
    });
    $('btnAuto').onclick = runAuto;
    $('btnExport').onclick = openExportDialog;
    $('btnSettings').onclick = openSettings;
    $('settingsApply').onclick = applySettings;
    $('btnPaste').onclick = () => {
      $('pastePreview').textContent = '';
      $('dlgPaste').showModal();
    };
    $('pasteText').addEventListener('input', pastePreview);
    $('pasteApply').onclick = applyPaste;

    for (const b of document.querySelectorAll('.tab'))
      b.addEventListener('click', () => {
        S.tab = b.dataset.tab;
        store.set('cnc.tab', S.tab);
        renderAll();
      });

    let t = 0;
    const deb = (fn) => () => {
      clearTimeout(t);
      t = setTimeout(fn, 160);
    };
    $('itemSearch').addEventListener('input', deb(() => ((S.page = 0), renderItems())));
    $('itemState').addEventListener('change', () => ((S.page = 0), renderItems()));
    $('itemMain').addEventListener('change', () => ((S.page = 0), renderItems()));
    $('itemPager').addEventListener('click', (e) => {
      const b = e.target.closest('[data-page]');
      if (!b || b.disabled) return;
      S.page = Number(b.dataset.page);
      renderItems();
    });
    const rowOpen = (e) => {
      const tr = e.target.closest('tr[data-key]');
      if (tr) openItem(tr.dataset.key);
    };
    $('itemTable').addEventListener('click', rowOpen);
    $('reviewList').addEventListener('click', rowOpen);

    $('ganttRoom').addEventListener('change', renderGantt);
    $('ganttSearch').addEventListener('input', deb(renderGantt));
    $('ganttBusy').addEventListener('change', renderGantt);
    $('gantt').addEventListener('scroll', () => requestAnimationFrame(() => paintGanttRows(false)));
    $('ganttBody').addEventListener('click', (e) => {
      const b = e.target.closest('.bar[data-key]');
      if (b && b.dataset.key) openItem(b.dataset.key, Number(b.dataset.draft) || null);
    });
    window.addEventListener('resize', () => S.tab === 'gantt' && renderGantt());
    // 막대에 마우스를 올리면 같은 부품의 다른 호기 막대를 함께 강조
    let hlPart = '';
    const setHl = (part) => {
      if (part === hlPart) return;
      hlPart = part;
      for (const b of $('ganttBody').querySelectorAll('.bar[data-part]')) b.classList.toggle('hl', !!part && b.dataset.part === part);
    };
    $('ganttBody').addEventListener('mouseover', (e) => {
      const b = e.target.closest('.bar[data-part]');
      setHl(b ? b.dataset.part : '');
    });
    $('ganttBody').addEventListener('mouseleave', () => setHl(''));

    $('dwClose').onclick = closeDrawer;
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !$('drawer').hidden && !document.querySelector('dialog[open]')) closeDrawer();
    });
    $('dwBody').addEventListener('click', (e) => {
      const rm = e.target.closest('[data-rmdraft]');
      if (rm) {
        S.planner.removeDraft(Number(rm.dataset.rmdraft));
        const it = S.planner.itemByKey[S.openKey];
        if (!S.planner.drafts.some((d) => d.itemKey === it.key)) delete S.planner.results[it.key];
        saveDrafts();
        return renderAll();
      }
      if (e.target.id === 'dwClearDrafts') {
        S.planner.removeDraftsForItem(S.openKey);
        saveDrafts();
        return renderAll();
      }
      if (e.target.id === 'dwPreview') return previewDrawer();
      if (e.target.id === 'dwApply') return applyDrawer();
      const row = e.target.closest('tr[data-cand]');
      if (row && !e.target.matches('input')) {
        const cb = row.querySelector('[data-pick]');
        cb.checked = !cb.checked;
        cb.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    $('dwBody').addEventListener('change', (e) => {
      if (!e.target.matches('[data-pick]')) return;
      const list = drawerMachines().filter((m) => m !== e.target.dataset.pick);
      if (e.target.checked) list.push(e.target.dataset.pick);
      $('dwMachines').value = list.join('/');
      previewDrawer();
    });
    $('dwBody').addEventListener('input', (e) => {
      if (e.target.id === 'dwMachines') syncPicks();
      if (e.target.id === 'dwQty') {
        const it = S.planner.itemByKey[S.openKey];
        const d = E.daysForQty(it, Number(e.target.value));
        if (d) $('dwDays').value = d;
      }
    });
  }

  // ───────────────────────── 시작 ─────────────────────────
  bind();
  loadModel(window.CNCDemo.build(today), '예시 데이터', true);
  if (!S.planner.drafts.length) {
    S.planner.autoPlan();
    renderAll();
  }
})();
