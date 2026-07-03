---
name: audio-transcription
description: "Transcribe local audio/video and Apple Voice Memos quickly with cached MLX Whisper models, including bad/low-quality audio."
---

Use this skill whenever the user asks to transcribe an audio/video file, a Voice Memos export, dictation, lecture, meeting recording, or "bad audio".

## Core rules

1. **Preserve temporary inputs immediately.** Voice Memo share-sheet paths under `~/Library/Containers/com.apple.VoiceMemos/Data/tmp/.com.apple.uikit.itemprovider...` can disappear. Before probing or experimenting, copy the file to stable `/private/tmp/audio-transcription-inputs/`.
2. **Use cached local models, not cloud APIs.** Prefer MLX Whisper via `uvx --from mlx-whisper mlx_whisper`; Hugging Face models must be cached in `~/.cache/huggingface/hub/`.
3. **Force language when known.** For Armin's own dictations this is usually English with an Austrian/German accent, even when the filename is German. Do **not** infer language from filename alone.
4. **For bad audio, run a hallucination-resistant pass.** Use `--condition-on-previous-text False`, `--word-timestamps True`, and `--hallucination-silence-threshold 2`.
5. **Deliver a cleaned best-effort transcript.** Compare model output with timestamps/JSON, remove obvious Whisper loops, and mark uncertain spans as `[unclear]` rather than inventing words.

## Fast path

Run from this skill directory:

```bash
cd /Users/mitsuhiko/Development/agent-stuff/skills/audio-transcription
./transcribe-audio.py "/path/to/audio.m4a" --language en --quality balanced
```

The script:
- stages a stable copy of the input under `/private/tmp/audio-transcription-inputs/`
- ensures the selected model is cached (downloads only if missing)
- writes `txt`, `srt`, `vtt`, `tsv`, and `json` to `/private/tmp/audio-transcriptions/<name>-<timestamp>/`
- detects obvious hallucination loops and, in `balanced` mode, reruns with the full model if needed

Useful variants:

```bash
# Quick draft, fastest cached model
./transcribe-audio.py audio.m4a --language en --quality fast

# Bad/important audio, slower full model
./transcribe-audio.py audio.m4a --language en --quality best \
  --prompt "Armin Ronacher dictating about AI, data centers, Vienna, Donauinsel, shareholder value."

# Auto language detection when language is genuinely unknown
./transcribe-audio.py audio.m4a --language auto --quality balanced
```

## Cached models

Default model IDs:

- Fast/balanced: `mlx-community/whisper-large-v3-turbo`
- Best fallback: `mlx-community/whisper-large-v3-mlx`

Pre-cache / refresh both models:

```bash
cd /Users/mitsuhiko/Development/agent-stuff/skills/audio-transcription
./precache-models.py
```

Verify cache manually:

```bash
find ~/.cache/huggingface/hub -maxdepth 1 -type d -name 'models--mlx-community--whisper-large-v3*' -print
```

If a model is already cached, `mlx_whisper` should say `Fetching 4 files: 100%` almost instantly.

## Manual command template

If the helper script is not suitable, use this command directly:

```bash
mkdir -p /private/tmp/audio-transcriptions/manual
uvx --from mlx-whisper mlx_whisper "/stable/copy/of/audio.m4a" \
  --model mlx-community/whisper-large-v3-turbo \
  --language en \
  --condition-on-previous-text False \
  --word-timestamps True \
  --hallucination-silence-threshold 2 \
  --output-format all \
  --output-dir /private/tmp/audio-transcriptions/manual \
  --output-name transcript \
  --verbose False
```

For especially rough audio, replace the model with `mlx-community/whisper-large-v3-mlx`.

## Quality checks

Inspect the generated `.txt` first, then the `.srt`/`.json` around suspicious areas.

Red flags that require rerun or cleanup:
- repeated phrases for many lines (eg. `in nature` loops)
- many zero-duration segments
- `avg_logprob` is `NaN` or compression ratios are very high in JSON
- text contradicts obvious context words supplied in the prompt

When finalizing, lightly punctuate and paragraph the transcript, but do not over-edit uncertain content.
