'use strict';

/*
 * 出題のしくみ
 * - 「まだ」：3枚後にもう一度出題（通常の出題に戻る）
 * - 「覚えた」：確認待ちになり、日数をあけて再出題する
 *     覚えた → 5日後に確認1 → 覚えた → 10日後に確認2 → 覚えた → 14日後に確認3 → 覚えた → 「知ってる」
 *   確認の途中で「まだ」が押されたら、確認をやめて通常の出題に戻す
 * - 期限が来た（過ぎた）確認の単語を最優先で出題する
 * - 「知ってる」：確認なしですぐ「知ってる」に移す（最初から知っている単語用）
 * - 「知ってる」に移った単語はもう出題しない
 * - まだ一度も出ていない単語（新出単語）は1日 settings.newPerDay 語まで（「知ってる」は数えない）
 * - 優先順：「まだ」の再出題 → 期限が来た確認 → 出たことのある単語＋新出単語（上限まで）
 */
const STORE_KEY = 'rf.state.v1';
const CHECK_DAYS = [5, 10, 14]; // 確認1・2・3 までの日数
const AGAIN_AFTER = 3;
const SETTINGS_KEY = 'rf.settings.v1';
const DAILY_KEY = 'rf.daily.v1';
const DEFAULT_SETTINGS = { newPerDay: 20 };
const COLORS = [
  ['#ff6b6b', '#ff9f43'], ['#4d96ff', '#6bcbff'], ['#9b5de5', '#f15bb5'],
  ['#00b894', '#55efc4'], ['#ff7eb3', '#ffb86b'], ['#5f6cff', '#a66bff'],
  ['#f9a826', '#ffd166'], ['#00a8c6', '#4ae3c0'], ['#ef476f', '#ff8fab'],
];

let words = [];
// 単語ごとの状態 { id: { check: 1〜3, due: 日 } }（確認待ち） / { known: 日 }（知ってる）
// { seen: 日 } は一度出たことがある通常の単語、記録がない単語はまだ一度も出ていない単語
let state = {};
let settings = { ...DEFAULT_SETTINGS };
let daily = { date: 0, newCount: 0 }; // 今日覚え始めた新出単語の数
let current = null;
let recent = [];      // 直近に出した単語（連続で出さないため）
let againQueue = [];  // [{ word, wait }]
let ruVoice = null;
let busy = false;

const $ = (s) => document.querySelector(s);
const card = $('#card');

/* ===== データ ===== */
function loadState() {
  try { state = JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch (e) { state = {}; }
  try { localStorage.removeItem('rf.level.v1'); } catch (e) { /* 旧形式の記録を削除 */ }
}
function loadSettings() {
  try { settings = { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY)) }; } catch (e) { /* 既定値 */ }
  try { daily = { ...daily, ...JSON.parse(localStorage.getItem(DAILY_KEY)) }; } catch (e) { /* 既定値 */ }
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* 保存不可でも続行 */ }
}
function newCountToday() {
  if (daily.date !== today()) daily = { date: today(), newCount: 0 };
  return daily.newCount;
}
function countNew() {
  newCountToday();
  daily.newCount++;
  try { localStorage.setItem(DAILY_KEY, JSON.stringify(daily)); } catch (e) { /* 保存不可でも続行 */ }
}
const newLeft = () => Math.max(0, settings.newPerDay - newCountToday());
function saveState() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* 保存不可でも続行 */ }
}

// 端末の現地時間での日付（日単位の通し番号）
function today() {
  const d = new Date();
  return Math.floor((d.getTime() - d.getTimezoneOffset() * 60000) / 86400000);
}

// "Здра+вствуйте" の + 記法をアクセント記号に変換
const normalizeRu = (s) => String(s || '').normalize('NFC').replace(/([аеёиоуыэюяАЕЁИОУЫЭЮЯ])\+/g, '$1́');
const stripAccent = (s) => String(s || '').replace(/́/g, '');

