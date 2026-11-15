"""Bounded local analysis and FFmpeg rendering for authorized media.

Transcription is performed by the managed AI integration. Face framing is sampled,
not identity recognition or frame-by-frame tracking. No copyright/compliance
determination is made here.
"""
import json
import math
import os
import subprocess
import sys
import wave
import re
import textwrap
from pathlib import Path


def run(args):
    return subprocess.run(args, check=True, capture_output=True, text=True)


def probe(path):
    return json.loads(run(["ffprobe", "-v", "error", "-show_format", "-show_streams", "-of", "json", path]).stdout)


def validate_source_duration(duration):
    if not math.isfinite(duration) or duration < 30 or duration > 3600:
        raise ValueError("Source duration must be between 30 seconds and 60 minutes")


def analyze(source, output):
    import cv2
    import numpy as np

    info = probe(source)
    duration = float(info["format"]["duration"])
    validate_source_duration(duration)
    if not any(stream["codec_type"] == "audio" for stream in info["streams"]):
        raise ValueError("Source video must contain an audio track")
    audio = str(Path(output).with_suffix(".wav"))
    run(["ffmpeg", "-v", "error", "-y", "-i", source, "-vn", "-ac", "1", "-ar", "16000", audio])
    with wave.open(audio) as wav:
        samples = np.frombuffer(wav.readframes(wav.getnframes()), dtype=np.int16).astype(np.float32)
    seconds = len(samples) // 16000
    energy = np.array([float(np.sqrt(np.mean(samples[i * 16000:(i + 1) * 16000] ** 2))) for i in range(seconds)])
    window = min(45, seconds)
    ranked = sorted(
        [{"start": i, "end": min(duration, i + window), "energy": float(np.mean(energy[i:i + window]))}
         for i in range(max(1, seconds - window + 1))],
        key=lambda item: item["energy"], reverse=True,
    )
    candidates = []
    for item in ranked:
        if all(abs(item["start"] - other["start"]) >= 15 for other in candidates):
            candidates.append(item)
        if len(candidates) == 12:
            break
    chunks = []
    for start in range(0, math.ceil(duration), 120):
        end = min(duration, start + 120)
        path = str(Path(output).parent / f"transcribe-{start}.mp3")
        run(["ffmpeg", "-v", "error", "-y", "-ss", str(start), "-t", str(end - start), "-i", audio,
             "-ac", "1", "-ar", "16000", "-b:a", "48k", path])
        chunks.append({"path": path, "start": start, "end": end})
    face = None
    cascade_dir = getattr(getattr(cv2, "data", None), "haarcascades", "")
    cascade_file = os.path.join(cascade_dir, "haarcascade_frontalface_default.xml")
    if os.path.exists(cascade_file):
        classifier = cv2.CascadeClassifier(cascade_file)
        cap = cv2.VideoCapture(source)
        for at in [duration * .1, duration * .4, duration * .7]:
            cap.set(cv2.CAP_PROP_POS_MSEC, at * 1000)
            ok, frame = cap.read()
            if not ok:
                continue
            h, w = frame.shape[:2]
            ratio = min(1.0, 960 / w)
            small = cv2.resize(frame, (int(w * ratio), int(h * ratio)))
            faces = classifier.detectMultiScale(cv2.cvtColor(small, cv2.COLOR_BGR2GRAY), 1.1, 5)
            if len(faces):
                x, y, fw, fh = max(faces, key=lambda f: f[2] * f[3])
                face = [float((x + fw / 2) / (w * ratio)), float((y + fh / 2) / (h * ratio)), float(max(fw, fh) * 2 / (min(w, h) * ratio))]
                break
        cap.release()
    Path(output).write_text(json.dumps({"duration": duration, "chunks": chunks, "candidates": candidates, "face": face}))


def ass_text(text):
    return str(text).replace("\\", "").replace("{", "").replace("}", "").replace("\n", r"\N")[:300]


def ass_time(seconds):
    seconds = max(0, seconds)
    return f"{int(seconds // 3600)}:{int(seconds % 3600 // 60):02d}:{seconds % 60:05.2f}"


def speech_intervals(audio, work):
    """Measure speech/silence from actual synthesized audio, in 25 ms frames."""
    import numpy as np
    decoded = str(work / f"{Path(audio).stem}-envelope.wav")
    run(["ffmpeg", "-v", "error", "-y", "-i", audio, "-ac", "1", "-ar", "16000", decoded])
    with wave.open(decoded) as wav:
        samples = np.frombuffer(wav.readframes(wav.getnframes()), dtype=np.int16).astype(np.float32)
    frame = 400
    energy = [float(np.sqrt(np.mean(samples[i:i + frame] ** 2))) for i in range(0, len(samples), frame) if len(samples[i:i + frame])]
    threshold = max(60, max(energy, default=0) * .035)
    intervals = []
    for i, value in enumerate(energy):
        if value < threshold:
            continue
        start, end = max(0, i * .025 - .05), (i + 1) * .025 + .1
        if intervals and start - intervals[-1][1] < .16:
            intervals[-1][1] = end
        else:
            intervals.append([start, end])
    return intervals


