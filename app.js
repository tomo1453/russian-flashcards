'use strict';

/*
 * 出題のしくみ
 * - 単語ごとに「覚えた度」(0〜5) を localStorage に保存
 * - 覚えた度が高いほど出題されにくい（重み 1/2^覚えた度 のランダム）
 * - 「まだ」を押した単語は覚えた度を0に戻し、3枚後にもう一度出す
 */
const STORE_KEY = 'rf.level.v1';
const MAX_LEVEL = 5;
const AGAIN_AFTER = 3;
const COLORS = [
  ['#ff6b6b', '#ff9f43'], ['#4d96ff', '#6bcbff'], ['#9b5de5', '#f15bb5'],
  ['#00b894', '#55efc4'], ['#ff7eb3', '#ffb86b'], ['#5f6cff', '#a66bff'],
  ['#f9a826', '#ffd166'], ['#00a8c6', '#4ae3c0'], ['#ef476f', '#ff8fab'],
];

let words = [];
let levels = {};
let current = null;
let recent = [];      // 直近に出した単語（連続で出さないため）
let againQueue = [];  // [{ word, wait }]
let ruVoice = null;
let busy = false;

const $ = (s) => document.querySelector(s);
const card = $('#card');

/* ===== データ ===== */
function loadLevels() {
  try { levels = JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch (e) { levels = {}; }
}
function saveLevels() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(levels)); } catch (e) { /* 保存不可でも続行 */ }
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

/* ===== 出題 ===== */
function pickNext() {
  againQueue.forEach((a) => a.wait--);
  const readyIdx = againQueue.findIndex((a) => a.wait <= 0);
  if (readyIdx >= 0) return againQueue.splice(readyIdx, 1)[0].word;

  const waiting = new Set(againQueue.map((a) => a.word.id));
  let pool = words.filter((w) => !recent.includes(w.id) && !waiting.has(w.id));
  if (!pool.length) pool = words.filter((w) => w !== current);
  if (!pool.length) pool = words;

  const weight = (w) => 1 / Math.pow(2, levels[w.id] || 0);
  let r = Math.random() * pool.reduce((sum, w) => sum + weight(w), 0);
  for (const w of pool) { r -= weight(w); if (r <= 0) return w; }
  return pool[pool.length - 1];
}

function render(w) {
  current = w;
  recent = [w.id, ...recent].slice(0, Math.min(5, Math.floor(words.length / 2)));
  card.style.setProperty('--c1', w.color[0]);
  card.style.setProperty('--c2', w.color[1]);
  $('#ru').textContent = w.ru;
  $('#ru-small').textContent = w.ru;
  $('#ja').textContent = w.ja;
  $('#ex-ru').textContent = w.exRu;
  $('#ex-ja').textContent = w.exJa;
  $('#example').classList.toggle('hidden', !w.exRu);
}

function flip() {
  if (busy || !current) return;
  card.classList.toggle('flipped');
  $('#buttons').classList.toggle('waiting', !card.classList.contains('flipped'));
}

function answer(remembered) {
  if (busy || !current || !card.classList.contains('flipped')) return;
  busy = true;
  if (remembered) {
    levels[current.id] = Math.min(MAX_LEVEL, (levels[current.id] || 0) + 1);
  } else {
    levels[current.id] = 0;
    againQueue.push({ word: current, wait: AGAIN_AFTER + 1 });
  }
  saveLevels();

  const stage = $('#stage');
  $('#buttons').classList.add('waiting');
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
function speak() {
  if (!current || !('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(stripAccent(current.ru).replace(/…/g, ' '));
  u.lang = 'ru-RU';
  u.rate = 0.9;
  if (ruVoice) u.voice = ruVoice;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

/* ===== 起動 ===== */
async function init() {
  loadLevels();
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
  $('#buttons').classList.add('waiting');

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

document.addEventListener('DOMContentLoaded', init);
