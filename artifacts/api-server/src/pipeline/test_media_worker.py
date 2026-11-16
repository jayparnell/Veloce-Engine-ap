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
            self.assertIn(r"\c&H0056D9A8&", text)
            self.assertIn(r"\c&H00FFFFFF&", text)
            self.assertIn("One", text)
            self.assertIn("word", text)

    def test_estimated_caption_accuracy_on_labeled_synthetic_fixture(self):
        # These reference boundaries are an explicit synthetic fixture, not a claim about human speech.
        words = worker.timed_words("One short example really matters", [[.1, .9], [1.2, 3.0]], 3)
        reference = [.1, .4, .8, 1.5, 2.2]
        errors = sorted(abs(w["start"] - truth) for w, truth in zip(words, reference))
        mae = sum(errors) / len(errors)
        p95 = errors[-1]
        print(f"Synthetic caption boundary error: MAE={mae:.3f}s p95={p95:.3f}s (5 words; not human-speech validation)")
        self.assertLess(mae, .35)
        self.assertLess(p95, .6)

    def test_campaign_bed_has_fifteen_percent_gain(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "bed.wav"
            worker.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i",
                        "sine=frequency=200:sample_rate=16000:duration=1",
                        "-af", "volume=0.15", str(path)])
            with wave.open(str(path)) as wav:
                samples = np.frombuffer(wav.readframes(wav.getnframes()), dtype=np.int16).astype(float)
            # FFmpeg sine defaults to amplitude 4095; measured gain must match before codec loss.
            self.assertAlmostEqual(math.sqrt(np.mean(samples ** 2)) / (4095 / math.sqrt(2)), .15, delta=.002)

    def test_retained_captions_reuse_exact_timing_and_reject_wrong_duration(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "previous.srt"
            path.write_text("1\n00:00:00,120 --> 00:00:00,730\nOriginal\n\n2\n00:00:00,730 --> 00:00:01,100\nwords\n")
            words = worker.retained_words(path, 2)
            self.assertEqual(words, [
                {"start": .12, "end": .73, "text": "Original"},
                {"start": .73, "end": 1.1, "text": "words"},
            ])
            with self.assertRaisesRegex(ValueError, "do not fit"):
                worker.retained_words(path, .5)
            path.write_text("1\nbad timing\nwords")
            with self.assertRaisesRegex(ValueError, "invalid"):
                worker.retained_words(path, 2)

    def test_disabled_captions_keep_hook_without_narration_overlay(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "disabled.ass"
            worker.captions_file(path, "Edited hook", [], 2, [])
            text = path.read_text()
            self.assertIn("Edited hook", text)
            self.assertNotIn(",Caption,,", text)

    def test_temporal_crop_expression_moves_and_clamps(self):
        points = [{"t": 0, "x": .1}, {"t": .5, "x": .8}, {"t": 1, "x": .9}]
        expression = worker.tracking_expression(points, "x", 1920, 608)
        self.assertIn("if(lt(t,0.500)", expression)
        self.assertIn("1312.00", expression)
        self.assertNotIn("sin(", expression)

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
