/*
 * 예시 데이터 (가상). 실제 회사 데이터가 아니며 화면 첫 실행과 테스트에 사용한다.
 * 마스터 구조는 기존 통합문서(3/4/5/6/13/16/21번 시트)와 같다.
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CNCDemo = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';
  const E = typeof module === 'object' && module.exports ? require('./engine.js') : root.CNCEngine;

  function rng(seed) {
    let s = seed >>> 0;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  }

  function build(today) {
    today = today || E.todaySerial();
    const rand = rng(20260928);
    const pick = (arr) => arr[Math.floor(rand() * arr.length)];

    const rooms = [
      { name: '1번방', matGroup: 'SK', prodClass: 'AR', mainAllowed: 'PL/TE', special: 'N', autoUse: 'Y' },
      { name: '2번방', matGroup: 'BECU', prodClass: 'AR', mainAllowed: 'PL/TE', special: 'N', autoUse: 'Y' },
      { name: '3번방', matGroup: '', prodClass: 'BD', mainAllowed: 'BD', special: 'N', autoUse: 'Y' },
      { name: '4번방', matGroup: 'BECU', prodClass: '커터', mainAllowed: 'PL/TE', special: 'N', autoUse: 'Y' },
      { name: '5번방', matGroup: 'TK/H3J', prodClass: '', mainAllowed: 'PL/TE', special: 'N', autoUse: 'Y' },
      { name: '6번방', matGroup: 'TK', prodClass: '커터', mainAllowed: 'PL/TE', special: 'N', autoUse: 'Y' },
      { name: '7번방', matGroup: '', prodClass: '', mainAllowed: 'PL/TE/BD', special: 'Y', series: 'G105/G135/G230', autoUse: '조건부' },
      { name: '8번방', matGroup: '', prodClass: '', mainAllowed: '', special: 'Y', autoUse: 'N' },
    ];
    const roomStart = { '1번방': 1, '2번방': 103, '3번방': 191, '4번방': 306, '5번방': 413, '6번방': 519, '7번방': 649, '8번방': 725 };
    const perRoom = 10;
    const machines = [];
    const workers = [];
    for (const r of rooms) {
      for (let i = 0; i < perRoom; i++) {
        const no = String(roomStart[r.name] + i);
        const isBD = r.name === '3번방' || r.name === '7번방';
        machines.push({
          no,
          room: r.name,
          material: r.name === '5번방' || r.name === '6번방' ? 'TK(0.7)' : r.name === '2번방' && i < 3 ? 'H3J' : i % 4 === 0 ? 'SK-4' : '',
          model: r.name === '7번방' ? 'B12' : r.name === '4번방' && i % 3 === 0 ? 'P013' : 'P033H',
          cutter: r.name === '6번방' ? pick(['모노 70', '모노 60', 'S45 x 1F']) : '',
          scheduleTarget: 'Y',
          bdOk: isBD || r.name === '1번방' ? 'Y' : 'N',
          bdMin: r.name === '7번방' ? 1 : 0.6,
          bdMax: r.name === '7번방' ? 4 : 3,
          bdMaxLen: r.name === '7번방' ? null : 30,
          plOk: 'Y',
          teOk: 'Y',
          newSetupOk: 'Y',
        });
        workers.push({ machine: no, worker: 'R' + r.name[0] + '-' + String(i + 1).padStart(2, '0'), room: r.name, status: '', start: null, end: null, noSetup: 'N' });
      }
    }
    // 예시: 6번방 524호기 고장, 1번방 셋째 호기 신규세팅금지
    workers[55].status = '고장';
    workers[55].start = today;
    workers[55].end = today + 3;
    workers[2].noSetup = 'Y';

    const rules = [
      ['0', 'AR', '포함', 'AR', 'AR'],
      ['1', 'C9', '포함', 'C9', '커터'],
      ['3', 'AM', '포함', 'AM', '커터'],
      ['9', 'C', '본체끝문자', 'C', '커터'],
      ['10', 'R-', '포함', 'R-', 'AR'],
      ['11', 'A', '본체끝문자', 'A', '커터'],
      ['23', 'GPC', '포함', 'GPC', 'TK'],
      ['24', 'GP', '포함', 'GP', 'TK'],
      ['32', 'R', '본체끝문자', 'R', 'AR'],
      ['100', 'BD', '앞2자리', 'BD', 'BD'],
      ['110', 'PL', '앞2자리', 'PL', 'PL'],
      ['111', 'TE', '앞2자리', 'TE', 'TE'],
      ['120', 'BG', '앞2자리', 'BG', 'BG'],
    ].map(([priority, keyword, method, detail, prod]) => ({ priority, keyword, method, detail, prod, active: 'Y' }));

    const productivity = [
      { cls: 'AR', daily: 5000, buffer: 'Y' },
      { cls: '커터', daily: 3000, buffer: 'Y' },
      { cls: 'BD', daily: 4000, buffer: 'Y' },
      { cls: 'TK', daily: 4000, buffer: 'Y' },
      { cls: 'PL', daily: 2000, buffer: 'Y' },
      { cls: 'TE', daily: 2000, buffer: 'Y' },
    ];

    const templates = [
      { pc: 'DB{n}SAR-TSK', part: 'PLDB{n}AR-B', mat: 'SK-4' },
      { pc: 'GX{n}AMAR-DGP', part: 'TEGX{n}AM-DGP', mat: 'TK-B' },
      { pc: 'GC{n}AMR-DGPC', part: 'TEGC{n}AM-DGPC', mat: 'H3J' },
      { pc: 'LLG{n}R-D', part: 'PLLLG{n}AR-D', mat: 'C1730' },
      { pc: 'DB{n}C-B', part: 'PLDB{n}C-B', mat: 'BECU' },
      { pc: 'DBE{n}RR-R3', part: 'BDDBE{n}', mat: 'PbT' },
      { pc: 'G105{n}-S', part: 'PLG105{n}-S', mat: 'C3604' },
      { pc: 'B88-{n}BG', part: 'BG-35-120', mat: 'A6061' },
    ];
    const raw = [];
    for (let i = 0; i < 64; i++) {
      const t = templates[i % templates.length];
      const n = String(100 + Math.floor(rand() * 900));
      const qty = pick([1000, 2000, 2500, 4000, 6000, 10000, 20000, 45000, 120000]);
      const due = today + Math.floor(rand() * 30) - 3;
      raw.push({
        planNo: '26' + String(9).padStart(2, '0') + String(10 + (i % 18)).padStart(2, '0') + '-' + String(i + 1).padStart(3, '0'),
        productCode: t.pc.replace('{n}', n),
        partCode: t.part.replace('{n}', n),
        qty,
        reqDate: rand() < 0.1 ? null : due,
        material: t.mat,
        special: i % 11 === 0 ? 'Y' : 'N',
        workArea: String(1 + (i % 3)),
        refMachines: [],
      });
    }
    // 같은 부품이 이미 돌고 있는 호기 (연속가공 우대 예시)
    const confirmed = [
      { planNo: '260901-001', productCode: raw[1].productCode, partCode: raw[1].partCode, machine: '519', start: today - 6, end: today + 1, qty: 20000, actualQty: 12000, actualDate: today - 1 },
      { planNo: '260901-002', productCode: 'DB221SAR-TSK', partCode: 'PLDB221AR-B', machine: '1', start: today - 8, end: today - 2, qty: 15000, actualQty: 15000, actualDate: today - 3, actualOk: 'Y' },
      { planNo: '260901-003', productCode: 'GC300AMR-DGPC', partCode: 'TEGC300AM-DGPC', machine: '413', start: today - 5, end: today - 1, qty: 12000 },
      { planNo: '260901-004', productCode: 'DB410C-B', partCode: 'PLDB410C-B', machine: '306', start: today - 2, end: today + 4, qty: 18000, actualQty: 6000, actualDate: today - 1 },
    ];
    // 확정된 기존 발주도 원본 목록에 남아 있다 (배정완료 상태)
    raw.push({ planNo: '260901-001', productCode: raw[1].productCode, partCode: raw[1].partCode, qty: 20000, reqDate: today + 2, material: raw[1].material, special: 'N', workArea: '2', refMachines: ['519'] });
    return {
      raw,
      rooms,
      machines,
      rules,
      productivity,
      workers,
      bgRules: [
        { room: '1번방', odMin: 0, odMax: 2 },
        { room: '2번방', odMin: 2, odMax: 2.5 },
        { room: '3번방', odMin: 2.5, odMax: 3 },
      ],
      bdSpecs: [{ part: raw[5].partCode, od: 0.7, len: 15 }],
      confirmed,
    };
  }

  return { build };
});
