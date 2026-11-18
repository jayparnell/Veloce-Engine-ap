---
name: Media runtime compatibility
description: Non-obvious OpenCV and OpenAI upload behavior encountered in the media pipeline.
---

The OpenCV 5 wheel available in this environment lacked both CascadeClassifier and the bundled Haar XML resources, even though video decoding and general image functions worked.

**Why:** An import-only readiness check passed while actual face detection failed at runtime. The compatible OpenCV 4 line includes the detector and data used by this product.

**How to apply:** Do not upgrade back to a wheel without verifying the actual detector constructor, model-file availability and a real sampled-video detection pass. If adopting another detector, update its resources and verification together.

Python dependency installation can rebuild the environment, exposing missing native runtime libraries even when the lockfile's existing packages did not change.

**Why:** A fresh wheel environment could not load the C++ runtime until managed GCC/zlib system dependencies were available.

**How to apply:** After Python package changes, verify actual NumPy/OpenCV imports and the detector/model resources, not just package resolution. Keep required native libraries managed as portable system dependencies rather than hardcoded Nix store paths.

OpenAI SDK multipart uploads can call a custom fetch wrapper with a local data URL to discover the Response implementation before making the API request.

**Why:** Counting this as a provider call produced a misleading extra-request failure, and attaching billing/request headers to a local capability probe is unnecessary.

**How to apply:** Preserve local probe handling separately from authenticated upstream calls when changing the fetch wrapper or multipart transport tests.
