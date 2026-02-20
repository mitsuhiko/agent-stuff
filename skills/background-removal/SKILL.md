---
name: background-removal
description: Remove backgrounds from images or replace fake transparency (checkerboard patterns) with real alpha transparency. Use when asked to (1) remove image backgrounds, (2) make image backgrounds transparent, (3) fix fake/checkerboard transparency in PNGs, (4) extract subjects/foreground from photos, (5) batch process images for background removal, or (6) convert images with solid/patterned backgrounds to transparent PNGs.
---

# Background Removal

Remove backgrounds from images locally using [withoutbg](https://github.com/withoutbg/withoutbg) (AI-powered, runs offline, no API key needed). Handles both real backgrounds and fake transparency (checkerboard patterns baked into pixels).

## Quick Reference

```bash
# Single image (output: <name>-nobg.png)
uv run {baseDir}/scripts/rmbg.py photo.jpg

# Explicit output path
uv run {baseDir}/scripts/rmbg.py photo.jpg clean.png

# Batch: all images in a directory (output: <dir>/nobg/)
uv run {baseDir}/scripts/rmbg.py ./photos/ --batch

# Batch with explicit output directory
uv run {baseDir}/scripts/rmbg.py ./photos/ ./clean/ --batch

# Output as webp or jpg (jpg composites on white since no alpha)
uv run {baseDir}/scripts/rmbg.py photo.png out.webp --format webp
```

## Python API (for inline use without the script)

```python
# /// script
# dependencies = ["withoutbg"]
# ///
from withoutbg import WithoutBG

model = WithoutBG.opensource()  # load once, reuse for multiple images
result = model.remove_background("input.jpg")  # returns PIL Image (RGBA)
result.save("output.png")
```

## Notes

- First run downloads ~100 MB of ONNX models (cached in HuggingFace cache).
- Supports: PNG, JPG, JPEG, WebP, BMP, TIFF.
- Output is always RGBA PNG by default (real alpha channel).
- For JPG output (`--format jpg`), the transparent area is composited onto white.
- The model runs on CPU; typical processing is 2–5 seconds per image.
