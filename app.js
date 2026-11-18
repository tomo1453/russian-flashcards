'use strict';

/* ========= 定数・状態 ========= */
const APP_VERSION = '1.0.0';
const WORDS_URL = 'data/words.json';
const KEYS = { progress: 'rf.progress.v1', settings: 'rf.settings.v1', daily: 'rf.daily.v1' };
const ACCENT = '́';
const DEFAULTS = { dir: 'ru2ja', newPerDay: 10, rate: 0.9, autoSpeak: true, voiceURI: '', cats: [] };

let words = [];        // 単語データ
let categories = [];   // 出現順のカテゴリ名
let progress = {};     // { "id|dir": {due, ivl, ease, reps, lapses, last} }
let settings = {};
let daily = {};        // { date, newCount: {ru2ja, ja2ru} }
let session = null;
let ruVoices = [];

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

/* ========= 保存 ========= */
function load(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
  catch (e) { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); }
  catch (e) { toast('保存できませんでした（容量・プライベートモードを確認）'); }
}
const saveProgress = () => save(KEYS.progress, progress);
const saveSettings = () => save(KEYS.settings, settings);
const saveDaily = () => save(KEYS.daily, daily);

/* ========= 日付（端末の現地時間で日単位） ========= */
function today() {
  const d = new Date();
  return Math.floor((d.getTime() - d.getTimezoneOffset() * 60000) / 86400000);
}
function dayToDate(day) {
  const d = new Date(day * 86400000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

/* ========= テキスト処理 ========= */
// "Здра+вствуйте" の + 記法もアクセント記号に変換（単語追加を楽にするため）
function normalizeRu(s) {
  return String(s || '').normalize('NFC')
    .replace(/([аеёиоуыэюяАЕЁИОУЫЭЮЯ])\+/g, '$1' + ACCENT);
}
const stripAccent = (s) => String(s || '').replace(/[́̀]/g, '');
function esc(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// アクセントのある母音を色付け
function ruHTML(s) {
  return esc(s).replace(/([^\s])́/g, '<span class="stress">$1́</span>');
}

/* ========= 単語データ読み込み ========= */
async function loadWords() {
  const res = await fetch(WORDS_URL, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const raw = await res.json();
  const seen = new Set();
  words = [];
  raw.forEach((w, i) => {
    if (!w || !w.ru || !w.ja) { console.warn('ru/ja がない行をスキップ:', i, w); return; }
    const ru = normalizeRu(w.ru);
    let id = String(w.id || stripAccent(ru)).trim();
    if (seen.has(id)) { console.warn('ID重複:', id); id = id + '#' + i; }
    seen.add(id);
    words.push({
      id, ru,
      ja: String(w.ja),
      cat: String(w.cat || 'その他'),
      ex_ru: normalizeRu(w.ex_ru),
      ex_ja: String(w.ex_ja || ''),
      note: normalizeRu(w.note),
    });
  });
  categories = [...new Set(words.map((w) => w.cat))];
}

/* ========= 間隔反復（SM-2 を簡略化） ========= */
const key = (w, dir = settings.dir) => `${w.id}|${dir}`;
const stateOf = (w, dir) => progress[key(w, dir)];

function schedule(prev, grade) {
  const s = prev ? { ...prev } : { ivl: 0, ease: 2.5, reps: 0, lapses: 0 };
  const t = today();
  if (grade === 'again') {
    s.lapses += 1; s.reps = 0; s.ivl = 0;
    s.ease = Math.max(1.3, s.ease - 0.2);
  } else if (grade === 'hard') {
    s.ivl = s.reps === 0 ? 1 : Math.max(1, Math.round(s.ivl * 1.2));
    s.ease = Math.max(1.3, s.ease - 0.15);
    s.reps += 1;
  } else { // good
    if (s.reps === 0) s.ivl = 2;
    else s.ivl = Math.max(s.ivl + 1, Math.round(s.ivl * s.ease));
    s.ease = Math.min(3.0, s.ease + 0.05);
    s.reps += 1;
  }
  s.ivl = Math.min(s.ivl, 365);
  s.due = t + s.ivl;
  s.last = t;
  return s;
}
function ivlLabel(ivl) {
  if (ivl <= 0) return 'もう一度';
  if (ivl < 30) return `${ivl}日後`;
  if (ivl < 365) return `約${Math.round(ivl / 30)}か月後`;
  return '約1年後';
}

/* ========= 1日の新出カウント ========= */
function ensureDaily() {
  if (daily.date !== today()) { daily = { date: today(), newCount: { ru2ja: 0, ja2ru: 0 } }; saveDaily(); }
}
function newRemaining() {
  ensureDaily();
  if (!settings.newPerDay) return Infinity;
  return Math.max(0, settings.newPerDay - (daily.newCount[settings.dir] || 0));
}

/* ========= 集計 ========= */
function filteredWords() {
  return settings.cats.length ? words.filter((w) => settings.cats.includes(w.cat)) : words;
}
function computeStats() {
  const t = today();
  const list = filteredWords();
  let due = 0, fresh = 0, learned = 0;
  list.forEach((w) => {
    const s = stateOf(w);
    if (!s) fresh++;
    else { learned++; if (s.due <= t) due++; }
  });
  return { due, fresh, newToday: Math.min(fresh, newRemaining()), learned, total: list.length };
}

/* ========= 画面切替 ========= */
function show(view) {
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + view));
  $$('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  document.body.classList.toggle('studying', view === 'study');
  if (view === 'home') renderHome();
  if (view === 'list') renderList();
  window.scrollTo(0, 0);
}

/* ========= ホーム ========= */
function renderHome() {
  $$('.seg button').forEach((b) => b.classList.toggle('active', b.dataset.dir === settings.dir));
  const st = computeStats();
  $('#st-due').textContent = st.due;
  $('#st-new').textContent = st.newToday;
  $('#st-learned').textContent = `${st.learned}/${st.total}`;
  const n = st.due + st.newToday;
  const btn = $('#btn-start');
  btn.disabled = n === 0;
  btn.textContent = n ? `学習を始める（${n}枚）` : '今日の学習は完了！';
  $('#home-msg').textContent = n ? ''
    : st.fresh ? '新出単語は明日また出題されます。設定で1日の数を増やせます。'
    : 'このカテゴリの単語はすべて学習済みです。';

  const counts = {};
  words.forEach((w) => { counts[w.cat] = (counts[w.cat] || 0) + 1; });
  const chips = [`<button class="chip ${settings.cats.length ? '' : 'active'}" data-cat="">すべて<small>${words.length}</small></button>`]
    .concat(categories.map((c) =>
      `<button class="chip ${settings.cats.includes(c) ? 'active' : ''}" data-cat="${esc(c)}">${esc(c)}<small>${counts[c]}</small></button>`));
  $('#cats').innerHTML = chips.join('');
}

/* ========= 学習セッション ========= */
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function startSession(cram = false) {
  const t = today();
  const list = filteredWords();
  let queue;
  if (cram) {
    queue = shuffle(list.slice()).slice(0, 20);
  } else {
    const reviews = shuffle(list.filter((w) => { const s = stateOf(w); return s && s.due <= t; }))
      .sort((a, b) => stateOf(a).due - stateOf(b).due);
    const fresh = list.filter((w) => !stateOf(w)).slice(0, newRemaining());
    // 復習の合間に新出単語を混ぜる
    queue = [];
    const r = reviews.slice(), f = fresh.slice();
    while (r.length || f.length) {
      if (r.length) queue.push(r.shift());
      if (r.length) queue.push(r.shift());
      if (f.length) queue.push(f.shift());
    }
  }
  if (!queue.length) { toast('出題できる単語がありません'); return; }
  session = { queue, idx: 0, cram, total: queue.length, done: 0, result: { again: 0, hard: 0, good: 0 } };
  show('study');
  renderCard();
}

function renderCard() {
  const w = session.queue[session.idx];
  session.revealed = false;
  const dir = settings.dir;
  $('#card-cat').textContent = w.cat + (session.cram ? '・自由練習' : stateOf(w) ? '' : '・NEW');

  const ruBlock = (big) => `<div class="term-row"><div class="term">${ruHTML(w.ru)}</div>
      <button class="speak" data-say="ru" aria-label="読み上げ">🔊</button></div>`;
  const jaBlock = `<div class="term ja">${esc(w.ja)}</div>`;
  const extra = (w.ex_ru ? `<div class="example">
        <div class="ex-ru"><span>${ruHTML(w.ex_ru)}</span><button class="speak" data-say="ex" aria-label="例文を読み上げ">🔊</button></div>
        <div class="ex-ja">${esc(w.ex_ja)}</div></div>` : '')
    + (w.note ? `<div class="note">💡 ${ruHTML(w.note)}</div>` : '');

  $('#card-front').innerHTML = dir === 'ru2ja' ? ruBlock() : jaBlock;
  $('#card-back').innerHTML = (dir === 'ru2ja' ? jaBlock : ruBlock()) + extra;
  $('#card-back').hidden = true;
  $('#card-hint').hidden = false;
  $('#grades').hidden = true;

  const pct = (session.done / session.total) * 100;
  $('#progress-bar').style.width = Math.min(100, pct) + '%';
  $('#progress-text').textContent = `${session.done}/${session.total}`;

  if (dir === 'ru2ja' && settings.autoSpeak) speak(w.ru);
}

function reveal() {
  if (!session || session.revealed) return;
  session.revealed = true;
  const w = session.queue[session.idx];
  $('#card-back').hidden = false;
  $('#card-hint').hidden = true;
  const st = stateOf(w);
  $$('#grades button').forEach((b) => {
    b.querySelector('small').textContent = session.cram ? '' : ivlLabel(schedule(st, b.dataset.grade).ivl);
  });
  $('#grades').hidden = false;
  if (settings.dir === 'ja2ru' && settings.autoSpeak) speak(w.ru);
}

function grade(g) {
  if (!session || !session.revealed) return;
  const w = session.queue[session.idx];
  session.result[g]++;
  if (!session.cram) {
    const prev = stateOf(w);
    if (!prev) { ensureDaily(); daily.newCount[settings.dir] = (daily.newCount[settings.dir] || 0) + 1; saveDaily(); }
    progress[key(w)] = schedule(prev, g);
    saveProgress();
  }
  if (g === 'again') {
    // 少し後にもう一度出題
    const pos = Math.min(session.queue.length, session.idx + 4);
    session.queue.splice(pos, 0, w);
    session.total++;
  }
  session.done++;
  session.idx++;
  if (session.idx >= session.queue.length) finishSession();
  else renderCard();
}

function finishSession() {
  const r = session.result;
  $('#dn-good').textContent = r.good;
  $('#dn-hard').textContent = r.hard;
  $('#dn-again').textContent = r.again;
  session = null;
  show('done');
}

/* ========= 単語一覧 ========= */
function renderList() {
  const sel = $('#list-cat');
  if (!sel.options.length) {
    sel.innerHTML = '<option value="">すべて</option>' + categories.map((c) => `<option>${esc(c)}</option>`).join('');
  }
  const q = stripAccent($('#search').value.trim().toLowerCase());
  const cat = sel.value;
  const t = today();
  const list = words.filter((w) => (!cat || w.cat === cat) &&
    (!q || stripAccent(w.ru).toLowerCase().includes(q) || w.ja.toLowerCase().includes(q) ||
      stripAccent(w.ex_ru).toLowerCase().includes(q)));
  $('#list-count').textContent = `${list.length}語（${settings.dir === 'ru2ja' ? '露→日' : '日→露'}の学習状況）`;
  $('#word-list').innerHTML = list.map((w) => {
    const s = stateOf(w);
    const pill = !s ? '<span class="pill">未学習</span>'
      : s.due <= t ? '<span class="pill due">復習</span>'
      : `<span class="pill ok">${dayToDate(s.due)}</span>`;
    return `<li><div class="w"><div class="w-ru">${ruHTML(w.ru)}</div><div class="w-ja">${esc(w.ja)}</div></div>
      ${pill}<button class="speak" data-id="${esc(w.id)}" aria-label="読み上げ">🔊</button></li>`;
  }).join('');
}

/* ========= 音声合成 ========= */
function loadVoices() {
  if (!('speechSynthesis' in window)) return;
  ruVoices = speechSynthesis.getVoices().filter((v) => /^ru/i.test(v.lang));
  const sel = $('#set-voice');
  sel.innerHTML = '<option value="">自動</option>' +
    ruVoices.map((v) => `<option value="${esc(v.voiceURI)}">${esc(v.name)}</option>`).join('');
  sel.value = ruVoices.some((v) => v.voiceURI === settings.voiceURI) ? settings.voiceURI : '';
}
function speak(text) {
  if (!('speechSynthesis' in window)) { toast('このブラウザは音声読み上げに対応していません'); return; }
  const clean = stripAccent(text).replace(/[…«»]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return;
  const u = new SpeechSynthesisUtterance(clean);
  u.lang = 'ru-RU';
  u.rate = settings.rate;
  const v = ruVoices.find((x) => x.voiceURI === settings.voiceURI) || ruVoices[0];
  if (v) u.voice = v;
  if (speechSynthesis.speaking || speechSynthesis.pending) speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

/* ========= 設定 ========= */
function renderSettings() {
  $('#set-new').value = String(settings.newPerDay);
  $('#set-auto').checked = settings.autoSpeak;
  $('#set-rate').value = settings.rate;
  $('#rate-val').textContent = `×${Number(settings.rate).toFixed(1)}`;
  $('#app-info').textContent = `v${APP_VERSION}・単語数 ${words.length}`;
}

function exportData() {
  const data = { app: 'russian-flashcards', version: 1, exportedAt: new Date().toISOString(), progress, settings, daily };
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const a = document.createElement('a');
  const d = new Date();
  a.href = URL.createObjectURL(blob);
  a.download = `russian-flashcards-backup-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
function importData(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!data || typeof data.progress !== 'object') throw new Error('形式が違います');
      if (!confirm(`バックアップ（${data.exportedAt || '日時不明'}）で現在の記録を上書きしますか？`)) return;
      progress = data.progress;
      settings = { ...DEFAULTS, ...(data.settings || {}) };
      saveProgress(); saveSettings();
      renderSettings(); loadVoices();
      toast('復元しました');
    } catch (e) { toast('読み込めませんでした：' + e.message); }
  };
  reader.readAsText(file);
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

/* ========= イベント ========= */
function bindEvents() {
  $$('.tabbar button').forEach((b) => b.addEventListener('click', () => show(b.dataset.view)));

  $('.seg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-dir]');
    if (!b) return;
    settings.dir = b.dataset.dir; saveSettings(); renderHome();
  });

  $('#cats').addEventListener('click', (e) => {
    const b = e.target.closest('.chip');
    if (!b) return;
    const c = b.dataset.cat;
    if (!c) settings.cats = [];
    else if (settings.cats.includes(c)) settings.cats = settings.cats.filter((x) => x !== c);
    else settings.cats = [...settings.cats, c];
    if (settings.cats.length === categories.length) settings.cats = [];
    saveSettings(); renderHome();
  });

  $('#btn-start').addEventListener('click', () => startSession(false));
  $('#btn-cram').addEventListener('click', () => startSession(true));
  $('#btn-done').addEventListener('click', () => show('home'));
  $('#btn-quit').addEventListener('click', () => { session = null; if (window.speechSynthesis) speechSynthesis.cancel(); show('home'); });

  $('#card').addEventListener('click', (e) => {
    const sp = e.target.closest('.speak');
    if (sp) {
      e.stopPropagation();
      const w = session && session.queue[session.idx];
      if (w) speak(sp.dataset.say === 'ex' ? w.ex_ru : w.ru);
      return;
    }
    reveal();
  });
  $('#grades').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-grade]');
    if (b) grade(b.dataset.grade);
  });

  // PCでの確認用キーボード操作：Space=表示 1/2/3=評価
  document.addEventListener('keydown', (e) => {
    if (!session || e.target.matches('input, select, textarea')) return;
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); reveal(); }
    else if (session.revealed && ['1', '2', '3'].includes(e.key)) grade(['again', 'hard', 'good'][+e.key - 1]);
    else if (e.key === 's') speak(session.queue[session.idx].ru);
  });

  $('#search').addEventListener('input', renderList);
  $('#list-cat').addEventListener('change', renderList);
  $('#word-list').addEventListener('click', (e) => {
    const b = e.target.closest('.speak');
    if (!b) return;
    const w = words.find((x) => x.id === b.dataset.id);
    if (w) speak(w.ru);
  });

  $('#set-new').addEventListener('change', (e) => { settings.newPerDay = +e.target.value; saveSettings(); });
  $('#set-auto').addEventListener('change', (e) => { settings.autoSpeak = e.target.checked; saveSettings(); });
  $('#set-rate').addEventListener('input', (e) => {
    settings.rate = +e.target.value; saveSettings();
    $('#rate-val').textContent = `×${settings.rate.toFixed(1)}`;
  });
  $('#set-voice').addEventListener('change', (e) => { settings.voiceURI = e.target.value; saveSettings(); });
  $('#btn-test-voice').addEventListener('click', () => speak('Здравствуйте! Добро пожаловать в Узбекистан.'));
  $('#btn-export').addEventListener('click', exportData);
  $('#file-import').addEventListener('change', (e) => { if (e.target.files[0]) importData(e.target.files[0]); e.target.value = ''; });
  $('#btn-reset').addEventListener('click', () => {
    if (!confirm('学習記録をすべて消去します。元に戻せません。よろしいですか？')) return;
    progress = {}; daily = {}; saveProgress(); ensureDaily();
    toast('消去しました');
  });
}

/* ========= 起動 ========= */
async function init() {
  progress = load(KEYS.progress, {});
  settings = { ...DEFAULTS, ...load(KEYS.settings, {}) };
  daily = load(KEYS.daily, {});
  bindEvents();
  renderSettings();

  if ('speechSynthesis' in window) {
    loadVoices();
    speechSynthesis.addEventListener ? speechSynthesis.addEventListener('voiceschanged', loadVoices)
      : (speechSynthesis.onvoiceschanged = loadVoices);
  }

  try {
    await loadWords();
  } catch (e) {
    console.error(e);
    $('#home-msg').textContent = '単語データを読み込めませんでした。data/words.json の書式（カンマ・引用符）を確認してください。';
    $('#btn-start').disabled = true;
    return;
  }
  // 存在しないカテゴリの選択を解除
  settings.cats = settings.cats.filter((c) => categories.includes(c));
  renderSettings();
  renderHome();

  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW登録失敗', e));
  }
}

document.addEventListener('DOMContentLoaded', init);
