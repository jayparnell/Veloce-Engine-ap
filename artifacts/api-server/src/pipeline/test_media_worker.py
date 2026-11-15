import importlib.util
import math
import tempfile
import unittest
import wave
from pathlib import Path
import numpy as np

spec = importlib.util.spec_from_file_location("media_worker", Path(__file__).with_name("media_worker.py"))
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class MediaWorkerTests(unittest.TestCase):
    def test_full_hour_limit_without_truncation(self):
        for duration in [30, 601, 1801, 3599.9, 3600]:
            worker.validate_source_duration(duration)
        for duration in [29.9, 3600.1, float("inf"), float("nan")]:
            with self.assertRaisesRegex(ValueError, "60 minutes"):
                worker.validate_source_duration(duration)

    def test_words_have_individual_monotonic_times(self):
        words = worker.timed_words("Short sentences make explanations useful.", [[0.1, .8], [1.2, 3]], 3)
        self.assertEqual(len(words), 5)
        self.assertEqual(words[0]["start"], .1)
        self.assertLessEqual(words[-1]["end"], 3.001)
        self.assertTrue(all(a["end"] <= b["start"] + .026 for a, b in zip(words, words[1:])))
        self.assertTrue(all(w["end"] > w["start"] for w in words))

    def test_no_speech_fails_explicitly(self):
        with self.assertRaisesRegex(ValueError, "audible speech"):
            worker.timed_words("Do not invent captions", [], 3)

    def test_srt_and_ass_safe_text(self):
        self.assertEqual(worker.srt_time(61.123), "00:01:01,123")
        self.assertNotIn("{", worker.ass_text(r"{\pos(1,1)}hello"))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "captions.ass"
            words = worker.timed_words("One word each.", [[0, 2]], 2)
            worker.captions_file(path, "The hook", words, 3, [])
            text = path.read_text()
            self.assertEqual(text.count(",Caption,,"), 3)
            self.assertIn(r"\fscx90", text)

    def test_source_returns_to_full_volume_outside_speech(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "ducked.wav"
            worker.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i",
                        "sine=frequency=200:sample_rate=16000:duration=2",
                        "-af", worker.source_ducking([[.3, .8], [1.3, 1.8]]), str(path)])
            with wave.open(str(path)) as wav:
                audio = np.frombuffer(wav.readframes(wav.getnframes()), dtype=np.int16).astype(float)
            def rms(start, end):
                return math.sqrt(np.mean(audio[int(start * 16000):int(end * 16000)] ** 2))
            self.assertAlmostEqual(rms(.5, .65) / rms(1.0, 1.15), .25, delta=.015)
            self.assertAlmostEqual(rms(1.5, 1.65) / rms(1.0, 1.15), .25, delta=.015)


if __name__ == "__main__":
    unittest.main()
