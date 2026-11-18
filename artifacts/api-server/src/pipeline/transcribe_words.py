"""Bounded CPU fallback. Models are downloaded only when this fallback is actually requested."""
import json
import os
import sys
from pathlib import Path


def transcribe(source):
    from faster_whisper import WhisperModel
    root = Path(__file__).resolve().parents[4]
    model = WhisperModel("base", device="cpu", compute_type="int8", cpu_threads=2, num_workers=1,
                         download_root=str(root / "generated-artifacts" / "whisper-models"))
    segments, _ = model.transcribe(source, word_timestamps=True, vad_filter=True, beam_size=3)
    words, text = [], []
    for segment in segments:
        text.append(segment.text.strip())
        for word in segment.words or []:
            words.append({"word": word.word.strip(), "start": word.start, "end": word.end})
    return {"text": " ".join(text), "words": words}


if __name__ == "__main__":
    try:
        print(json.dumps(transcribe(sys.argv[1])))
    except Exception:
        # Library exceptions may contain local paths or model-hub credentials. Never echo them.
        print("CPU word transcription failed; verify the local model can be loaded and the audio contains speech.", file=sys.stderr)
        sys.exit(1)
