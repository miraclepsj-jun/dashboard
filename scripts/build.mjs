// 단일 HTML 파일 빌드: src/* + vendor/xlsx.full.min.js 를 인라인하여 dist/CNC_일정수립.html 생성
// 사용: node scripts/build.mjs [--artifact <출력경로>]  (--artifact: <html>/<head> 없이 본문만)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const safe = (js) => js.replace(/<\/script/gi, '<\\/script');

const parts = {
  '/*__APP_CSS__*/': read('src/app.css'),
  '/*__XLSX__*/': safe(read('vendor/xlsx.full.min.js')),
  '/*__ENGINE__*/': safe(read('src/engine.js')),
  '/*__WORKBOOK__*/': safe(read('src/workbook.js')),
  '/*__DEMO__*/': safe(read('src/demo.js')),
  '/*__LEARN__*/': safe(read('src/learn.js')),
  '/*__APP_JS__*/': safe(read('src/app.js')),
};
let body = read('src/index.html');
for (const [k, v] of Object.entries(parts)) {
  if (!body.includes(k)) throw new Error('placeholder missing: ' + k);
  body = body.split(k).join(v);
}

const args = process.argv.slice(2);
const ai = args.indexOf('--artifact');
if (ai >= 0) {
  writeFileSync(args[ai + 1], body);
  console.log('artifact body →', args[ai + 1], (body.length / 1024).toFixed(0) + 'KB');
} else {
  const html = '<!doctype html>\n<html lang="ko">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n' + body.replace('<div class="app"', '</head>\n<body>\n<div class="app"') + '\n</body>\n</html>\n';
  mkdirSync(join(root, 'dist'), { recursive: true });
  const out = join(root, 'dist', 'CNC_일정수립.html');
  writeFileSync(out, html);
  console.log('built →', out, (html.length / 1024).toFixed(0) + 'KB');
}
