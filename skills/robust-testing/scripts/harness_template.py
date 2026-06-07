#!/usr/bin/env python3
"""
Fuzz + invariant + swarm harness — a fill-in-the-blanks template.

This is the workhorse pattern from references/fuzz-invariant-harness.md, made
runnable. It's written in Python for zero-setup readability, but it's the same
skeleton in any language — port it directly to C / Go / Rust / TypeScript.

What it gives you out of the box:
  - a SEEDED, reproducible RNG (the seed is printed; replay by passing it back)
  - SWARM testing: each run enables a random SUBSET of operations, and we do
    MANY short runs rather than one long one (see references/swarm-testing.md)
  - random operations through the PUBLIC API, run in lockstep against a simple
    REFERENCE implementation that "always tells the truth"
  - INVARIANT checks after every operation, plus a full cross-check at the end
  - a replayable failure: on mismatch it prints the exact seed to reproduce

How to adapt it (five edits):
  1. Replace `SystemUnderTest` with your real implementation (or import it).
  2. Replace `Reference` with the dumbest obviously-correct version you can
     write (a dict, a sorted list, a naive O(n^2) algorithm).
  3. List your API operations in OPERATIONS; each returns a value so the two
     implementations can be compared on every call.
  4. Strengthen check_invariants() with everything that must always hold.
  5. Bias gen_key()/gen_val() toward collisions and boundaries (N-1, N, N+1
     around any threshold your code switches behavior at).

Run:
  python harness_template.py                  # random seed_base, prints it
  python harness_template.py 12345            # fixed seed_base (reproducible)
  python harness_template.py 12345 5000 400   # seed_base, num_runs, ops/run
  python harness_template.py 777 1 200        # replay ONE failing run (seed 777)

To watch it catch a bug, set BUG = True below and run it.
"""

from __future__ import annotations

import random
import sys

# Flip this to True to watch the harness detect an injected bug + print a seed.
BUG = False


# ── 1. The system under test ────────────────────────────────────────────────
# REPLACE this with your real implementation. This toy key-value store stands in
# so the template runs end-to-end.
class SystemUnderTest:
    def __init__(self) -> None:
        self._d: dict = {}

    def put(self, k, v):
        self._d[k] = v
        return True

    def delete(self, k):
        if k in self._d:
            del self._d[k]
            return True
        return False

    def get(self, k):
        return self._d.get(k, None)

    def size(self):
        # The injected bug: miscount size once the structure is non-empty.
        return len(self._d) + (1 if BUG and self._d else 0)

    def items(self):
        return dict(self._d)


# ── 2. The reference: dead-simple, obviously correct ────────────────────────
class Reference:
    def __init__(self) -> None:
        self._d: dict = {}

    def put(self, k, v):
        self._d[k] = v
        return True

    def delete(self, k):
        if k in self._d:
            del self._d[k]
            return True
        return False

    def get(self, k):
        return self._d.get(k, None)

    def size(self):
        return len(self._d)

    def items(self):
        return dict(self._d)


# ── 3. Input generation: bias toward collisions + probe boundaries ──────────
# A SMALL key space makes duplicate keys frequent, which exercises the
# overwrite/delete paths far more than unique random keys ever would.
def gen_key(rng: random.Random):
    return rng.randint(0, 32)


def gen_val(rng: random.Random):
    # Oversample edge values; most bugs live at 0 / -1 / max / min.
    return rng.choice([0, -1, 1, 2**31 - 1, -(2**31), rng.randint(-1000, 1000)])


# ── 4. The operations, exercised through the public API ─────────────────────
# Each op applies the SAME action to SUT and reference and returns both results.
def op_put(sut, ref, rng):
    k, v = gen_key(rng), gen_val(rng)
    return sut.put(k, v), ref.put(k, v)


def op_delete(sut, ref, rng):
    k = gen_key(rng)
    return sut.delete(k), ref.delete(k)


def op_get(sut, ref, rng):
    k = gen_key(rng)
    return sut.get(k), ref.get(k)


OPERATIONS = {
    "put": op_put,
    "delete": op_delete,
    "get": op_get,
}


# ── 5. Invariants that must hold no matter what ─────────────────────────────
def check_invariants(sut, ref) -> None:
    assert sut.size() == ref.size(), f"size mismatch: {sut.size()} != {ref.size()}"


def run(seed: int, n_ops: int) -> None:
    """One short run: pick a random op subset, then drive it for n_ops steps."""
    rng = random.Random(seed)

    # SWARM: enable a random non-empty subset of operations for THIS run. A run
    # that enables put but not delete fills the structure immediately; uniform
    # put/delete would hover near empty forever and never stress it.
    names = list(OPERATIONS)
    enabled = [n for n in names if rng.random() < 0.5] or [rng.choice(names)]

    sut, ref = SystemUnderTest(), Reference()

    for i in range(n_ops):
        name = rng.choice(enabled)
        r_sut, r_ref = OPERATIONS[name](sut, ref, rng)
        assert r_sut == r_ref, f"op {i} ({name}) disagreed: SUT={r_sut!r} REF={r_ref!r}"
        check_invariants(sut, ref)

    # Final cross-check: the whole contents must match the reference.
    assert sut.items() == ref.items(), "final contents mismatch"


def main() -> None:
    args = sys.argv[1:]
    seed_base = int(args[0]) if len(args) > 0 else random.randrange(2**63)
    num_runs = int(args[1]) if len(args) > 1 else 2000
    n_ops = int(args[2]) if len(args) > 2 else 200
    print(f"seed_base={seed_base} runs={num_runs} ops/run={n_ops} bug={BUG}")

    for r in range(num_runs):
        seed = seed_base + r
        try:
            run(seed, n_ops)
        except AssertionError as e:
            print(f"FAIL on seed {seed}: {e}")
            print(f"replay this run:  python {sys.argv[0]} {seed} 1 {n_ops}")
            raise SystemExit(1)

    print(f"OK — {num_runs} runs x {n_ops} ops, all invariants held")


if __name__ == "__main__":
    main()
