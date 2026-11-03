/*
 * NAS 공유 작업 파일 (일정 수정 담당 2명 + 보기·출력 여러 명).
 * 기준 데이터·가배정·설정을 NAS 폴더의 CNC_공유작업.json 하나로 저장하고 불러온다.
 * 마지막으로 맞춘 상태(기준점)의 요약값만 기억해 두었다가, 다른 담당자가 먼저 저장했으면
 * 품목 단위로 "내가 바꾼 것은 내 것, 상대가 바꾼 것은 상대 것"으로 합친다. 둘 다 바꾼 품목만 담당자가 고른다.
 * 서버 없이 브라우저가 폴더의 파일을 직접 읽고 쓴다 (File System Access). 여기는 파일 입출력이 없는 순수 함수만.
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CNCShare = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FILE = 'CNC_공유작업.json';
  const BACKUP_DIR = '백업';
  const KEEP_BACKUPS = 40;
  const FORMAT = 1;
  const MODEL_KEYS = ['raw', 'rooms', 'machines', 'rules', 'productivity', 'workers', 'bgRules', 'bdSpecs', 'confirmed', 'holidays', 'matExclusions'];

  /** 문자열 요약값 (FNV-1a 32비트) – 바뀌었는지만 보면 되므로 짧게 */
  function hash(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36) + ':' + s.length.toString(36);
  }
  const hj = (v) => hash(JSON.stringify(v === undefined ? null : v));

  // 가배정 비교에서 빼는 값: 불러올 때마다 새로 매기는 번호
  const draftNorm = (d) => {
    const o = {};
    for (const k of Object.keys(d).sort()) if (k !== 'id') o[k] = d[k];
    return o;
  };

  /** 품목별 묶음: {품목키: {drafts:[...], result}} */
  function itemsOf(state) {
    const plan = (state && state.plan) || {};
    const out = {};
    const get = (k) => out[k] || (out[k] = { drafts: [], result: null });
    for (const d of plan.drafts || []) get(d.itemKey).drafts.push(draftNorm(d));
    for (const [k, v] of Object.entries(plan.results || {})) get(k).result = v;
    for (const v of Object.values(out)) v.drafts.sort((a, b) => a.start - b.start || String(a.machine).localeCompare(String(b.machine)) || a.qty - b.qty);
    return out;
  }

  /** 상태 요약 (기준점으로 저장해 두는 값) */
  function digest(state) {
    const model = {};
    for (const k of MODEL_KEYS) model[k] = hj((state.model || {})[k] || []);
    const items = {};
    for (const [k, v] of Object.entries(itemsOf(state))) items[k] = hj(v);
    return { rev: state.rev || 0, model, settings: hj(state.settings || {}), manualRows: hj(state.manualRows || []), items };
  }

  /** 지금 상태가 기준점에서 바뀌었는지 (저장 안 한 변경) */
  function changes(base, state) {
    if (!base) return { any: true, model: [], items: 0, settings: false };
    const d = digest(state);
    const model = MODEL_KEYS.filter((k) => d.model[k] !== base.model[k]);
    const keys = new Set(Object.keys(d.items).concat(Object.keys(base.items)));
    let items = 0;
    for (const k of keys) if (d.items[k] !== base.items[k]) items++;
    const settings = d.settings !== base.settings;
    const manual = d.manualRows !== base.manualRows;
    return { any: model.length > 0 || items > 0 || settings || manual, model, items, settings, manual };
  }

  /**
   * 3자 병합: base(마지막으로 맞춘 기준점 요약), mine(내 화면), theirs(공유 파일).
   * 바뀐 쪽을 택하고, 둘 다 다르게 바꾼 것은 preferMine이면 내 것(아니면 상대 것).
   * 반환 {state, report:{mineItems, theirItems, bothItems:[키], model:{k:'mine'|'theirs'|'both'}, settings}}
   */
  function merge(base, mine, theirs, preferMine) {
    const pick = (bh, mh, th) => (mh === th ? 'same' : mh !== bh && th === bh ? 'mine' : mh === bh ? 'theirs' : 'both');
    const dm = digest(mine);
    const dt = digest(theirs);
    const report = { mineItems: 0, theirItems: 0, bothItems: [], model: {}, settings: 'same', manualRows: 'same' };
    const take = (who) => (who === 'mine' || (who === 'both' && preferMine) ? mine : theirs);

    const model = {};
    for (const k of MODEL_KEYS) {
      const w = pick(base.model[k], dm.model[k], dt.model[k]);
      if (w !== 'same') report.model[k] = w;
      model[k] = (take(w).model || {})[k] || [];
    }
    report.settings = pick(base.settings, dm.settings, dt.settings);
    report.manualRows = pick(base.manualRows, dm.manualRows, dt.manualRows);

    const im = itemsOf(mine);
    const it = itemsOf(theirs);
    const drafts = [];
    const results = {};
    for (const k of new Set(Object.keys(im).concat(Object.keys(it)))) {
      const w = pick(base.items[k], dm.items[k], dt.items[k]);
      if (w === 'mine') report.mineItems++;
      else if (w === 'theirs') report.theirItems++;
      else if (w === 'both') report.bothItems.push(k);
      const src = (w === 'mine' || (w === 'both' && preferMine) ? im : it)[k];
      if (!src) continue;
      drafts.push(...src.drafts);
      if (src.result) results[k] = src.result;
    }
    const rawSide = report.model.raw ? take(report.model.raw) : theirs;
    const state = {
      app: 'CNC_일정수립',
      format: FORMAT,
      rev: theirs.rev || 0,
      source: rawSide.source || theirs.source || mine.source,
      pasted: rawSide.pasted || [],
      model,
      plan: { drafts, results },
      settings: take(report.settings).settings || {},
      manualRows: take(report.manualRows).manualRows || [],
    };
    return { state, report };
  }

  /** 같은 호기에서 겹치는 가배정 (병합 뒤 확인용) */
  function overlaps(state) {
    const by = new Map();
    const add = (m, s, e, what) => {
      if (m == null || s == null || e == null) return;
      const k = String(m);
      if (!by.has(k)) by.set(k, []);
      by.get(k).push({ s, e, what });
    };
    for (const c of (state.model && state.model.confirmed) || []) add(c.machine, c.start, c.end, null);
    for (const d of (state.plan && state.plan.drafts) || []) add(d.machine, d.start, d.end, d);
    const out = [];
    for (const [m, list] of by) {
      list.sort((a, b) => a.s - b.s);
      for (let i = 0; i < list.length; i++)
        for (let j = i + 1; j < list.length && list[j].s <= list[i].e; j++)
          if (list[i].what || list[j].what) out.push({ machine: m, a: list[i].what, b: list[j].what });
    }
    return out;
  }

  /** 공유 파일 내용 검사 */
  function parse(text) {
    const st = JSON.parse(text);
    if (!st || st.app !== 'CNC_일정수립' || !st.model) throw new Error('CNC 공유작업 파일이 아닙니다');
    return st;
  }

  /** 백업 파일 이름: 순번이 앞에 와서 이름순 = 저장순 */
  function backupName(rev, savedAt, who) {
    const d = new Date(savedAt || Date.now());
    const p = (n) => String(n).padStart(2, '0');
    const stamp = d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
    return 'CNC_공유작업_' + String(rev || 0).padStart(6, '0') + '_' + stamp + '_' + String(who || '이름없음').replace(/[\\/:*?"<>|\s]+/g, '') + '.json';
  }

  return { FILE, BACKUP_DIR, KEEP_BACKUPS, FORMAT, MODEL_KEYS, hash, digest, changes, merge, overlaps, parse, backupName, itemsOf };
});
