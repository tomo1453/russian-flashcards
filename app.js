'use strict';

/*
 * 出題のしくみ
 * - 「まだ」：3枚後にもう一度出題（通常の出題に戻る）
 * - 「覚えた」：確認待ちになり、日数をあけて再出題する
 *     覚えた → 5日後に確認1 → 覚えた → 10日後に確認2 → 覚えた → 14日後に確認3 → 覚えた → 「知ってる」
 *   確認の途中で「まだ」が押されたら、確認をやめて通常の出題に戻す
 * - 期限が来た（過ぎた）確認の単語を最優先で出題する
 * - 「知ってる」に移った単語はもう出題しない
 */
const STORE_KEY = 'rf.state.v1';
const CHECK_DAYS = [5, 10, 14]; // 確認1・2・3 までの日数
const AGAIN_AFTER = 3;
const COLORS = [
  ['#ff6b6b', '#ff9f43'], ['#4d96ff', '#6bcbff'], ['#9b5de5', '#f15bb5'],
  ['#00b894', '#55efc4'], ['#ff7eb3', '#ffb86b'], ['#5f6cff', '#a66bff'],
  ['#f9a826', '#ffd166'], ['#00a8c6', '#4ae3c0'], ['#ef476f', '#ff8fab'],
];

let words = [];
// 単語ごとの状態 { id: { check: 1〜3, due: 日 } }（確認待ち） / { known: 日 }（知ってる）
// 記録がない単語は通常の出題
let state = {};
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
      color: COLORS[i % COLORS.length],
    };
  });
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
}

/* ===== 出題 ===== */
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

  // 通常の出題：記録のない単語からランダム
  const waiting = new Set(againQueue.map((a) => a.word.id));
  const normal = words.filter((w) => !state[w.id] && !waiting.has(w.id));
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
    $('#hint').textContent = '今日の出題はおしまい。確認の単語は期限が来たら出題されます';
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
  $('#hint').textContent = 'タップして裏返す';
  $('#ru').textContent = w.ru;
  $('#ru-small').textContent = w.ru;
  $('#ja').textContent = w.ja;
  $('#ex-ru').textContent = w.exRu;
  $('#ex-ja').textContent = w.exJa;
  $('#example').classList.toggle('hidden', !w.exRu);
  preload(w);
}

function flip() {
  if (busy || !current) return;
  card.classList.toggle('flipped');
}

function answer(remembered) {
  if (busy || !current) return; // 裏返す前でも回答できる
  busy = true;
  const id = current.id;
  const st = state[id];
  const t = today();
  if (remembered) {
    const n = st && st.check ? st.check : 0; // いま何回目の確認か（0 = 通常の出題）
    if (n >= CHECK_DAYS.length) {
      state[id] = { known: t };
    } else {
      state[id] = { check: n + 1, due: t + CHECK_DAYS[n] };
    }
  } else {
    delete state[id];
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
 * - audio/<id>.mp3 があればそれを <audio> で再生（iPhoneの消音モードでも鳴る）
 * - ファイルがない単語（後から追加した単語など）はブラウザの音声合成で読み上げ
 *   ※ 音声合成は消音モードでは鳴りません
 */
const player = new Audio();
player.preload = 'auto';
player.setAttribute('playsinline', '');
let utterance = null; // 途中で読み上げが切れないよう参照を保持

const audioUrl = (w) => `audio/${encodeURIComponent(w.id)}.mp3`;
const blobUrls = new Map(); // id → 先読みした音声（null はファイルなし）

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
async function preload(w) {
  if (blobUrls.has(w.id)) return;
  try {
    const res = await fetch(audioUrl(w));
    if (!res.ok) throw new Error(res.status);
    blobUrls.set(w.id, URL.createObjectURL(await res.blob()));
  } catch (e) {
    blobUrls.set(w.id, null);
  }
}

function speak() {
  if (!current) return;
  const w = current;
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) { /* 未対応 */ }
  const src = blobUrls.get(w.id);
  if (src === null) { speakSynth(w.ru); return; }
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  const url = src || audioUrl(w); // 先読みが間に合っていなければ直接再生
  if (player.src !== url) player.src = url;
  player.currentTime = 0;
  player.play().catch(() => speakSynth(w.ru));
}

/* ===== 起動 ===== */
async function init() {
  loadState();
  card.addEventListener('click', (e) => {
    if (e.target.closest('.speak')) { e.stopPropagation(); speak(); return; }
    flip();
  });
  $('#btn-good').addEventListener('click', () => answer(true));
  $('#btn-again').addEventListener('click', () => answer(false));
  // PCで確認する用：Space=裏返す ←=まだ →=覚えた
  document.addEventListener('keydown', (e) => {
    if (e.key === ' ') { e.preventDefault(); flip(); }
    if (e.key === 'ArrowLeft') answer(false);
    if (e.key === 'ArrowRight') answer(true);
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
