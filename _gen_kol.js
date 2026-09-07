'use strict';
// 临时:生成 4 位大V专属像素形象 —— 用完即删
const fs = require('fs');
const env = {};
fs.readFileSync('.env', 'utf8').split(/\r?\n/).forEach(l => { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) env[m[1]] = m[2].trim(); });
const KEY = env.LLM_IMAGE_KEY;
const BASE = 'https://open.bigmodel.cn/api/paas/v4';
const STYLE = '16-bit retro pixel art style, head and shoulders bust portrait, pure white background, clean crisp pixels, no text';
const SETS = [
  ['kol_cat', 'chibi anime financial pundit portrait, neat side-parted hair with gray flecks, rectangular glasses, calm skeptical expression, wearing a blazer with a small cat badge on the lapel', 'left'],
  ['kol_sx',  'chibi anime energetic young man portrait, spiky hair, shouting excitedly with a huge confident grin, wearing a sporty team jacket', 'center'],
  ['kol_tg',  'chibi anime anxious young musician portrait, messy hair, nervous sweaty expression, holding wooden drumsticks', 'left'],
  ['kol_qh',  'chibi anime quant geek portrait, black-rim glasses reflecting green terminal light, calm focused expression, wearing a headset', 'center'],
];
const DIRTXT = {
  left: 'head turned to his left side, three-quarter view facing left, looking toward the left',
  center: 'facing the camera directly, frontal symmetrical view, looking at the viewer',
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  for (const [key, desc, dir] of SETS) {
    let ok = false;
    for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
      try {
        const r = await fetch(BASE + '/images/generations', { method: 'POST', headers: { 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'glm-image', prompt: desc + ', ' + DIRTXT[dir] + ', ' + STYLE }) });
        const j = await r.json();
        const url = j.data && j.data[0] && j.data[0].url;
        if (!url) throw new Error((j.error && j.error.message || '').slice(0, 60));
        const img = await fetch(url);
        fs.writeFileSync('assets/px/' + key + '.png', Buffer.from(await img.arrayBuffer()));
        console.log(key + '(' + dir + ')', 'ok'); ok = true;
      } catch (e) { console.log(key, 'attempt' + attempt, e.message); await sleep(20000); }
    }
    await sleep(18000);
  }
  console.log('done');
})();