def timed_words(script, intervals, duration):
    """Speech-envelope aligned word timing, estimated rather than ASR forced alignment."""
    words = script.split()
    spans = [[max(0, s), min(e, duration)] for s, e in intervals if s < duration]
    if not spans or not words:
        raise ValueError("Voiceover did not contain audible speech")
    weights = [max(1, len(re.sub(r"[^\w]", "", word))) + (2 if word.endswith((".", ",", "!", "?")) else 0) for word in words]
    total_weight = sum(weights)
    total_time = sum(e - s for s, e in spans)

    def at(active):
        for start, end in spans:
            if active <= end - start:
                return min(end, start + active)
            active -= end - start
        return spans[-1][1]

    elapsed = 0
    result = []
    for word, weight in zip(words, weights):
        start = at(elapsed / total_weight * total_time)
        elapsed += weight
        end = at(elapsed / total_weight * total_time)
        result.append({"text": word, "start": start, "end": max(start + .025, end)})
    return result


def srt_time(seconds):
    millis = round(max(0, seconds) * 1000)
    return f"{millis // 3600000:02d}:{millis // 60000 % 60:02d}:{millis // 1000 % 60:02d},{millis % 1000:03d}"

def source_ducking(intervals):
    speaking = "+".join(f"between(t,{s:.3f},{e:.3f})" for s, e in intervals) or "0"
    return f"volume='if(gt({speaking},0),0.25,1)':eval=frame"


