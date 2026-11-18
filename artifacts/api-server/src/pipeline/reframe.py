"""Scene-aware 2 Hz face observations and bounded FFmpeg framing, without identity recognition."""
import math
import os


def sample_people(source, start, length):
    import cv2
    import numpy as np
    cascade = os.path.join(cv2.data.haarcascades, "haarcascade_frontalface_default.xml")
    detector = cv2.CascadeClassifier(cascade)
    if detector.empty():
        raise RuntimeError("Face detector model unavailable")
    cap = cv2.VideoCapture(source)
    samples, previous, histogram = [], None, None
    last_cut = -2
    try:
        for n in range(math.ceil(length * 2)):
            at = n / 2
            cap.set(cv2.CAP_PROP_POS_MSEC, (start + at) * 1000)
            ok, frame = cap.read()
            if not ok:
                continue
            h, w = frame.shape[:2]
            scaled = cv2.resize(frame, (min(640, w), max(1, round(h * min(640, w) / w))))
            grey = cv2.cvtColor(scaled, cv2.COLOR_BGR2GRAY)
            thumb = cv2.resize(grey, (64, 36)).astype(np.float32) / 255
            hist = cv2.calcHist([grey], [0], None, [32], [0, 256])
            cv2.normalize(hist, hist)
            change = 0 if histogram is None else cv2.compareHist(histogram, hist, cv2.HISTCMP_BHATTACHARYYA)
            difference = 0 if previous is None else float(np.mean(np.abs(thumb - previous)))
            cut = at - last_cut >= 1 and (change > .55 and difference > .12 or difference > .3)
            if cut:
                last_cut = at
            previous, histogram = thumb, hist
            boxes = detector.detectMultiScale(grey, 1.1, 5, minSize=(20, 20))
            faces = [{"x": float((x + fw / 2) / scaled.shape[1]), "y": float((y + fh / 2) / scaled.shape[0]),
                      "size": float(max(fw / scaled.shape[1], fh / scaled.shape[0]))}
                     for x, y, fw, fh in sorted(boxes, key=lambda b: b[2] * b[3], reverse=True)[:4]]
            samples.append({"t": at, "faces": faces, "cut": bool(cut)})
    finally:
        cap.release()
    return samples


def plan_scenes(samples, length, width, height):
    groups = [[]]
    for sample in samples:
        if sample.get("cut") and groups[-1]:
            groups.append([])
        groups[-1].append(sample)
    scenes = []
    for index, rows in enumerate(groups):
        if not rows:
            continue
        start = rows[0]["t"] if index else 0
        end = groups[index + 1][0]["t"] if index + 1 < len(groups) else length
        covered = sum(bool(r["faces"]) for r in rows) / len(rows)
        pairs = []
        for row in rows:
            faces = sorted(row["faces"], key=lambda f: f["x"])
            pairs.append((faces[0], faces[-1]) if len(faces) >= 2 and faces[-1]["x"] - faces[0]["x"] >= .28 else None)
        split = sum(p is not None for p in pairs) / len(rows) >= .6
        primary, secondary, last = [], [], [None, None]
        corners = 0
        for row, pair in zip(rows, pairs):
            faces = row["faces"]
            first = pair[0] if split and pair else (
                min(faces, key=lambda f: abs(f["x"] - last[0]["x"])) if faces and last[0] else faces[0] if faces else None)
            second = pair[1] if pair else None
            for j, (face, points) in enumerate(((first, primary), (second, secondary))):
                # Damped tracking; no interpolation across scene boundaries.
                point = face or last[j] or {"x": .5, "y": .5, "size": .25}
                smoothed = {k: float(point[k] if last[j] is None else .65 * last[j][k] + .35 * point[k]) for k in ("x", "y", "size")}
                points.append({**smoothed, "t": row["t"] - start})
                last[j] = smoothed
            if first:
                corners += int(first["size"] < .23 and (first["x"] < .25 or first["x"] > .75)
                               and (first["y"] < .35 or first["y"] > .65))
        layout = "fit" if covered < .25 else "speakers" if split else (
            "webcam" if width / height > 1.5 and corners / len(rows) >= .65 else "single")
        scenes.append({"start": start, "end": end, "layout": layout, "primary": primary, "secondary": secondary})
    return scenes or [{"start": 0, "end": length, "layout": "fit", "primary": [], "secondary": []}]


def motion(points, field, pixels, extent):
    values = [(p["t"], max(0, min(pixels - extent, p[field] * pixels - extent / 2))) for p in points]
    if not values:
        return f"{max(0, (pixels - extent) / 2):.2f}"
    expression = f"{values[-1][1]:.2f}"
    for (t0, a), (t1, b) in reversed(list(zip(values, values[1:]))):
        expression = f"if(lt(t,{t1:.3f}),{a:.2f}+({b-a:.2f})*clip((t-{t0:.3f})/{max(.001,t1-t0):.3f},0,1),{expression})"
    return expression


def crop(points, width, height, out_width, out_height, close=False):
    h = min(height, max(2, int(max((p["size"] for p in points), default=.25) * min(width, height) * 3))) if close else height
    h = min(h, int(width * out_height / out_width)) // 2 * 2
    w = min(width, int(h * out_width / out_height)) // 2 * 2
    return (f"crop={max(2,w)}:{max(2,h)}:x='{motion(points,'x',width,w)}':y='{motion(points,'y',height,h)}',"
            f"scale={out_width}:{out_height},setsar=1")


def reframe_filter(scenes, width, height):
    filters = [f"[0:v]split={len(scenes)}" + "".join(f"[scene{i}]" for i in range(len(scenes)))]
    for i, scene in enumerate(scenes):
        filters.append(f"[scene{i}]trim=start={scene['start']:.3f}:end={scene['end']:.3f},setpts=PTS-STARTPTS[in{i}]")
        layout = scene["layout"]
        if layout == "speakers":
            filters.extend([f"[in{i}]split=2[left{i}][right{i}]",
                            f"[left{i}]{crop(scene['primary'],width,height,1080,960,True)}[top{i}]",
                            f"[right{i}]{crop(scene['secondary'],width,height,1080,960,True)}[bottom{i}]",
                            f"[top{i}][bottom{i}]vstack=inputs=2[out{i}]"])
        elif layout == "webcam":
            filters.extend([f"[in{i}]split=2[full{i}][cam{i}]",
                            f"[full{i}]scale=1080:1280:force_original_aspect_ratio=decrease,pad=1080:1280:(ow-iw)/2:(oh-ih)/2,setsar=1[base{i}]",
                            f"[cam{i}]{crop(scene['primary'],width,height,1080,640,True)}[head{i}]",
                            f"[head{i}][base{i}]vstack=inputs=2[out{i}]"])
        elif layout == "single":
            filters.append(f"[in{i}]{crop(scene['primary'],width,height,1080,1920)}[out{i}]")
        else:
            filters.append(f"[in{i}]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=0x09090B,setsar=1[out{i}]")
    filters.append("".join(f"[out{i}]" for i in range(len(scenes))) + f"concat=n={len(scenes)}:v=1:a=0,fps=60[v]")
    return ";".join(filters)


def retention_zoom():
    # 2.5s smoothstep hook zoom; restrained framing cuts at exact seven-second intervals.
    zoom = "if(lte(on,150),1+0.07*pow(on/150,2)*(3-2*on/150),if(lt(mod(on,840),420),1.07,1.035))"
    return f"zoompan=z='{zoom}':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s=1080x1920:fps=60"
