#!/usr/bin/env -S uv run python3
# /// script
# requires-python = ">=3.11"
# ///
"""
Transcribe audio using mlx-whisper (local, Apple Silicon GPU-accelerated).
Runs entirely on-device — no API keys, no file size limits.

Usage:
    transcribe.py <audio-file> [options]

Output:
    txt format → stdout (pipe-friendly)
    srt/vtt    → file saved alongside the input, path printed to stderr
"""
import argparse
import subprocess
import sys
import tempfile
from pathlib import Path

DEFAULT_MODEL = "mlx-community/whisper-large-v3-turbo"


def main():
    parser = argparse.ArgumentParser(
        description="Transcribe audio locally with mlx-whisper"
    )
    parser.add_argument("audio_file", help="Path to audio/video file")
    parser.add_argument(
        "--model",
        default=DEFAULT_MODEL,
        help=f"mlx-whisper model (default: {DEFAULT_MODEL}). "
             "Use 'mlx-community/whisper-large-v3' for maximum accuracy.",
    )
    parser.add_argument(
        "--language",
        default=None,
        help="Language code, e.g. 'en', 'mi' (te reo Māori). "
             "Auto-detected if omitted.",
    )
    parser.add_argument(
        "--format",
        dest="output_format",
        choices=["txt", "srt", "vtt", "json"],
        default="txt",
        help="Output format (default: txt → stdout)",
    )
    parser.add_argument(
        "--output", "-o",
        default=None,
        help="Output file path. For txt, defaults to stdout. "
             "For srt/vtt/json, defaults to <input-stem>.<format> in same dir.",
    )
    parser.add_argument(
        "--initial-prompt",
        default=None,
        help="Vocabulary hint for the first window — helps with proper nouns, "
             "Māori terms, thinker names, etc. E.g. 'Moana Jackson, tikanga, "
             "rangatiratanga, te Tiriti o Waitangi'",
    )
    parser.add_argument(
        "--translate",
        action="store_true",
        help="Translate to English instead of transcribing in source language",
    )
    args = parser.parse_args()

    audio_path = Path(args.audio_file).resolve()
    if not audio_path.exists():
        print(f"Error: file not found: {audio_path}", file=sys.stderr)
        sys.exit(1)

    mlx_bin = _find_mlx_whisper()

    # Build base command
    cmd = [
        mlx_bin,
        str(audio_path),
        "--model", args.model,
        "--output-format", args.output_format,
        "--task", "translate" if args.translate else "transcribe",
    ]
    if args.language:
        cmd += ["--language", args.language]
    if args.initial_prompt:
        cmd += ["--initial-prompt", args.initial_prompt]

    # Determine output destination
    if args.output_format == "txt" and args.output is None:
        _run_to_stdout(cmd, audio_path)
    else:
        output_path = _resolve_output_path(args.output, audio_path, args.output_format)
        cmd += ["--output-dir", str(output_path.parent), "--output-name", output_path.stem]
        result = subprocess.run(cmd)
        if result.returncode != 0:
            sys.exit(result.returncode)
        print(f"Saved: {output_path}", file=sys.stderr)


def _run_to_stdout(cmd: list, audio_path: Path) -> None:
    """Run mlx_whisper, capture the txt output file, print to stdout."""
    with tempfile.TemporaryDirectory() as tmpdir:
        stem = audio_path.stem
        cmd = cmd + ["--output-dir", tmpdir, "--output-name", stem]
        result = subprocess.run(cmd)
        if result.returncode != 0:
            sys.exit(result.returncode)
        out_file = Path(tmpdir) / f"{stem}.txt"
        if out_file.exists():
            sys.stdout.write(out_file.read_text())
        else:
            # mlx_whisper sometimes names files differently
            candidates = list(Path(tmpdir).glob("*.txt"))
            if candidates:
                sys.stdout.write(candidates[0].read_text())
            else:
                print("Error: mlx_whisper produced no output file", file=sys.stderr)
                sys.exit(1)


def _resolve_output_path(output: str | None, audio_path: Path, fmt: str) -> Path:
    if output:
        return Path(output).resolve()
    return audio_path.with_suffix(f".{fmt}")


def _find_mlx_whisper() -> str:
    import shutil
    path = shutil.which("mlx_whisper")
    if path:
        return path
    # uv tool installs here by default
    fallback = Path.home() / ".local" / "bin" / "mlx_whisper"
    if fallback.exists():
        return str(fallback)
    print(
        "Error: mlx_whisper not found.\n"
        "Install it with: uv tool install mlx-whisper",
        file=sys.stderr,
    )
    sys.exit(1)


if __name__ == "__main__":
    main()
