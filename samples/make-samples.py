#!/usr/bin/env python3
"""用 macOS 自带 TTS 把 scripts.json 合成三场示例会议(双轨:麦克风=老周,系统声音=小林)。
用法: python3 samples/make-samples.py  → 输出到 samples/meetings/<id>/{mic,system,audio}.m4a + meta.json
"""
import json, os, subprocess, sys, tempfile, shutil
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE / "meetings"
cfg = json.loads((HERE / "scripts.json").read_text(encoding="utf-8"))
GAP = 0.7      # 两句之间的停顿
LEAD = 0.8     # 开头留白

def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(f"命令失败: {' '.join(cmd)}\n{r.stderr[-800:]}")
    return r.stdout

def duration(p):
    return float(run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(p)]).strip())

def mix_track(items, total, out):
    """items: [(file, start_sec)] → 按时间叠在静音上,输出 m4a"""
    if not items:
        run(["ffmpeg", "-y", "-f", "lavfi", "-i", "anullsrc=r=22050:cl=mono", "-t", f"{total:.2f}", "-c:a", "aac", "-b:a", "64k", str(out)])
        return
    cmd = ["ffmpeg", "-y", "-f", "lavfi", "-i", f"anullsrc=r=22050:cl=mono", "-t", f"{total:.2f}"]
    for f, _ in items:
        cmd += ["-i", str(f)]
    parts = ["[0:a]atrim=0:%.2f[base]" % total]
    names = ["[base]"]
    for i, (_, start) in enumerate(items, 1):
        parts.append(f"[{i}:a]aresample=22050,aformat=channel_layouts=mono,adelay={int(start*1000)}|{int(start*1000)}[s{i}]")
        names.append(f"[s{i}]")
    parts.append("".join(names) + f"amix=inputs={len(names)}:normalize=0:duration=first[out]")
    cmd += ["-filter_complex", ";".join(parts), "-map", "[out]", "-c:a", "aac", "-b:a", "64k", str(out)]
    run(cmd)

for m in cfg["meetings"]:
    d = OUT / m["id"]
    if d.exists(): shutil.rmtree(d)
    d.mkdir(parents=True)
    tmp = Path(tempfile.mkdtemp())
    t = LEAD
    tracks = {"mic": [], "system": []}
    for i, (who, text) in enumerate(m["lines"]):
        f = tmp / f"{i:02d}.aiff"
        run(["say", "-v", cfg["voices"][who], "-r", "190", "-o", str(f), text])
        dur = duration(f)
        tracks[who].append((f, t))
        t += dur + GAP
    total = t + 0.5
    mix_track(tracks["mic"], total, d / "mic.m4a")
    mix_track(tracks["system"], total, d / "system.m4a")
    run(["ffmpeg", "-y", "-i", str(d / "mic.m4a"), "-i", str(d / "system.m4a"), "-filter_complex", "[0:a][1:a]amix=inputs=2:normalize=0[out]", "-map", "[out]", "-c:a", "aac", "-b:a", "64k", str(d / "audio.m4a")])
    meta = {
        "id": m["id"], "title": m["title"], "createdAt": m["createdAt"],
        "durationSec": round(total), "audioFile": "audio.m4a", "status": "recorded", "mode": "audio",
        "tracks": {"mic": "mic.m4a", "system": "system.m4a"},
        "speakerNames": {"mic": cfg["speakers"]["mic"], "system": cfg["speakers"]["system"]},
    }
    (d / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    shutil.rmtree(tmp)
    print(f"{m['id']} {m['title']} {total:.0f} 秒 {len(m['lines'])} 句")
print("done")
