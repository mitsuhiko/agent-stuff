# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Analyze edit tool invocations in pi session JSONL files.

Usage: uv run analyze-edits.py <session.jsonl> [session2.jsonl ...]

Reports how many times the Edit tool was invoked via each mode:
  - single: classic path/oldText/newText
  - multi(N): multi array with N edits
  - single+multi(N): top-level edit + multi array (N total)
  - patch: Codex-style patch

Also breaks down by file extension.
"""

import json
import os
import sys
from collections import Counter
from dataclasses import dataclass
from pathlib import Path


def base_mode(mode: str) -> str:
    if mode.startswith("multi(") or mode.startswith("single+multi("):
        return "multi"
    return mode


def classify_edit(args: dict) -> tuple[str, list[str]]:
    """Returns (mode_label, list_of_file_extensions)."""
    has_patch = "patch" in args
    has_multi = "multi" in args
    has_single = "path" in args and "oldText" in args

    paths: list[str] = []

    if has_patch:
        # Parse paths from patch text
        patch_text = args["patch"]
        for line in patch_text.split("\n"):
            line = line.strip()
            for prefix in ("*** Add File: ", "*** Delete File: ", "*** Update File: "):
                if line.startswith(prefix):
                    paths.append(line[len(prefix):])
        return "patch", paths

    multi_items = args.get("multi", [])

    if has_single and has_multi:
        paths.append(args["path"])
        paths.extend(item.get("path", "") for item in multi_items)
        return f"single+multi({1 + len(multi_items)})", paths

    if has_multi:
        paths.extend(item.get("path", "") for item in multi_items)
        return f"multi({len(multi_items)})", paths

    if has_single:
        paths.append(args["path"])
        return "single", paths

    return "unknown", paths


def get_ext(path: str) -> str:
    ext = Path(path).suffix
    return ext if ext else "(no ext)"


@dataclass
class EditCall:
    mode: str
    extensions: list[str]
    failed: bool


def analyze_session(filepath: str) -> list[EditCall]:
    """Returns list of EditCall for each edit tool invocation."""
    # First pass: collect edit tool calls and their IDs
    calls: list[tuple[str, str, list[str]]] = []  # (toolCallId, mode, exts)
    tool_call_ids: dict[str, int] = {}  # toolCallId -> index in calls

    # Also collect tool results to check for errors
    tool_results: dict[str, bool] = {}  # toolCallId -> isError

    entries = []
    with open(filepath) as f:
        for line in f:
            entries.append(json.loads(line))

    for d in entries:
        if d.get("type") != "message":
            continue
        msg = d.get("message", {})
        role = msg.get("role")
        if role == "assistant":
            for c in msg.get("content", []):
                if c.get("type") == "toolCall" and c.get("name") in ("edit", "Edit"):
                    mode, paths = classify_edit(c.get("arguments", {}))
                    exts = [get_ext(p) for p in paths]
                    tc_id = c.get("id", "")
                    idx = len(calls)
                    calls.append((tc_id, mode, exts))
                    tool_call_ids[tc_id] = idx
        elif role == "toolResult":
            tc_id = msg.get("toolCallId", "")
            is_error = msg.get("isError", False)
            tool_results[tc_id] = is_error

    results = []
    for tc_id, mode, exts in calls:
        failed = tool_results.get(tc_id, False)
        results.append(EditCall(mode=mode, extensions=exts, failed=failed))
    return results


def main():
    if len(sys.argv) < 2:
        print(__doc__.strip())
        sys.exit(1)

    all_results: list[EditCall] = []
    session_files = []

    for arg in sys.argv[1:]:
        p = Path(arg)
        if p.is_dir():
            session_files.extend(sorted(p.glob("**/*.jsonl")))
        else:
            session_files.append(p)

    for sf in session_files:
        all_results.extend(analyze_session(str(sf)))

    if not all_results:
        print("No edit tool calls found.")
        return

    total = len(all_results)
    total_failed = sum(1 for r in all_results if r.failed)

    # Count tool calls (not individual edits) by base mode
    mode_calls: Counter[str] = Counter()
    mode_fails: Counter[str] = Counter()
    # Count tool calls by (base_mode, primary_ext)
    # For a tool call, we pick the dominant extension
    mode_ext_calls: Counter[tuple[str, str]] = Counter()
    mode_ext_fails: Counter[tuple[str, str]] = Counter()
    ext_calls: Counter[str] = Counter()
    ext_fails: Counter[str] = Counter()

    for r in all_results:
        bm = base_mode(r.mode)
        mode_calls[bm] += 1
        if r.failed:
            mode_fails[bm] += 1

        # For extension: count one call per unique extension touched
        exts = set(r.extensions) if r.extensions else {"(no ext)"}
        for ext in exts:
            mode_ext_calls[(bm, ext)] += 1
            ext_calls[ext] += 1
            if r.failed:
                mode_ext_fails[(bm, ext)] += 1
                ext_fails[ext] += 1

    print(f"{'='*60}")
    print(f"Edit Tool Analysis ({len(session_files)} session(s))")
    print(f"{'='*60}")
    print(f"\nTotal edit tool calls: {total}")
    print(f"Total failures: {total_failed} ({total_failed/total*100:.1f}%)")

    print(f"\n--- By Mode (tool calls) ---")
    for mode, count in sorted(mode_calls.items(), key=lambda x: -x[1]):
        pct = count / total * 100
        fails = mode_fails[mode]
        fail_pct = fails / count * 100 if count else 0
        print(f"  {mode:<12s} {count:>4d}  ({pct:5.1f}%)   fail: {fails:>3d} ({fail_pct:5.1f}%)")

    print(f"\n--- By Extension (tool calls) ---")
    for ext, count in sorted(ext_calls.items(), key=lambda x: -x[1]):
        fails = ext_fails[ext]
        fail_pct = fails / count * 100 if count else 0
        print(f"  {ext:<12s} {count:>4d}   fail: {fails:>3d} ({fail_pct:5.1f}%)")

    # Pivot table
    all_modes = sorted(mode_calls.keys(), key=lambda m: -mode_calls[m])
    all_exts = sorted(ext_calls.keys(), key=lambda e: -ext_calls[e])

    col_w = 12
    ext_w = max(12, *(len(e) for e in all_exts))

    print(f"\n--- Extension × Mode (tool calls / failures) ---")
    header = f"  {'extension':<{ext_w}s}" + "".join(f" {m:>{col_w}s}" for m in all_modes) + f" {'total':>{col_w}s}"
    print(header)
    print(f"  {'-'*(len(header)-2)}")
    for ext in all_exts:
        row = f"  {ext:<{ext_w}s}"
        row_total = 0
        row_total_f = 0
        for m in all_modes:
            v = mode_ext_calls.get((m, ext), 0)
            vf = mode_ext_fails.get((m, ext), 0)
            row_total += v
            row_total_f += vf
            cell = f"{v}" if vf == 0 else f"{v} ({vf}✗)"
            row += f" {cell:>{col_w}s}"
        cell = f"{row_total}" if row_total_f == 0 else f"{row_total} ({row_total_f}✗)"
        row += f" {cell:>{col_w}s}"
        print(row)
    # totals row
    print(f"  {'-'*(len(header)-2)}")
    row = f"  {'TOTAL':<{ext_w}s}"
    grand = 0
    grand_f = 0
    for m in all_modes:
        v = sum(mode_ext_calls.get((m, ext), 0) for ext in all_exts)
        vf = sum(mode_ext_fails.get((m, ext), 0) for ext in all_exts)
        grand += v
        grand_f += vf
        cell = f"{v}" if vf == 0 else f"{v} ({vf}✗)"
        row += f" {cell:>{col_w}s}"
    cell = f"{grand}" if grand_f == 0 else f"{grand} ({grand_f}✗)"
    row += f" {cell:>{col_w}s}"
    print(row)


if __name__ == "__main__":
    main()
