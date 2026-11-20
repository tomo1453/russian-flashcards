#!/usr/bin/env python3
"""data/words.json の各単語の音声ファイル audio/<id>.mp3 を作るスクリプト。

必要なもの（Ubuntu の場合）:
    sudo apt-get install rhvoice rhvoice-russian ffmpeg
    echo "stress_marker=+" | sudo tee -a /etc/RHVoice/RHVoice.conf
    （この設定がないと「+」が強勢記号として扱われず、アクセントが反映されません）
    pip install numpy
読み方の決め方:
    単語ごとに「RHVoice の辞書の強勢」と「データの強勢」を音で比べ、
    - 一致する語は記号を外して辞書の読みを使う（сегодня→сево́дня、конечно→коне́шно などの特殊な発音が生きる）
    - 一致しない語（плачу́ / пла́чу のような同綴り語など）だけデータの強勢記号で読ませる
使い方:
    python3 tools/make_audio.py          # まだ音声がない単語・例文だけ作る
    python3 tools/make_audio.py --all    # 全部作り直す
出力:
    audio/<id>.mp3     単語
    audio/ex/<id>.mp3  例文
"""
import io, json, os, re, subprocess, sys, tempfile, unicodedata, wave
import numpy as np

VOICE = "aleksandr-hq"
RATE = "90"  # 話す速さ（%）
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VOWELS = "аеёиоуыэюяАЕЁИОУЫЭЮЯ"


def to_rhvoice(text):
    """アクセント記号（母音の後ろの U+0301 や +）を RHVoice の「+母音」形式に変換"""
    text = unicodedata.normalize("NFC", text)
    text = re.sub(r"([%s])\+" % VOWELS, "\\1\u0301", text)
    text = re.sub(r"([%s])\u0301" % VOWELS, r"+\1", text)
    return text.replace("…", " ").strip()


def synth_wav(text):
    r = subprocess.run(["RHVoice-test", "-p", VOICE, "-r", RATE, "-o", "/dev/stdout"],
                       input=text.encode(), check=True, capture_output=True)
    return r.stdout


def _feats(wav_bytes):
    """ログメルスペクトル（無音除去・平均除去済み）"""
    w = wave.open(io.BytesIO(wav_bytes))
    sr = w.getframerate()
    x = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(float)
    n, hop = int(sr * 0.025), int(sr * 0.010)
    frames = np.lib.stride_tricks.sliding_window_view(x, n)[::hop] * np.hanning(n)
    spec = np.abs(np.fft.rfft(frames, 512)) ** 2
    mel = 2595 * np.log10(1 + np.linspace(0, sr / 2, spec.shape[1]) / 700)
    edges = np.linspace(mel[1], mel[-1], 42)
    fb = np.array([np.clip(np.minimum((mel - edges[i]) / (edges[i + 1] - edges[i]),
                                      (edges[i + 2] - mel) / (edges[i + 2] - edges[i + 1])), 0, None)
                   for i in range(40)])
    m = np.log(spec @ fb.T + 1e-6)
    m = m[m.mean(1) > m.mean(1).max() - 8]
    return m - m.mean(0)


def _dtw(a, b):
    d = np.sqrt(((a[:, None, :] - b[None, :, :]) ** 2).sum(-1))
    D = np.full((len(a) + 1, len(b) + 1), np.inf)
    D[0, 0] = 0
    for i in range(1, len(a) + 1):
        for j in range(1, len(b) + 1):
            D[i, j] = d[i - 1, j - 1] + min(D[i - 1, j], D[i, j - 1], D[i - 1, j - 1])
    return D[-1, -1] / (len(a) + len(b))


_cache = {}
def dictionary_agrees(token):
    """token（「+母音」形式）の強勢が RHVoice の辞書の強勢と同じか"""
    if token in _cache:
        return _cache[token]
    plain = token.replace("+", "")
    base_wav = synth_wav(plain)
    if synth_wav(token) == base_wav:
        _cache[token] = True
        return True
    base = _feats(base_wav)
    idx = [i for i, c in enumerate(plain) if c in VOWELS]
    scores = {plain[:i] + "+" + plain[i:]: _dtw(base, _feats(synth_wav(plain[:i] + "+" + plain[i:])))
              for i in idx}
    _cache[token] = min(scores, key=scores.get) == token
    return _cache[token]


def reading(text):
    """音声合成に渡す文字列：辞書と強勢が一致する語は記号を外す"""
    def fix(m):
        tok = m.group(0)
        if "+" not in tok:
            return tok
        return tok.replace("+", "") if dictionary_agrees(tok) else tok
    return re.sub(r"[\w+]+", fix, to_rhvoice(text))


def check_config():
    conf = "/etc/RHVoice/RHVoice.conf"
    try:
        lines = [l.strip() for l in open(conf, encoding="utf-8")]
    except OSError:
        lines = []
    if "stress_marker=+" not in lines:
        sys.exit(f"{conf} に stress_marker=+ を追加してください（アクセントを反映するため）")


def make_mp3(text, out):
    with tempfile.NamedTemporaryFile(suffix=".wav") as wav:
        subprocess.run(["RHVoice-test", "-p", VOICE, "-r", RATE, "-o", wav.name],
                       input=reading(text).encode(), check=True, capture_output=True)
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", wav.name,
                        "-af", "silenceremove=start_periods=1:start_threshold=-50dB,areverse,"
                               "silenceremove=start_periods=1:start_threshold=-50dB,areverse,"
                               "apad=pad_dur=0.15,loudnorm=I=-16",
                        "-ac", "1", "-ar", "24000", "-codec:a", "libmp3lame", "-b:a", "48k", out],
                       check=True)


def main():
    """単語 → audio/<id>.mp3、例文 → audio/ex/<id>.mp3"""
    check_config()
    redo = "--all" in sys.argv
    words = json.load(open(os.path.join(ROOT, "data", "words.json"), encoding="utf-8"))
    os.makedirs(os.path.join(ROOT, "audio", "ex"), exist_ok=True)
    made = 0
    for w in words:
        wid = w.get("id") or w["ru"].replace("\u0301", "").replace("+", "")
        jobs = [(w["ru"], os.path.join(ROOT, "audio", f"{wid}.mp3"))]
        if w.get("ex_ru"):
            jobs.append((w["ex_ru"], os.path.join(ROOT, "audio", "ex", f"{wid}.mp3")))
        for text, out in jobs:
            if os.path.exists(out) and not redo:
                continue
            make_mp3(text, out)
            made += 1
            print("made", os.path.relpath(out, ROOT), reading(text))
    print(f"{made} files created")


if __name__ == "__main__":
    main()
