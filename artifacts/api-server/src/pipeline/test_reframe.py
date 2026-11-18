import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
import cv2
from reframe import plan_scenes, reframe_filter, motion, retention_zoom, sample_people


def face(x, y=.4, size=.2):
    return {"x": x, "y": y, "size": size}


class ReframeTests(unittest.TestCase):
    def test_real_detector_samples_twice_per_second_and_recognizes_a_hard_scene_cut(self):
        self.assertTrue(hasattr(cv2, "CascadeClassifier"))
        with tempfile.TemporaryDirectory() as folder:
            source = str(Path(folder) / "scenes.mp4")
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "color=black:s=128x72:r=10:d=1.5",
                            "-f", "lavfi", "-i", "color=white:s=128x72:r=10:d=1.5",
                            "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]", "-map", "[v]",
                            "-c:v", "libx264", "-threads", "1", source], check=True, capture_output=True)
            rows = sample_people(source, 0, 3)
            self.assertEqual([r["t"] for r in rows], [0, .5, 1, 1.5, 2, 2.5])
            self.assertTrue(rows[3]["cut"])

    def test_separated_speakers_split_and_scene_cuts_reset_smoothing(self):
        rows = [{"t": n / 2, "faces": [face(.2), face(.8)], "cut": False} for n in range(4)]
        rows += [{"t": 2 + n / 2, "faces": [face(.75)], "cut": n == 0} for n in range(4)]
        scenes = plan_scenes(rows, 4, 1920, 1080)
        self.assertEqual([s["layout"] for s in scenes], ["speakers", "single"])
        self.assertEqual(scenes[0]["end"], 2)
        self.assertEqual(scenes[1]["primary"][0]["x"], .75)
        self.assertEqual(scenes[1]["primary"][0]["t"], 0)

    def test_framing_does_not_invent_faces_or_split_nearby_people(self):
        self.assertEqual(plan_scenes([], 3, 1920, 1080)[0]["layout"], "fit")
        rows = [{"t": n / 2, "faces": [face(.45), face(.55)]} for n in range(4)]
        self.assertEqual(plan_scenes(rows, 2, 1920, 1080)[0]["layout"], "single")
        rows = [{"t": n / 2, "faces": [face(.12, .15, .15)]} for n in range(4)]
        self.assertEqual(plan_scenes(rows, 2, 1920, 1080)[0]["layout"], "webcam")

    def test_temporal_damping_and_crop_bounds(self):
        rows = [{"t": n / 2, "faces": [face(x)]} for n, x in enumerate([.3, .7, .3, .7])]
        points = plan_scenes(rows, 2, 1920, 1080)[0]["primary"]
        self.assertLess(abs(points[1]["x"] - points[0]["x"]), .15)
        self.assertTrue(all(0 <= p["x"] <= 1 for p in points))
        self.assertEqual(motion([{"t": 0, "x": -1}], "x", 1920, 608), "0.00")
        self.assertEqual(motion([{"t": 0, "x": 2}], "x", 1920, 608), "1312.00")

    def test_real_ffmpeg_renders_two_distinct_speaker_panels_and_multiple_scenes(self):
        with tempfile.TemporaryDirectory() as folder:
            image = str(Path(folder) / "panels.png")
            rows = [{"t": n / 2, "faces": [face(.2), face(.8)]} for n in range(4)]
            rows += [{"t": 2, "faces": [], "cut": True}]
            graph = reframe_filter(plan_scenes(rows, 3, 1000, 600), 1000, 600)
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i",
                            "color=red:s=1000x600:r=30:d=3,drawbox=x=500:y=0:w=500:h=600:color=blue:t=fill",
                            "-filter_complex_threads", "1", "-filter_complex", graph, "-map", "[v]",
                            "-frames:v", "1", "-threads", "1", image], check=True, capture_output=True)
            pixels = cv2.imread(image)
            self.assertEqual(pixels.shape[:2], (1920, 1080))
            self.assertGreater(int(pixels[480, 540, 2]), 220)
            self.assertGreater(int(pixels[1440, 540, 0]), 220)

    def test_long_tracking_expression_and_zoom_parse_in_real_ffmpeg(self):
        with tempfile.TemporaryDirectory() as folder:
            points = [{"t": n / 2, "x": .3 + .003 * n, "y": .4, "size": .2} for n in range(90)]
            scene = {"start": 0, "end": 45, "layout": "single", "primary": points}
            graph = reframe_filter([scene], 1920, 1080).replace("[v]", "[framed]") + f";[framed]{retention_zoom()}[v]"
            subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=gray:s=1920x1080:r=30:d=1",
                            "-filter_complex_threads", "1", "-filter_complex", graph, "-map", "[v]",
                            "-frames:v", "2", "-f", "null", "-"], check=True, capture_output=True)

    def test_loudness_target_on_a_local_audio_fixture(self):
        with tempfile.TemporaryDirectory() as folder:
            audio = str(Path(folder) / "normalized.wav")
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=3:sample_rate=48000",
                            "-af", "loudnorm=I=-14:TP=-1.5:LRA=11", audio], check=True, capture_output=True)
            result = subprocess.run(["ffmpeg", "-hide_banner", "-i", audio, "-af", "loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json",
                                     "-f", "null", "-"], check=True, capture_output=True, text=True)
            metrics, _ = json.JSONDecoder().raw_decode(result.stderr[result.stderr.rfind("{"):])
            self.assertAlmostEqual(float(metrics["input_i"]), -14, delta=.5)
            self.assertLessEqual(float(metrics["input_tp"]), -1.4)


if __name__ == "__main__":
    unittest.main()