async function loadWords() {
  const res = await fetch('data/words.json', { cache: 'no-cache' });
  const raw = await res.json();
  words = raw.filter((w) => w && w.ru && w.ja).map((w, i) => {
    const ru = normalizeRu(w.ru);
    return {
      id: String(w.id || stripAccent(ru)),
      ru,
      ja: String(w.ja),
      exRu: normalizeRu(w.ex_ru),
      exJa: String(w.ex_ja || ''),
      pic: String(w.pic || ''),   // 絵文字（スペース区切り。先頭がメイン）
      img: String(w.img || ''),   // 画像ファイル（指定があれば絵文字より優先）
      color: COLORS[i % COLORS.length],
    };
  });
}

/* ===== 表紙の絵 ===== */
// 先頭の絵文字を大きく、残りを周りに小さく配置。img があれば画像を表示
// concealed のときは「？」で隠し、タップすると出てくる
function renderPic(pic, img, concealed = true) {
  const box = $('#pic');
  box.textContent = '';
  box.classList.toggle('has-img', !!img);
  box.classList.remove('popping');
  box.classList.toggle('concealed', concealed);
  const mystery = document.createElement('span');
  mystery.className = 'mystery';
  mystery.innerHTML = '？<small>タップで絵</small>';
  if (img) {
    box.hidden = false;
    const el = document.createElement('img');
    el.src = img;
    el.alt = '';
    box.appendChild(el);
    box.appendChild(mystery);
    return;
  }
  const [main, ...acc] = pic.trim().split(/\s+/).filter(Boolean);
  box.hidden = !main;
  if (!main) return;
  const m = document.createElement('span');
  m.className = 'main';
  m.textContent = main;
  box.appendChild(m);
  acc.slice(0, 3).forEach((a, i) => {
    const el = document.createElement('span');
    el.className = `acc a${i + 1}`;
    el.textContent = a;
    box.appendChild(el);
  });
  box.appendChild(mystery);
}

function revealPic() {
  const box = $('#pic');
  if (!box.classList.contains('concealed')) return;
  box.classList.remove('concealed');
  box.classList.add('popping');
  setTimeout(() => box.classList.remove('popping'), 550);
}

/* ===== 達成度 ===== */
function updateStats() {
  let known = 0, checking = 0;
  words.forEach((w) => {
    const st = state[w.id];
    if (!st) return;
    if (st.known) known++;
    else if (st.check) checking++;
  });
  $('#known').textContent = known;
  $('#total').textContent = words.length;
  $('#checking').textContent = checking;
  $('#new-today').textContent = `${newCountToday()}/${settings.newPerDay}`;
}

/* ===== 出題 ===== */
// 通常の出題対象か（未出題 or 出たことがある通常の単語）
const isNormal = (st) => !st || (!st.check && !st.known);

function pickNext() {
  againQueue.forEach((a) => a.wait--);
  const readyIdx = againQueue.findIndex((a) => a.wait <= 0);
  if (readyIdx >= 0) return againQueue.splice(readyIdx, 1)[0].word;

  // 期限が来た確認の単語を優先（期限が古い順）
  const t = today();
  const due = words
    .filter((w) => w !== current && state[w.id] && state[w.id].check && state[w.id].due <= t)
    .sort((a, b) => state[a.id].due - state[b.id].due);
  if (due.length) return due[0];

  // 通常の出題：出たことのある単語と、新出単語（今日の上限まで）からランダム
  const waiting = new Set(againQueue.map((a) => a.word.id));
  const allowNew = newLeft() > 0;
  const normal = words.filter((w) => isNormal(state[w.id]) && !waiting.has(w.id) && (allowNew || state[w.id]));
  let pool = normal.filter((w) => !recent.includes(w.id));
  if (!pool.length) pool = normal.filter((w) => w !== current);
  if (!pool.length) pool = normal;
  if (pool.length) return pool[Math.floor(Math.random() * pool.length)];

  // 残りが「まだ」の待ちだけなら前倒しで出す
  if (againQueue.length) return againQueue.shift().word;
  return null;
}

