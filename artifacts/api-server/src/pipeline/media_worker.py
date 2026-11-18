"""Bounded local analysis and FFmpeg rendering for authorized media.

Transcription is performed by the managed AI integration. Face positions are tracked
temporally at 2 Hz with bounded smoothing, not identity recognition. No copyright/compliance
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
sys.path.insert(0, str(Path(__file__).resolve().parent))
from reframe import sample_people, plan_scenes, reframe_filter, retention_zoom


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
    ticks = round(max(0, seconds) * 100)
    return f"{ticks // 360000}:{ticks // 6000 % 60:02d}:{ticks // 100 % 60:02d}.{ticks % 100:02d}"


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
Style: Caption,DejaVu Sans,64,&H00FFFFFF,&H0000E6FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,4,2,5,90,90,0,1
Style: Chapter,DejaVu Sans,42,&H0056D9A8,&H000000FF,&H00101010,&H80000000,-1,0,0,0,100,100,0,0,1,3,1,8,70,70,340,1
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    events = [f"Dialogue: 0,0:00:00.00,{ass_time(min(duration, 3))},Hook,,0,0,0,,{{\\fad(120,200)}}{ass_text(hook)}"]
    groups = {}
    cursor = 0
    while cursor < len(words):
        count = 3 if len(words) - cursor == 5 else min(4, len(words) - cursor)
        for i in range(cursor, cursor + count):
            groups[i] = (cursor, cursor + count)
        cursor += count
    for index, word in enumerate(words):
        group_start, group_end = groups[index]
        phrase = []
        for j in range(group_start, group_end):
            color = r"{\c&H0000E6FF&\fscx110\fscy110\t(0,90,\fscx100\fscy100)}" if j == index else r"{\c&H00FFFFFF&\fscx100\fscy100}"
            phrase.append(color + ass_text(words[j]["text"].upper()))
        effect = r"{\an5\pos(540,1180)\blur0.3\xshad2\yshad3}"
        events.append(f"Dialogue: 0,{ass_time(word['start'])},{ass_time(word['end'])},Caption,,0,0,0,,{effect}{' '.join(phrase)}")
    for start, title in chapters:
        events.append(f"Dialogue: 1,{ass_time(start)},{ass_time(start + 2.5)},Chapter,,0,0,0,,{{\\fad(150,200)}}{ass_text(title)}")
    Path(path).write_text(header + "\n".join(events) + "\n")

def track_faces(source, start, length):
    """Detect at 2Hz, smooth movement and reset after >1s gaps. Never infer gameplay from a single face."""
    import cv2
    cascade_dir = getattr(getattr(cv2, "data", None), "haarcascades", "")
    cascade_file = os.path.join(cascade_dir, "haarcascade_frontalface_default.xml")
    if not os.path.exists(cascade_file):
        return [], False
    classifier = cv2.CascadeClassifier(cascade_file)
    cap = cv2.VideoCapture(source)
    points, corner_hits, detections = [], 0, 0
    previous = None
    try:
        for n in range(math.ceil(length * 2)):
            at = n / 2
            cap.set(cv2.CAP_PROP_POS_MSEC, (start + at) * 1000)
            ok, frame = cap.read()
            if not ok:
                continue
            h, w = frame.shape[:2]
            ratio = min(1., 640 / w)
            small = cv2.resize(frame, (int(w * ratio), int(h * ratio)))
            faces = classifier.detectMultiScale(cv2.cvtColor(small, cv2.COLOR_BGR2GRAY), 1.1, 5)
            if len(faces):
                # Prefer spatially continuous detections to avoid switching among people.
                if previous:
                    face = min(faces, key=lambda f: abs((f[0] + f[2] / 2) / (w * ratio) - previous[0]))
                else:
                    face = max(faces, key=lambda f: f[2] * f[3])
                x, y, fw, fh = face
                current = [(x + fw / 2) / (w * ratio), (y + fh / 2) / (h * ratio),
                           max(fw / (w * ratio), fh / (h * ratio))]
                detections += 1
                # Consistent small face in a corner supports a webcam + content layout.
                corner_hits += int(current[2] < .23 and (current[0] < .25 or current[0] > .75)
                                   and (current[1] < .35 or current[1] > .65) and w / h > 1.5)
                if previous:
                    current = [previous[i] * .45 + current[i] * .55 for i in range(3)]
                previous = current
                points.append({"t": at, "x": current[0], "y": current[1], "size": current[2]})
            else:
                # Bounded center fallback during missing/occluded detections.
                previous = None
                points.append({"t": at, "x": .5, "y": .5, "size": .3})
    finally:
        cap.release()
    coverage = detections / max(1, math.ceil(length * 2))
    if coverage < .25:
        return [], False
    return points, coverage >= .65 and corner_hits / max(1, detections) >= .8

def tracking_expression(points, field, pixels, extent):
    """Piecewise-linear motion; clamp every crop to the source bounds."""
    values = [(p["t"], max(0, min(pixels - extent, p[field] * pixels - extent / 2))) for p in points]
    if not values:
        return "(iw-ow)/2" if field == "x" else "(ih-oh)/2"
    expr = f"{values[-1][1]:.2f}"
    for (t0, a), (t1, b) in reversed(list(zip(values, values[1:]))):
        expr = f"if(lt(t,{t1:.3f}),{a:.2f}+({b-a:.2f})*(t-{t0:.3f})/{max(.001,t1-t0):.3f},{expr})"
    return expr


def retained_words(path, duration):
    """Reuse exact word timing from the fitted narration's persisted SRT."""
    words = []
    stamp = r"(\d+):(\d+):(\d+),(\d+)"
    for block in Path(path).read_text().strip().split("\n\n"):
        lines = block.strip().splitlines()
        if len(lines) < 3:
            raise ValueError("Retained captions are invalid")
        match = re.fullmatch(stamp + r" --> " + stamp, lines[1])
        if not match:
            raise ValueError("Retained caption timing is invalid")
        parts = list(map(int, match.groups()))
        def seconds(p):
            return p[0] * 3600 + p[1] * 60 + p[2] + p[3] / 1000
        start, end = seconds(parts[:4]), seconds(parts[4:])
        if not 0 <= start < end <= duration + .05:
            raise ValueError("Retained captions do not fit this video")
        words.append({"start": start, "end": end, "text": " ".join(lines[2:])})
    return words