def captions_file(path, hook, words, duration, chapters):
    header = """[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Hook,DejaVu Sans,64,&H00FFFFFF,&H000000FF,&H00101010,&H80000000,-1,0,0,0,100,100,0,0,1,4,1,8,70,70,140,1
Style: Caption,DejaVu Sans,52,&H00FFFFFF,&H000000FF,&H00101010,&H80000000,-1,0,0,0,100,100,0,0,1,4,1,2,80,80,300,1
Style: Chapter,DejaVu Sans,42,&H0056D9A8,&H000000FF,&H00101010,&H80000000,-1,0,0,0,100,100,0,0,1,3,1,8,70,70,340,1
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    events = [f"Dialogue: 0,0:00:00.00,{ass_time(min(duration, 3))},Hook,,0,0,0,,{{\\fad(120,200)}}{ass_text(hook)}"]
    for word in words:
        effect = r"{\fad(20,40)\fscx90\fscy90\t(0,70,\fscx100\fscy100)}"
        events.append(f"Dialogue: 0,{ass_time(word['start'])},{ass_time(word['end'])},Caption,,0,0,0,,{effect}{ass_text(word['text'])}")
    for start, title in chapters:
        events.append(f"Dialogue: 1,{ass_time(start)},{ass_time(start + 2.5)},Chapter,,0,0,0,,{{\\fad(150,200)}}{ass_text(title)}")
    Path(path).write_text(header + "\n".join(events) + "\n")


def render(config_path):
    config = json.loads(Path(config_path).read_text())
    work = Path(config_path).parent
    parts = []
    chapters = []
    elapsed = 0
    source_info = probe(config["source"])
    stream = next(s for s in source_info["streams"] if s["codec_type"] == "video")
    width, height = int(stream["width"]), int(stream["height"])
    for index, segment in enumerate(config["segments"]):
        length = min(45, max(1, segment["end"] - segment["start"]))
        output = str(work / f"{Path(config_path).stem}-part-{index}.mp4")
        inputs = ["ffmpeg", "-v", "error", "-y", "-ss", str(segment["start"]), "-t", str(length), "-i", config["source"]]
        face = config.get("face")
        base = "[0:v]scale=1116:1984:force_original_aspect_ratio=increase,crop=1080:1920:x='(iw-ow)/2+8*sin(t/3)':y='(ih-oh)/2',setsar=1,fps=60,eq=contrast=1.035:saturation=1.06[base]"
        if face and config["mode"] == "commentary":
            crop = max(2, int(min(width, height) * min(face[2], .5)) // 2 * 2)
            x = max(0, min(width - crop, int(face[0] * width - crop / 2))) // 2 * 2
            y = max(0, min(height - crop, int(face[1] * height - crop / 2))) // 2 * 2
            filters = f"[0:v]split=2[game][cam];[game]scale=1116:1984:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=60[base];[cam]crop={crop}:{crop}:{x}:{y},scale=340:340,setsar=1[face];[base][face]overlay=x='700+6*sin(t)':y=400[v]"
        else:
            filters = base + ";[base]null[v]"
        run(inputs + ["-filter_complex", filters, "-map", "[v]", "-map", "0:a:0", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-threads", "2", "-c:a", "aac", "-ar", "48000", "-ac", "2", "-pix_fmt", "yuv420p", output])
        parts.append(output)
        chapters.append((elapsed, f"{index + 1:02d} / {segment['title']}"))
        elapsed += length
    concat = work / f"{Path(config_path).stem}-concat.txt"
    concat.write_text("\n".join(f"file '{p}'" for p in parts))
    combined = str(work / f"{Path(config_path).stem}-combined.mp4")
    run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(concat), "-c", "copy", combined])
    narration_duration = float(probe(config["voiceFile"])["format"]["duration"])
    if narration_duration > elapsed:
        # Keep every spoken word in the bounded clip rather than silently truncating.
        factor = narration_duration / max(1, elapsed - .25)
        if factor > 1.5:
            raise ValueError("Voiceover is too long for this clip; retry with a shorter commentary")
        faster = str(work / f"{Path(config_path).stem}-voice-fit.mp3")
        run(["ffmpeg", "-v", "error", "-y", "-i", config["voiceFile"], "-af", f"atempo={factor:.5f}", "-b:a", "128k", faster])
        os.replace(faster, config["voiceFile"])
        narration_duration = float(probe(config["voiceFile"])["format"]["duration"])
    intervals = speech_intervals(config["voiceFile"], work)
    words = timed_words(config["script"], intervals, min(elapsed, narration_duration))
    if config.get("captionsOutput"):
        Path(config["captionsOutput"]).write_text("\n\n".join(
            f"{i + 1}\n{srt_time(w['start'])} --> {srt_time(w['end'])}\n{w['text']}" for i, w in enumerate(words)
        ) + "\n")
    ass = str(work / f"{Path(config_path).stem}.ass")
    captions_file(ass, config["hook"], words, elapsed, chapters if config["mode"] == "story" else [])
    inputs = ["ffmpeg", "-v", "error", "-y", "-i", combined, "-i", config["voiceFile"]]
    filters = [
        f"[0:a]{source_ducking(intervals)}[src]",
        "[1:a]apad[voice]",
        "[src][voice]amix=inputs=2:duration=first:normalize=0[mix]",
        f"[0:v]drawbox=x=40:y=110:w=1000:h=300:color=black@0.72:t=fill:enable='lt(t,3)',ass={ass}[sub]",
    ]
    audio_label = "mix"
    video_label = "sub"
    next_input = 2
    if config.get("sponsorAudio"):
        inputs += ["-stream_loop", "-1", "-i", config["sponsorAudio"]]
        filters += [f"[{next_input}:a]volume=0.15[sponsor]", "[mix][sponsor]amix=inputs=2:duration=first:normalize=0[sponsored]"]
        audio_label = "sponsored"
        next_input += 1
    if config.get("watermark"):
        inputs += ["-i", config["watermark"]]
        filters += [f"[{next_input}:v]scale=180:-1[mark]", "[sub][mark]overlay=60:600[marked]"]
        video_label = "marked"
    rendered = str(work / f"{Path(config_path).stem}-rendered.mp4")
    run(inputs + ["-filter_complex", ";".join(filters), "-map", f"[{video_label}]", "-map", f"[{audio_label}]", "-t", str(elapsed),
                  "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-threads", "2", "-c:a", "aac", "-ar", "48000", "-ac", "2", "-pix_fmt", "yuv420p", "-movflags", "+faststart", rendered])
    if config["mode"] == "bounty":
        cta = str(work / f"{Path(config_path).stem}-cta.txt")
        Path(cta).write_text(textwrap.fill(config.get("cta", "Follow for more")[:100], width=32))
        card = str(work / f"{Path(config_path).stem}-card.mp4")
        run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=0x09090B:s=1080x1920:r=60:d=3", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
             "-vf", f"drawtext=textfile={cta}:fontsize=44:fontcolor=white:x=(w-tw)/2:y=(h-th)/2",
             "-t", "3", "-c:v", "libx264", "-preset", "ultrafast", "-threads", "2", "-pix_fmt", "yuv420p", "-c:a", "aac", card])
        final_concat = work / f"{Path(config_path).stem}-final.txt"
        final_concat.write_text(f"file '{rendered}'\nfile '{card}'\n")
        run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(final_concat), "-c", "copy", "-movflags", "+faststart", config["output"]])
    else:
        os.replace(rendered, config["output"])
    run(["ffmpeg", "-v", "error", "-y", "-ss", "1", "-i", config["output"], "-frames:v", "1", "-vf", "scale=360:640", config["poster"]])


if __name__ == "__main__":
    try:
        if sys.argv[1] == "analyze":
            analyze(sys.argv[2], sys.argv[3])
        elif sys.argv[1] == "render":
            render(sys.argv[2])
        else:
            raise ValueError("Unknown worker operation")
    except subprocess.CalledProcessError as error:
        print((error.stderr or "")[-3000:], file=sys.stderr)
        raise
