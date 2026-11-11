// E-001: Stop 훅 파킹 실험용 훅.
// Claude가 응답을 끝내려 할 때마다 실행된다.
//  - release.txt 가 생길 때까지 기다린다 (= 세션 파킹)
//  - release.txt 내용이 "STOP" 이면 멈춤 허용
//  - 그 외 내용이면 그 텍스트를 다음 지시로 Claude에게 전달 (decision: block)
// 모든 이벤트는 hook.log 에 기록한다.

const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const RELEASE = path.join(DIR, 'release.txt');
const LOG = path.join(DIR, 'hook.log');
const log = (m) => fs.appendFileSync(LOG, `${new Date().toISOString()} ${m}\n`);

let input = '';
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  let info = {};
  try { info = JSON.parse(input); } catch { log('stdin parse failed'); }
  log(`STOP fired  session=${info.session_id}  stop_hook_active=${info.stop_hook_active}`);
  log(`  last message: ${(info.last_assistant_message || '').slice(0, 80).replace(/\s+/g, ' ')}`);
  log('  parked — waiting for release.txt ...');

  const started = Date.now();
  const timer = setInterval(() => {
    if (!fs.existsSync(RELEASE)) return;
    let text = '';
    try { text = fs.readFileSync(RELEASE, 'utf8').trim(); fs.unlinkSync(RELEASE); } catch { return; }
    clearInterval(timer);
    const waited = Math.round((Date.now() - started) / 1000);
    if (text === 'STOP' || text === '') {
      log(`  released after ${waited}s → allow stop`);
      process.exit(0);
    }
    log(`  released after ${waited}s → block with: ${text.slice(0, 80)}`);
    process.stdout.write(JSON.stringify({ decision: 'block', reason: text }));
    process.exit(0);
  }, 1000);
});
