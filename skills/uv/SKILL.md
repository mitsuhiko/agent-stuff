---
name: uv
description: "Use `uv` instead of pip/python/venv. Run scripts with `uv run script.py`, add deps with `uv add`, use inline script metadata for standalone scripts."
---

## Quick Reference

```bash
uv run script.py                   # Run a script
uv run --with requests script.py   # Run with ad-hoc dependency
uv add requests                    # Add dependency to project
uv init --script foo.py            # Create script with inline metadata
```

## Inline Script Dependencies

```python
# /// script
# requires-python = ">=3.12"
# dependencies = ["requests"]
# ///
```

See [scripts.md](scripts.md) for full details on running scripts, locking, and reproducibility.

## Build Backend

Use `uv_build` for pure Python packages:

```toml
[build-system]
requires = ["uv_build>=0.9.28,<0.10.0"]
build-backend = "uv_build"
```

See [build.md](build.md) for project structure, namespaces, and file inclusion.