function render(w) {
  current = w;
  updateStats();
  if (!w) {
    // 今日出す単語がない
    card.style.setProperty('--c1', '#2ec4a6');
    card.style.setProperty('--c2', '#4ae3c0');
    $('#ru').textContent = 'Молоде́ц!';
    $('#ru').classList.remove('long');
    renderPic('🎉 ⭐ 🏆', '', false);
    $('#hint').textContent = newLeft() === 0 && words.some((w) => !state[w.id])
      ? `今日の新しい単語（${settings.newPerDay}語）はおしまい。また明日！`
      : '今日の出題はおしまい。確認の単語は期限が来たら出題されます';
    $('#badge').hidden = true;
    card.querySelectorAll('.speak').forEach((b) => { b.hidden = true; });
    $('#buttons').classList.add('waiting');
    return;
  }
  card.querySelectorAll('.speak').forEach((b) => { b.hidden = false; });
  $('#buttons').classList.remove('waiting');
  recent = [w.id, ...recent].slice(0, Math.min(5, Math.floor(words.length / 2)));
  card.style.setProperty('--c1', w.color[0]);
  card.style.setProperty('--c2', w.color[1]);
  const st = state[w.id];
  $('#badge').hidden = !(st && st.check);
  if (st && st.check) $('#badge').textContent = `確認 ${st.check}/${CHECK_DAYS.length}`;
  $('#hint').textContent = '下半分をタップして裏返す';
  renderPic(w.pic, w.img);
  // ハイフンで改行されないようにし、長いフレーズは文字を小さく
  $('#ru').textContent = w.ru.replace(/-/g, '\u2011');
  $('#ru').classList.toggle('long', stripAccent(w.ru).length > 14);
  $('#ru-small').textContent = w.ru.replace(/-/g, '\u2011');
  $('#ja').textContent = w.ja;
  $('#ja').classList.toggle('long', w.ja.length > 8);
  $('#ex-ru').textContent = w.exRu;
  $('#ex-ja').textContent = w.exJa;
  $('#example').classList.toggle('hidden', !w.exRu);
  preload(w);
}

function flip() {
  if (busy || !current) return;
  card.classList.toggle('flipped');
}

// kind: 'again'（まだ） / 'good'（覚えた） / 'known'（知ってる）
function answer(kind) {
  if (busy || !current) return; // 裏返す前でも回答できる
  busy = true;
  const id = current.id;
  const st = state[id];
  const t = today();
  if (!st && kind !== 'known') countNew(); // 新出単語を覚え始めた（「知ってる」は数えない）
  if (kind === 'known') {
    state[id] = { known: t };
  } else if (kind === 'good') {
    const n = st && st.check ? st.check : 0; // いま何回目の確認か（0 = 通常の出題）
    if (n >= CHECK_DAYS.length) {
      state[id] = { known: t };
    } else {
      state[id] = { check: n + 1, due: t + CHECK_DAYS[n] };
    }
  } else {
    state[id] = { seen: t };
    againQueue.push({ word: current, wait: AGAIN_AFTER + 1 });
  }
  saveState();

  const stage = $('#stage');
  stage.classList.add('leave');
  setTimeout(() => {
    stage.classList.remove('leave');
    card.classList.add('no-anim');
    card.classList.remove('flipped');
    render(pickNext());
    void card.offsetWidth; // 裏返しを瞬時にリセット
    card.classList.remove('no-anim');
    stage.classList.add('enter');
    setTimeout(() => { stage.classList.remove('enter'); busy = false; }, 360);
  }, 220);
}

/* ===== 音声 ===== */
function loadVoice() {
  const voices = speechSynthesis.getVoices().filter((v) => /^ru/i.test(v.lang));
  ruVoice = voices.find((v) => v.localService) || voices[0] || null;
}
/*
 * 読み上げ
 * - 単語は audio/<id>.mp3、例文は audio/ex/<id>.mp3 を <audio> で再生（iPhoneの消音モードでも鳴る）
 * - ファイルがない単語・例文（後から追加したものなど）はブラウザの音声合成で読み上げ
 *   ※ 音声合成は消音モードでは鳴りません
 */
const player = new Audio();
player.preload = 'auto';
player.setAttribute('playsinline', '');
let utterance = null; // 途中で読み上げが切れないよう参照を保持

