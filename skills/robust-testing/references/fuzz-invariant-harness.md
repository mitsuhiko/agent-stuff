# Fuzz + Invariant Harness — the full pattern

This is the workhorse technique. Read this when you're building the actual test.

## Table of contents
- [The skeleton](#the-skeleton)
- [Seeded, reproducible randomness](#seeded-reproducible-randomness)
- [The reference implementation](#the-reference-implementation)
- [Input generation modes](#input-generation-modes)
- [Biasing the generator toward bugs](#biasing-the-generator-toward-bugs)
- [Boundary probing](#boundary-probing)
- [Clearing fuzzing obstacles](#clearing-fuzzing-obstacles)
- [Invariants beyond the reference](#invariants-beyond-the-reference)
- [Sanitizers and leak checks](#sanitizers-and-leak-checks)
- [Lossy / transform code](#lossy--transform-code)
- [Worked example: antirez's rax radix-tree test](#worked-example-antirezs-rax-radix-tree-test)

## The skeleton

Every fuzz+invariant test has the same shape, in any language:

```
seed = pick_or_read_seed()
print("seed:", seed)            # so a failure is replayable
rng = SeededRNG(seed)

system   = new_real_implementation()
reference = new_simple_reference()   # the "always tells the truth" version

for i in range(N):
    op = rng.choice(operations)      # see swarm-testing.md to pick a SUBSET
    args = generate_args(rng)        # biased + boundary-probing, see below

    r1 = apply(op, system, args)
    r2 = apply(op, reference, args)

    assert r1 == r2, f"mismatch at op {i}: {op}{args} -> {r1} vs {r2}"
    check_structural_invariants(system)

# final cross-check: iterate the whole system, compare to the reference
assert full_contents(system) == full_contents(reference)
assert no_leaks() and no_sanitizer_errors()
```

The discipline that makes this work: **the real implementation is the source of
truth during the run; you verify it against an independent reference and against
invariants — you do not pre-compute expected outputs and store them in a side
structure.** Storing expected results in a parallel dict and comparing only
tests your bookkeeping code, not the system.

A runnable version of this exact skeleton — seeded RNG, swarm subset selection,
reference lockstep, per-op invariant checks, and seed replay all wired up — is
bundled at **`scripts/harness_template.py`**. Copy it and make the five edits in
its header (drop in your real implementation and a dumb reference, list your
operations, strengthen the invariants); it runs with zero dependencies and
demonstrates a caught bug if you flip its `BUG` switch. Adapt it rather than
re-deriving the loop from scratch.

## Seeded, reproducible randomness

Put the RNG *inside the test* and seed it explicitly. A non-reproducible fuzz
failure is nearly useless — you need to replay the exact sequence to debug.

- Print the seed at the start of every run.
- On CI, either fix a seed (deterministic) or capture the random seed into the
  failure output so it can be reproduced locally.
- A common antirez trick: use a small dependency-free PRNG (he uses an RC4-based
  generator, `rc4rand`) so the test has zero reliance on the platform RNG and is
  byte-for-byte reproducible across machines.

## The reference implementation

The strongest invariant is a second, obviously-correct implementation of the
same contract, kept deliberately dumb:

- Radix tree / sorted set / ordered map → a plain hash table (for membership)
  plus a sorted array (for order).
- A fast algorithm → the naive O(n²) version.
- A custom serializer → round-trip through a trusted library and compare.
- A compressor → assert `decompress(compress(x)) == x` (the reference is
  *identity*).

Run both in lockstep and compare every result. When they disagree, you've found
either a bug or a spec ambiguity — both worth knowing.

## Input generation modes

Don't generate inputs one way. Different distributions reach different code.
antirez's rax test generates keys in *six* modes, each targeting different
structure:

| Mode | What it produces | What it stresses |
|---|---|---|
| `KEY_INT` | the integer as a decimal string | predictable, dense prefixes |
| `KEY_UNIQUE_ALPHA` | a bijective alphanumeric map of the int | many distinct children per node (wide fan-out) |
| `KEY_RANDOM` | fully random bytes up to maxlen | binary keys, arbitrary bytes incl. NUL |
| `KEY_RANDOM_ALPHA` | random alphanumeric string | realistic text keys |
| `KEY_RANDOM_SMALL_CSET` | random over a 4-char alphabet | high collision / shared prefixes (deep trees) |
| `KEY_CHAIN` | the character 'A' repeated i times | long single-branch chains (compression paths) |

The lesson generalizes: deliberately include a high-collision/small-alphabet
mode (forces deep nesting and shared prefixes), a wide-alphabet mode (forces
fan-out), a long-repetition mode (forces whatever "compression"/chaining your
structure does), and a raw-bytes mode (forces binary-safety).

## Biasing the generator toward bugs

Uniform-random input is often the *worst* generator because it exercises the
fewest interesting code paths:

- **Compression / encoding:** random bytes are nearly incompressible, so the
  interesting encodings never fire. Generate inputs likely to be compressible
  (runs, repeated substrings) and over-represent input shapes that have special
  encodings or more branches.
- **Parsers:** a purely random string is rejected at byte one. Instead:
  - take *valid* inputs and corrupt them (flip random bytes/bits),
  - splice two valid inputs at a chosen offset ("crossover"),
  - generate semi-valid inputs that are structurally plausible but wrong.
- **Special values:** over-sample the values with dedicated code paths. In rax,
  `NULL` values use a special encoding, so the test stores `NULL` ~1% of the
  time on purpose.
- **Numeric edges:** 0, 1, -1, max, min, max±1, empty, one-element.

## Boundary probing

When the implementation changes behavior at a threshold, hit it exactly — even
through a black-box API. rax compresses key segments up to 256 bytes per node,
so a good test feeds keys of length 255, 256, and 257 to catch the switch. Find
every such N in your code (buffer sizes, inline-vs-heap cutoffs, page sizes,
small-string optimizations) and probe `N-1, N, N+1`.

## Clearing fuzzing obstacles

Sometimes the harness runs millions of iterations but coverage shows whole
regions of the code are never reached. The usual cause is a *gate* the generator
can't get past on its own — and the fix is to patch the system under test so
that, *in a fuzzing-only build*, the gate is removed while production behavior
stays untouched:

- **Checksums / hashes / magic-number validation.** Code that rejects input
  whose CRC or signature doesn't match forces the fuzzer to guess a valid
  checksum before any deeper code runs — astronomically unlikely. Skip or
  recompute the check in the fuzzing build so mutated inputs flow through.
- **Non-determinism that breaks replay.** Time-seeded PRNGs, `rand()`,
  wall-clock reads, environment or hostname lookups make the same input behave
  differently across runs — which defeats both the seed-replay you depend on and
  the shrinker (a "failure" that won't reproduce). Pin these to fixed values
  under fuzzing.
- **Strict validation early in the pipeline.** If most inputs die at a
  front-door validator, the fuzzer burns its whole budget failing validation
  instead of exploring. Relax it under fuzzing — or better, *construct* valid
  inputs in the generator (see `pbt-craft.md`).

Gate the patches behind a compile-time flag so production is unaffected:
`#ifdef FUZZING_BUILD_MODE_UNSAFE_FOR_PRODUCTION` (the libFuzzer convention) in
C/C++, `cfg!(fuzzing)` in Rust. The trade-off: you may surface crashes that
can't happen in production (a checksum would have rejected the input) — weigh
that against the coverage you unlock. (Technique credit: Trail of Bits'
testing-handbook; see the hand-off under Sanitizers below.)

## Invariants beyond the reference

Even without a full reference, assert properties that must always hold:

- **Round-trip:** `decode(encode(x)) == x`; `deserialize(serialize(x)) == x`.
- **Count agreement:** size reported by the structure == count you inserted ==
  count the iterator returns.
- **Order:** an ordered iterator yields keys in sorted order (compare against a
  `qsort` of the inserted keys — exactly how rax verifies its iterator).
- **Idempotence / commutativity** where the contract claims them.
- **No crash, no leak** as a baseline invariant under all inputs.

## Sanitizers and leak checks

Correct output is only half the validation. Build and run under:

- **AddressSanitizer / UBSan** (`-fsanitize=address,undefined`) or **Valgrind**
  for C/C++/Rust-unsafe — catches OOB, use-after-free, UB the output never
  reveals.
- A **leak check after** stressing through the API: correct results *and* zero
  leaks means the whole alloc/free chain is sound.
- Consider an **OOM injection** mode if the code is meant to survive allocation
  failure: make `malloc` fail at controlled points and assert invariants still
  hold (rax has a dedicated `rax-oom-test.c` that does exactly this, checking the
  element count stays correct after each simulated OOM).

For the operational depth this skill deliberately doesn't reproduce — standing
up libFuzzer / AFL++ / cargo-fuzz, writing fuzz harnesses, configuring
ASan/UBSan and coverage analysis, building fuzzing dictionaries, constant-time
testing — Trail of Bits' **testing-handbook-skills** plugin
(`github.com/trailofbits/skills`, CC-BY-SA-4.0) is the best-maintained reference;
install it alongside this skill rather than reinventing it here.

## Lossy / transform code

For encoders that legitimately change data (JPEG, audio, downscaling), never
assert byte-exact expected output — it breaks the moment the implementation
improves. Instead:

- Compare against the reference with a **tolerance metric** (e.g. output differs
  by at most ε per pixel/sample).
- **Generate inputs dynamically** rather than shipping fixed fixtures: scale,
  blur, crop, and offset a base image; or synthesize fresh inputs. (antirez even
  interleaves images from a small fast diffusion model into a JPEG test, because
  pure-noise images all live in the same frequency band and never exercise the
  quantization paths that matter.)

## Worked example: antirez's rax radix-tree test

`github.com/antirez/rax`, file `rax-test.c` — the canonical specimen. It
contains, in one file:

1. **An embedded reference**: a plain chained hash table (`htNew/htAdd/htFind/
   htRem`) — "something that will always tell the truth."
2. **A seeded PRNG** (`rc4rand`) used for everything, so runs are reproducible.
3. **Six key-generation modes** (`int2key`, table above), including a Feistel
   network (`int2int`) to turn sequential integers into distinct random-looking
   keys with no repetition.
4. **`fuzzTest()`** — random insert/remove on both the rax and the hash table,
   asserting they agree on every operation's return value, then iterating the
   whole rax and confirming every key/value matches the hash table and the
   counts line up.
5. **`fuzzTestCluster()`** — a crash-only fuzzer that mimics Redis Cluster's
   hash-slot key usage, deliberately biasing toward a *common prefix* so a subset
   of keys gets hit repeatedly (stressing shared-prefix paths); no reference,
   the goal is purely to crash the tree or trip Valgrind.
6. **`iteratorFuzzTest()`** — inserts random keys into both the rax and a plain
   array, `qsort`s the array, then does a random seek (`==`, `>=`, `<=`, `>`,
   `<`, `^`, `$`) and walks forwards/backwards, asserting the iterator agrees
   with the sorted array at every step and on EOF.
7. **`rax-oom-test.c`** (sibling file) — injects allocation failures cycle by
   cycle and verifies the element count invariant survives every OOM.

Notice what's absent: there is **no isolated unit test of an internal rax
function**. Everything goes through the public API, cross-checked against a dumb
reference, driven by biased reproducible randomness, probed at boundaries, run
under a leak/OOM regime. That is the whole method.
