#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["withoutbg", "Pillow"]
# ///
"""Remove backgrounds from images or replace fake transparency with real alpha.

Usage:
    uv run {baseDir}/scripts/rmbg.py INPUT [OUTPUT] [--batch] [--format FORMAT]

Examples:
    uv run {baseDir}/scripts/rmbg.py photo.jpg                     # -> photo-nobg.png
    uv run {baseDir}/scripts/rmbg.py photo.jpg clean.png           # explicit output
    uv run {baseDir}/scripts/rmbg.py ./input_dir/ --batch          # batch: all images in dir
    uv run {baseDir}/scripts/rmbg.py photo.jpg out.webp --format webp
"""
import argparse
import sys
import time
from pathlib import Path

IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tiff", ".tif"}


def remove_bg(model, input_path: Path, output_path: Path, fmt: str | None = None) -> Path:
    result = model.remove_background(str(input_path))
    if fmt and fmt.lower() == "jpg":
        # JPEG doesn't support transparency — composite on white
        from PIL import Image

        bg = Image.new("RGBA", result.size, (255, 255, 255, 255))
        bg.paste(result, mask=result.split()[3])
        result = bg.convert("RGB")
    result.save(str(output_path))
    return output_path


def default_output(input_path: Path) -> Path:
    return input_path.with_stem(input_path.stem + "-nobg").with_suffix(".png")


def main():
    parser = argparse.ArgumentParser(description="Remove image backgrounds using withoutbg")
    parser.add_argument("input", help="Input image file or directory (with --batch)")
    parser.add_argument("output", nargs="?", help="Output file or directory (default: <name>-nobg.png)")
    parser.add_argument("--batch", action="store_true", help="Process all images in input directory")
    parser.add_argument("--format", choices=["png", "webp", "jpg"], default="png", help="Output format (default: png)")
    args = parser.parse_args()

    input_path = Path(args.input)

    # Load model once
    from withoutbg import WithoutBG

    print("Loading model...", file=sys.stderr)
    t0 = time.time()
    model = WithoutBG.opensource()
    print(f"Model loaded in {time.time() - t0:.1f}s", file=sys.stderr)

    if args.batch:
        if not input_path.is_dir():
            print(f"Error: {input_path} is not a directory (--batch requires a directory)", file=sys.stderr)
            sys.exit(1)
        out_dir = Path(args.output) if args.output else input_path / "nobg"
        out_dir.mkdir(parents=True, exist_ok=True)

        files = sorted(f for f in input_path.iterdir() if f.suffix.lower() in IMAGE_EXTENSIONS)
        if not files:
            print(f"No image files found in {input_path}", file=sys.stderr)
            sys.exit(1)

        print(f"Processing {len(files)} images...", file=sys.stderr)
        for i, f in enumerate(files, 1):
            out = out_dir / f.with_suffix(f".{args.format}").name
            t1 = time.time()
            remove_bg(model, f, out, args.format)
            print(f"  [{i}/{len(files)}] {f.name} -> {out} ({time.time() - t1:.1f}s)", file=sys.stderr)
        print(f"Done. Output in {out_dir}", file=sys.stderr)
    else:
        if not input_path.is_file():
            print(f"Error: {input_path} not found", file=sys.stderr)
            sys.exit(1)
        output_path = Path(args.output) if args.output else default_output(input_path)
        if args.format != "png" and not args.output:
            output_path = output_path.with_suffix(f".{args.format}")
        t1 = time.time()
        remove_bg(model, input_path, output_path, args.format)
        print(f"{input_path} -> {output_path} ({time.time() - t1:.1f}s)", file=sys.stderr)


if __name__ == "__main__":
    main()