// kind: 'word'（単語） / 'ex'（例文）
const audioUrl = (w, kind) => `audio/${kind === 'ex' ? 'ex/' : ''}${encodeURIComponent(w.id)}.mp3`;
const blobUrls = new Map(); // "kind:id" → 先読みした音声（null はファイルなし）

function speakSynth(text) {
  if (!('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  utterance = new SpeechSynthesisUtterance(stripAccent(text).replace(/…/g, ' '));
  utterance.lang = 'ru-RU';
  utterance.rate = 0.9;
  if (ruVoice) utterance.voice = ruVoice;
  // cancel() 直後に speak() すると iOS で途切れることがあるため少し待つ
  setTimeout(() => speechSynthesis.speak(utterance), 50);
}

// カード表示時に音声ファイルを先読み（タップした瞬間にすぐ再生できるように）
async function preloadOne(w, kind) {
  const key = `${kind}:${w.id}`;
  if (blobUrls.has(key)) return;
  try {
    const res = await fetch(audioUrl(w, kind));
    if (!res.ok) throw new Error(res.status);
    blobUrls.set(key, URL.createObjectURL(await res.blob()));
  } catch (e) {
    blobUrls.set(key, null);
  }
}
function preload(w) {
  preloadOne(w, 'word');
  if (w.exRu) preloadOne(w, 'ex');
}

function speak(kind = 'word') {
  if (!current) return;
  const w = current;
  const text = kind === 'ex' ? w.exRu : w.ru;
  if (!text) return;
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) { /* 未対応 */ }
  const src = blobUrls.get(`${kind}:${w.id}`);
  if (src === null) { speakSynth(text); return; }
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  const url = src || audioUrl(w, kind); // 先読みが間に合っていなければ直接再生
  if (player.src !== url) player.src = url;
  player.currentTime = 0;
  player.play().catch(() => speakSynth(text));
}

/* ===== 設定 ===== */
function setupSettings() {
  const dlg = $('#settings');
  const sel = $('#set-new');
  $('#btn-settings').addEventListener('click', () => {
    sel.value = String(settings.newPerDay);
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
  });
  $('#btn-close').addEventListener('click', () => { if (dlg.close) dlg.close(); else dlg.removeAttribute('open'); });
  sel.addEventListener('change', () => {
    settings.newPerDay = Number(sel.value);
    saveSettings();
    updateStats();
    // 出題がおしまい表示で、上限を増やした場合はすぐ再開
    if (!current && words.length) render(pickNext());
  });
}

/* ===== 起動 ===== */
async function init() {
  loadState();
  loadSettings();
  setupSettings();
  // 表面：真ん中の絵をタップ → 絵が出る / 下半分をタップ → 裏返す
  // 裏面：どこをタップしても表に戻る
  card.addEventListener('click', (e) => {
    if (e.target.closest('.speak')) { e.stopPropagation(); speak('word'); return; }
    if (e.target.closest('.speak-ex')) { e.stopPropagation(); speak('ex'); return; }
    if (card.classList.contains('flipped')) { flip(); return; }
    if (e.target.closest('#pic')) { revealPic(); return; } // 絵の上のタップでは裏返さない
    const r = card.getBoundingClientRect();
    if (e.clientY - r.top > r.height / 2) flip();
  });
  $('#btn-again').addEventListener('click', () => answer('again'));
  $('#btn-good').addEventListener('click', () => answer('good'));
  $('#btn-known').addEventListener('click', () => answer('known'));
  // PCで確認する用：Space=裏返す ←=まだ →=覚えた
  document.addEventListener('keydown', (e) => {
    if (e.key === ' ') { e.preventDefault(); flip(); }
    if (e.key === '1') answer('again');
    if (e.key === '2') answer('good');
    if (e.key === '3') answer('known');
  });

  if ('speechSynthesis' in window) {
    loadVoice();
    speechSynthesis.addEventListener('voiceschanged', loadVoice);
  }

  try {
    await loadWords();
  } catch (e) {
    $('#ru').textContent = '単語データを読み込めませんでした';
    return;
  }
  if (!words.length) { $('#ru').textContent = '単語がありません'; return; }
  render(pickNext());

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

document.addEventListener('DOMContentLoaded', init);
