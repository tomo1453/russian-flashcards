#!/usr/bin/env python3
"""data/words.json の各単語の音声ファイル audio/<id>.mp3 を作るスクリプト。

必要なもの（Ubuntu の場合）:
    sudo apt-get install rhvoice rhvoice-russian ffmpeg
    echo "stress_marker=+" | sudo tee -a /etc/RHVoice/RHVoice.conf
    （この設定がないと「+」が強勢記号として扱われず、アクセントが反映されません）
使い方:
    python3 tools/make_audio.py          # まだ音声がない単語だけ作る
    python3 tools/make_audio.py --all    # 全部作り直す
"""
import json, os, re, subprocess, sys, tempfile, unicodedata

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


def check_config():
    conf = "/etc/RHVoice/RHVoice.conf"
    try:
        lines = [l.strip() for l in open(conf, encoding="utf-8")]
    except OSError:
        lines = []
    if "stress_marker=+" not in lines:
        sys.exit(f"{conf} に stress_marker=+ を追加してください（アクセントを反映するため）")


def main():
    check_config()
    redo = "--all" in sys.argv
    words = json.load(open(os.path.join(ROOT, "data", "words.json"), encoding="utf-8"))
    os.makedirs(os.path.join(ROOT, "audio"), exist_ok=True)
    made = 0
    for w in words:
        wid = w.get("id") or w["ru"].replace("\u0301", "").replace("+", "")
        out = os.path.join(ROOT, "audio", f"{wid}.mp3")
        if os.path.exists(out) and not redo:
            continue
        with tempfile.NamedTemporaryFile(suffix=".wav") as wav:
            subprocess.run(["RHVoice-test", "-p", VOICE, "-r", RATE, "-o", wav.name],
                           input=to_rhvoice(w["ru"]).encode(), check=True, capture_output=True)
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", wav.name,
                            "-af", "silenceremove=start_periods=1:start_threshold=-50dB,areverse,"
                                   "silenceremove=start_periods=1:start_threshold=-50dB,areverse,"
                                   "apad=pad_dur=0.15,loudnorm=I=-16",
                            "-ac", "1", "-ar", "24000", "-codec:a", "libmp3lame", "-b:a", "48k", out],
                           check=True)
        made += 1
        print("made", out)
    print(f"{made} files created")


if __name__ == "__main__":
    main()
