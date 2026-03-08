---
name: transcribe-local
description: Local speech-to-text transcription using mlx-whisper (Apple Silicon GPU-accelerated). Runs entirely on-device — no API keys, no file size limits, no data leaves the machine. Use this skill whenever the user wants to transcribe audio or video files, convert speech to text, transcribe interviews or recordings, generate subtitles (SRT/VTT), or transcribe content in te reo Māori or other languages. Trigger on phrases like "transcribe this", "convert audio to text", "get a transcript of", "speech to text", or when the user points at an audio/video file and wants its content as text.
---

# Transcribe

Local transcription via `mlx-whisper`. Uses Apple Silicon GPU (Metal) — fast, private, no size limits.

## Quick start

```bash
# Text transcript to stdout
uv run {baseDir}/scripts/transcribe.py audio.mp3

# Save as SRT subtitles
uv run {baseDir}/scripts/transcribe.py audio.mp3 --format srt

# Specify language (skip auto-detection, slightly faster)
uv run {baseDir}/scripts/transcribe.py audio.mp3 --language en

# te reo Māori content
uv run {baseDir}/scripts/transcribe.py audio.mp3 --language mi

# Vocabulary hint for proper nouns (thinker names, Māori terms, etc.)
uv run {baseDir}/scripts/transcribe.py audio.mp3 \
  --initial-prompt "Moana Jackson, tikanga, rangatiratanga, te Tiriti o Waitangi"

# Translate to English (from any language)
uv run {baseDir}/scripts/transcribe.py audio.mp3 --translate

# Save to a specific file
uv run {baseDir}/scripts/transcribe.py audio.mp3 -o /tmp/transcript.txt
```

## Options

| Flag | Default | Notes |
|------|---------|-------|
| `--language` | auto | ISO code: `en`, `mi`, `fr`, etc. |
| `--format` | `txt` | `txt` → stdout; `srt`/`vtt`/`json` → file |
| `--output` / `-o` | alongside input | Override output file path |
| `--initial-prompt` | none | Vocabulary hint for first window |
| `--translate` | off | Translate to English instead of transcribing |
| `--model` | `whisper-large-v3-turbo` | See models below |

## Models

| Model | Speed | Accuracy | When to use |
|-------|-------|----------|-------------|
| `mlx-community/whisper-large-v3-turbo` | **Fast** | High | Default — good for almost everything |
| `mlx-community/whisper-large-v3` | Slower | **Highest** | Use when accuracy matters most (Māori, quiet audio, accents) |
| `mlx-community/distil-whisper-large-v3` | Fastest | Good | Long files where speed matters |

Models are downloaded on first use (~750MB–1.5GB) and cached in `~/.cache/huggingface/`.

## Tips

- **Long files**: no splitting needed — mlx-whisper handles them natively via sliding window
- **te reo Māori**: use both `--language mi` and `--initial-prompt` with key terms for best results. Māori accuracy is imperfect — review transcripts
- **Noisy audio**: try `whisper-large-v3` (without turbo) for better handling
- **Capture to file**: `python3 transcribe.py audio.mp3 > transcript.txt`
- **Progress**: mlx-whisper prints segment-by-segment progress to stderr

## Supported formats

mp3, m4a, wav, ogg, flac, webm, mp4, mov, mkv (any format ffmpeg handles)