def render(config_path):
    config = json.loads(Path(config_path).read_text())
    if config.get("requireWordTiming") and not config.get("captionsInput"):
        raise ValueError("Word-timed captions are required; refusing estimated caption timing")
    work = Path(config_path).parent
    parts = []
    chapters = []
    elapsed = 0
    source_info = probe(config["source"])
    stream = next(s for s in source_info["streams"] if s["codec_type"] == "video")
    width, height = int(stream["width"]), int(stream["height"])
    for index, segment in enumerate(config["segments"]):
        length = min(45, segment["end"] - segment["start"])
        if length <= 0:
            raise ValueError("Invalid source edit interval")
        output = str(work / f"{Path(config_path).stem}-part-{index}.mp4")
        inputs = ["ffmpeg", "-v", "error", "-y", "-ss", str(segment["start"]), "-t", str(length), "-i", config["source"]]
        observations = sample_people(config["source"], segment["start"], length) if config.get("pictureInPicture", True) else []
        scenes = plan_scenes(observations, length, width, height)
        filters = reframe_filter(scenes, width, height)
        run(inputs + ["-filter_complex_threads", "1", "-filter_complex", filters, "-map", "[v]", "-map", "0:a:0", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-threads", "2", "-c:a", "aac", "-ar", "48000", "-ac", "2", "-pix_fmt", "yuv420p", output])
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
    words = retained_words(config["captionsInput"], elapsed) if config.get("captionsInput") else timed_words(config["script"], intervals, min(elapsed, narration_duration))
    if config.get("captionsOutput"):
        Path(config["captionsOutput"]).write_text("\n\n".join(
            f"{i + 1}\n{srt_time(w['start'])} --> {srt_time(w['end'])}\n{w['text']}" for i, w in enumerate(words)
        ) + "\n")
    ass = str(work / f"{Path(config_path).stem}.ass")
    captions_file(ass, config["hook"], words if config.get("captions", True) else [], elapsed, chapters if config["mode"] == "story" else [])
    inputs = ["ffmpeg", "-v", "error", "-y", "-i", combined, "-i", config["voiceFile"]]
    filters = [
        f"[0:a]{source_ducking(intervals)}[src]",
        "[1:a]apad[voice]",
        "[src][voice]amix=inputs=2:duration=first:normalize=0[mix]",
        f"[0:v]{retention_zoom()}[polished]",
        (f"[polished]drawbox=x=40:y=110:w=1000:h=300:color=black@0.72:t=fill:enable='lt(t,3)',ass={ass}[sub]"
         if config["hook"] else f"[polished]ass={ass}[sub]"),
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
    filters.append(f"[{audio_label}]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[normalized]")
    audio_label = "normalized"
    rendered = str(work / f"{Path(config_path).stem}-rendered.mp4")
    run(inputs + ["-filter_complex_threads", "1", "-filter_complex", ";".join(filters), "-map", f"[{video_label}]", "-map", f"[{audio_label}]", "-t", str(elapsed),
                  "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-threads", "2", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", "-pix_fmt", "yuv420p", "-movflags", "+faststart", rendered])
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
