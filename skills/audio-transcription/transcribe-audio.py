#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# ///
"""Transcribe audio with cached MLX Whisper models.

This is intentionally dependency-free; it shells out to `uvx --from mlx-whisper
mlx_whisper` and uses `precache-models.py` only when a Hugging Face model is not
present in the local cache.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import shutil
import subprocess
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path

FAST_MODEL = "mlx-community/whisper-large-v3-turbo"
BEST_MODEL = "mlx-community/whisper-large-v3-mlx"


def slugify(value: str) -> str:
    value = re.sub(r"[^A-Za-z0-9._-]+", "-", value).strip("-._")
    return value or "audio"


def timestamp() -> str:
    return datetime.now().strftime("%Y%m%d-%H%M%S")


def hub_cache_dir() -> Path:
    if os.environ.get("HF_HUB_CACHE"):
        return Path(os.environ["HF_HUB_CACHE"]).expanduser()
    if os.environ.get("HUGGINGFACE_HUB_CACHE"):
        return Path(os.environ["HUGGINGFACE_HUB_CACHE"]).expanduser()
    hf_home = Path(os.environ.get("HF_HOME", "~/.cache/huggingface")).expanduser()
    return hf_home / "hub"


def model_cache_path(model: str) -> Path:
    return hub_cache_dir() / ("models--" + model.replace("/", "--"))


def is_probably_hf_model(model: str) -> bool:
    return not Path(model).expanduser().exists() and "/" in model and not model.startswith("/")


def is_model_cached(model: str) -> bool:
    if not is_probably_hf_model(model):
        return True
    root = model_cache_path(model)
    snapshots = root / "snapshots"
    if not snapshots.exists():
        return False
    for snap in snapshots.iterdir():
        if not snap.is_dir():
            continue
        if (snap / "config.json").exists() and (
            (snap / "weights.safetensors").exists()
            or (snap / "weights.npz").exists()
            or any(snap.glob("*.safetensors"))
            or any(snap.glob("*.npz"))
        ):
            return True
    return False


def ensure_model_cached(model: str, *, no_precache: bool = False) -> None:
    if not is_probably_hf_model(model):
        return
    if is_model_cached(model):
        print(f"model cached: {model_cache_path(model)}")
        return
    if no_precache:
        print(f"warning: model does not appear cached: {model}", file=sys.stderr)
        return

    script = Path(__file__).with_name("precache-models.py")
    print(f"model missing; downloading/cacheing {model} ...")
    subprocess.run([str(script), model], check=True)


def stage_input(src: Path) -> Path:
    if not src.exists():
        raise SystemExit(f"input does not exist: {src}")
    if not src.is_file():
        raise SystemExit(f"input is not a file: {src}")

    stage_dir = Path("/private/tmp/audio-transcription-inputs")
    stage_dir.mkdir(parents=True, exist_ok=True)
    dst = stage_dir / f"{slugify(src.stem)}-{timestamp()}{src.suffix or '.audio'}"
    shutil.copy2(src, dst)
    return dst


def run_whisper(
    staged_audio: Path,
    *,
    model: str,
    language: str,
    prompt: str | None,
    out_dir: Path,
    word_timestamps: bool,
    verbose_whisper: bool,
) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)

    cmd = [
        "uvx",
        "--from",
        "mlx-whisper",
        "mlx_whisper",
        str(staged_audio),
        "--model",
        model,
        "--condition-on-previous-text",
        "False",
        "--temperature",
        "0",
        "--output-format",
        "all",
        "--output-dir",
        str(out_dir),
        "--output-name",
        "transcript",
        "--verbose",
        "True" if verbose_whisper else "False",
    ]
    if language and language.lower() != "auto":
        cmd.extend(["--language", language])
    if prompt:
        cmd.extend(["--initial-prompt", prompt])
    if word_timestamps:
        cmd.extend(
            [
                "--word-timestamps",
                "True",
                "--hallucination-silence-threshold",
                "2",
            ]
        )

    (out_dir / "command.txt").write_text(" ".join(map(shlex_quote, cmd)) + "\n")
    print("running:", " ".join(map(shlex_quote, cmd)))
    subprocess.run(cmd, check=True)
    return out_dir / "transcript.json"


def shlex_quote(s: str) -> str:
    # Small local quote helper to avoid importing shlex just for display.
    if re.match(r"^[A-Za-z0-9_./:=@%+,-]+$", s):
        return s
    return "'" + s.replace("'", "'\\''") + "'"


def finite_float(value: object) -> float | None:
    try:
        f = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def analyze_json(json_path: Path) -> tuple[bool, list[str]]:
    notes: list[str] = []
    try:
        data = json.loads(json_path.read_text())
    except Exception as e:  # noqa: BLE001 - diagnostic helper
        return True, [f"could not parse JSON: {e}"]

    segments = data.get("segments") or []
    nonempty = [s for s in segments if str(s.get("text", "")).strip()]
    if not nonempty:
        return True, ["no non-empty transcript segments"]

    high_cr = []
    nan_lp = []
    zero_dur = []
    for s in nonempty:
        cr = finite_float(s.get("compression_ratio"))
        lp_raw = s.get("avg_logprob")
        lp = finite_float(lp_raw)
        if cr is not None and cr > 5:
            high_cr.append(s)
        if lp is None and lp_raw is not None:
            nan_lp.append(s)
        start = finite_float(s.get("start")) or 0.0
        end = finite_float(s.get("end")) or 0.0
        if end - start <= 0.05:
            zero_dur.append(s)

    normalized = [re.sub(r"\s+", " ", str(s.get("text", "")).strip().lower()) for s in nonempty]
    repeated_text, repeated_count = Counter(t for t in normalized if t).most_common(1)[0]

    suspicious = False
    if len(high_cr) >= max(3, len(nonempty) // 8):
        suspicious = True
        notes.append(f"many high-compression segments: {len(high_cr)}/{len(nonempty)}")
    if len(nan_lp) >= max(3, len(nonempty) // 8):
        suspicious = True
        notes.append(f"many NaN/non-finite logprob segments: {len(nan_lp)}/{len(nonempty)}")
    if len(zero_dur) >= max(5, len(nonempty) // 6):
        suspicious = True
        notes.append(f"many zero-duration segments: {len(zero_dur)}/{len(nonempty)}")
    if repeated_count >= 4 and repeated_count >= len(nonempty) * 0.12:
        suspicious = True
        notes.append(f"repeated phrase {repeated_count}x: {repeated_text!r}")

    return suspicious, notes


def output_summary(out_dir: Path) -> None:
    print("\noutputs:")
    for ext in ["txt", "srt", "vtt", "tsv", "json"]:
        p = out_dir / f"transcript.{ext}"
        if p.exists():
            print(f"  {ext}: {p}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("audio", help="Audio/video file to transcribe")
    parser.add_argument(
        "--language",
        default="auto",
        help="Whisper language code/name, or 'auto'. Use 'en' for most Armin dictations.",
    )
    parser.add_argument(
        "--quality",
        choices=["fast", "balanced", "best"],
        default="balanced",
        help="fast=turbo draft; balanced=turbo with bad-audio settings and fallback; best=full model",
    )
    parser.add_argument("--model", help="Override model ID or local MLX Whisper model path")
    parser.add_argument("--prompt", help="Initial prompt with names, places, jargon, and context")
    parser.add_argument("--output-dir", type=Path, help="Base output directory")
    parser.add_argument("--no-precache", action="store_true", help="Do not download missing Hugging Face models")
    parser.add_argument("--no-rerun", action="store_true", help="Do not rerun balanced mode with the full model if suspicious")
    parser.add_argument("--verbose-whisper", action="store_true", help="Let mlx_whisper print segment text")
    args = parser.parse_args()

    src = Path(args.audio).expanduser()
    staged = stage_input(src)
    print(f"staged input: {staged}")

    base_name = slugify(src.stem)
    out_base = args.output_dir or Path("/private/tmp/audio-transcriptions") / f"{base_name}-{timestamp()}"
    out_base.mkdir(parents=True, exist_ok=True)
    (out_base / "source.txt").write_text(f"original: {src}\nstaged: {staged}\n")

    if args.model:
        first_model = args.model
        first_label = slugify(args.model.split("/")[-1])
    elif args.quality == "best":
        first_model = BEST_MODEL
        first_label = "best"
    else:
        first_model = FAST_MODEL
        first_label = "turbo"

    ensure_model_cached(first_model, no_precache=args.no_precache)
    first_json = run_whisper(
        staged,
        model=first_model,
        language=args.language,
        prompt=args.prompt,
        out_dir=out_base / first_label,
        word_timestamps=args.quality != "fast",
        verbose_whisper=args.verbose_whisper,
    )
    final_dir = first_json.parent
    suspicious, notes = analyze_json(first_json)

    if notes:
        print("\nquality notes:")
        for note in notes:
            print(f"  - {note}")

    if (
        args.quality == "balanced"
        and not args.model
        and suspicious
        and not args.no_rerun
    ):
        print("\nsuspicious output detected; rerunning with full model ...")
        ensure_model_cached(BEST_MODEL, no_precache=args.no_precache)
        best_json = run_whisper(
            staged,
            model=BEST_MODEL,
            language=args.language,
            prompt=args.prompt,
            out_dir=out_base / "best",
            word_timestamps=True,
            verbose_whisper=args.verbose_whisper,
        )
        final_dir = best_json.parent
        suspicious, notes = analyze_json(best_json)
        if notes:
            print("\nfull-model quality notes:")
            for note in notes:
                print(f"  - {note}")

    output_summary(final_dir)
    if suspicious:
        print("\nwarning: transcript still looks suspicious; inspect JSON/SRT and mark uncertain spans.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
