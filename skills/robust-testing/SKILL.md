---
name: robust-testing
description: >-
  Write tests that actually find bugs, not tests that just confirm the happy
  path. Use this whenever you're about to write or improve tests — especially
  for data structures, parsers, encoders/decoders, serializers, allocators,
  state machines, caches, or any library/API with a simple interface hiding a
  complicated implementation. Trigger it when the user asks for "thorough",
  "serious", "robust", or "good" tests, mentions fuzzing, stress testing,
  property-based testing, swarm testing, mutation testing, or invariants, or
  when correctness genuinely matters and a handful of example-based unit tests
  clearly won't be enough. The default instinct — a few unit tests with
  hardcoded expected values — is exactly what this skill exists to override.
---

# Robust Testing

## Why this skill exists

Left to their own devices, LLMs (and most engineers under time pressure) write
the same kind of test: call a function with a hand-picked input, assert it
equals a hand-picked output, repeat three or four times. These tests document
behavior and catch gross regressions, but they almost never find the bug that
takes down production — because the author already imagined every input they
test, and bugs live in the inputs nobody imagined.

This skill captures a different philosophy, drawn primarily from Salvatore
Sanfilippo (antirez, creator of Redis), whose software is famously stable and
who tests in a way he himself calls "eccentric" relative to industry norms. The
techniques are in the training data, but a naive prompt like "write tests for
this" essentially never produces them. They have to be asked for on purpose —
that's the whole point of this skill.

The mental shift, in one line: **stop asserting that specific inputs produce
specific outputs; start generating huge numbers of inputs and asserting that
invariants always hold.**

## The core principles

Read these before writing a single test. They determine everything else.

1. **Implementation first, then tests.** Don't do TDD here. You discover where
   the bugs will actually hide *while writing the implementation* — which states
   are fragile, which boundaries are awkward, where two subsystems rub against
   each other. Tests written before that discovery just encode your initial
   assumptions. Write the code, notice where it feels precarious, then aim your
   tests at exactly those places. (If the user's own conventions mandate TDD,
   follow them — this is antirez's view, not a universal law.)

2. **Test through the public API, never internal components in isolation.** Once
   a data structure is embedded in a system, exercise it through the external
   interface, not via its private functions. This survives reimplementation: if
   you rewrite the internals, an API-level test stays valid because it never
   depended on the internal shape — and you're stressing the underlying
   implementation as a side effect anyway. The exception is a component
   developed standalone in its own repo, which carries its own brutal tests.

3. **Coverage counts states, not lines.** 100% line coverage routinely fools
   people into thinking they're done. What matters is how many *states* you
   reach and whether you hit the fragile ones at the limits. A test suite can
   touch every line and still never fill a buffer, never trigger a resize, never
   exercise the error path.

4. **Randomness is the multiplier — but uniform randomness has a fatal blind
   spot.** Exhaustively testing all states is impossible; random generation lets
   you cover vastly more. But naive uniform random testing tends to hover in the
   "boring middle" of the state space and never reach the extremes where bugs
   live (see swarm testing below). So you generate randomly *and* you bias the
   generator toward the fragile regions.

5. **Fast tests are the only tests that get run.** If a test takes half an hour,
   you'll avoid it, and so will an AI agent iterating on the code. Brutal, fast
   tests become guardrails: the agent can reject its own breaking change because
   the suite goes red in seconds. Slowness is a correctness risk, not just an
   annoyance.

6. **Tests exist to remove fear.** The deepest reason to test is so you can keep
   changing the software without treating it as "a crystal vase that shatters if
   you brush it." Code you're afraid to touch is dead code. A strong suite is
   what keeps software alive.

## The workhorse: fuzz + invariant testing through the API

This is the technique to reach for first, and it covers the majority of cases.
The shape is always the same:

- A **seeded RNG living inside the test** so every run is fully reproducible
  (print the seed; on failure you replay it exactly).
- A loop performing **random operations through the public API**.
- After each operation (or at the end), **check invariants** — properties that
  must hold no matter what. The strongest invariant is a **reference
  implementation**: a dead-simple, obviously-correct version of the same thing
  (a plain hash table, a sorted array, a naive O(n²) algorithm) running in
  lockstep, with every result compared.

Crucially, **don't store the expected values in a separate bookkeeping
structure and compare against that** — that just tests your bookkeeping. Trust
the implementation as the source of truth, then verify it against the
independent reference and against structural invariants.

The hard part isn't generating inputs — it's deciding *what must be true of the
output*. A reference implementation is the strongest property, but it's not the
only one: round-trips, invariants, idempotence, commutativity, and metamorphic
relations all catch bugs without an oracle. For the full catalogue of property
shapes (Wlaschin's checklist, Hughes' graded five, metamorphic testing) and how
to pick — plus the one rule that matters most when *you*, an agent that can see
the implementation, are writing properties: **derive them from the spec and the
callers, never from the implementation, and never from "what you think is
true"** — read **`references/choosing-properties.md`**.

For the full annotated pattern — including key/input generation modes, boundary
probing, biasing the generator, sanitizers, and a complete real example
(antirez's `rax` radix-tree test) — read **`references/fuzz-invariant-harness.md`**.
A runnable starter (seeded RNG + swarm + reference lockstep + replay, with a
caught-bug demo) is bundled at **`scripts/harness_template.py`** — copy and adapt
it rather than writing the loop from scratch.

Don't hand-roll this when a library gives it to you. Every major ecosystem has a
property-based / model-based testing library that provides the random-ops harness,
lockstep reference checking, automatic shrinking, and seed replay for free — and
the model won't reach for it by default. For the right library and entry point in
Python, TypeScript/React, Go, and .NET — and the cross-cutting power features the
model forgets (distribution checking, targeted search, the failure database,
async scheduling) — see **`references/frameworks.md`**.

For the craft that makes a property suite actually bite — writing generators that
*construct rather than filter*, biasing toward the edges, **measuring the
distribution so you can prove the generator reaches the states you care about**,
how shrinking really works (and its pitfalls), and the PBT-specific anti-patterns
(fake oracles, weak properties, flaky-breaks-shrinking, float equality) — read
**`references/pbt-craft.md`**.

The essentials to internalize now:

- **Push N to the limits.** Wherever there's an N (elements, depth, length,
  capacity), drive it to extremes — 10M, 100M. Bugs cluster at scale.
- **Probe boundaries precisely.** If a structure switches behavior at a
  threshold (e.g. a node compresses segments up to 256 bytes), feed it inputs of
  exactly 255, 256, and 257 to catch the switch — even through a black-box API.
- **Bias toward code-exposing inputs.** Purely random bytes are a trap for many
  systems. For a compressor, random data is nearly incompressible and exercises
  almost no code; generate inputs likely to be compressible and over-represent
  the encodings with special cases. For a parser, purely random strings get
  rejected immediately at byte one — instead take *valid* inputs and corrupt
  them (flip bytes/bits), or splice two valid inputs together ("crossover").
- **Run under sanitizers.** Compile with AddressSanitizer / UBSan or run under
  Valgrind, and fire a leak check after stressing through the API. Correct
  output *and* no leaks means the whole chain is validated.
- **For lossy/transform code, compare with a tolerance, not byte-exact.** A JPEG
  encoder's output should differ from the reference by at most some metric;
  hardcoded expected bytes break the moment the implementation legitimately
  improves.

## Complementary techniques

These layer on top of the fuzz harness. Pull each one in when its trigger fires.

### Swarm testing — when uniform random isn't finding bugs

The single most important fix for fuzzing that "runs billions of operations and
finds nothing." If your API has several operations and you call them all with
uniform probability every run, the *mix* becomes a memoryless random walk that
exponentially avoids the extreme states. The classic failure: insert/remove at
50/50 keeps a container near its starting size forever, so it never fills, so
the eviction/resize/overflow path never runs.

The fix is almost insultingly simple: **for each run, randomly pick a *subset*
of the operations to enable and disable the rest.** A run that happens to enable
"insert" but not "remove" fills the container immediately. Do many short runs
with varied subsets rather than one giant run.

Reach for this whenever: you have ≥3 API operations, any operation can undo
another (push/pop, insert/remove, alloc/free, connect/disconnect), or fuzzing
has gone quiet despite huge op counts. The technique, the random-walk intuition,
the active-vs-passive suppression distinction, an implementation sketch, and a
per-domain table of "features" to toggle are in **`references/swarm-testing.md`**.

### Stateful tests can destroy real data — isolate first

Stateful fuzz/swarm tests often create, update, and delete aggressively. Treat
their setup as part of the safety property. Before writing the first operation:

- Use an isolated database, schema, namespace, tenant, temp directory, or in-memory
  fixture. Do **not** default a destructive swarm harness to the developer's normal
  database just because that is what existing tests use.
- If the harness needs cleanup, scope it narrowly to test-owned rows/files and make
  the test database name obvious (for example `*_test` / `*_test_fast`).
- Wire the make/CI target so it creates or selects the isolated resource explicitly;
  never rely on a caller remembering to set an environment variable.
- For filesystem operations, use temp dirs and generated paths. Do not point a fuzz
  delete/rename/cleanup test at production-like image/archive directories.

This is especially important for repository/API-level tests, because the whole
point is to drive real public operations — including destructive ones.

### Prove the harness bites

A property suite is only credible if you have evidence it fails when the code is
wrong. After building the harness:

- Keep every discovered counterexample as a permanent regression test or explicit
  example near the property that found it.
- Run one small manual mutation when practical: flip `<` to `<=`, remove timezone
  normalization, break idempotency, skip one delete result, etc. Confirm the new
  suite fails, then revert the mutation.
- If a mutation survives, either the property is too weak, the generator never
  reaches the state, or the behavior was not actually specified. Fix the property
  or document the gap.

This lightweight "does it bite?" check is not a replacement for full mutation
testing, but it catches the common failure mode where a fuzz test does lots of
work while asserting almost nothing.

### Cross-implementation tests catch drift, not shared misconceptions

Comparing two implementations (for example client JS vs backend Python) is a
strong metamorphic test when the risk is accidental drift: one port changes, a
timezone rule diverges, or a rounding fix lands on only one side. But it is not a
true oracle. If both implementations encode the same conceptual bug, they will
agree while being wrong. Pair cross-implementation checks with at least a few
spec-derived examples, physical/math invariants, or an independent reference when
correctness matters.

### Mutation testing — to find out whether your tests are any good

Fuzz tests can give false confidence too. Mutation testing answers "would my
suite actually catch a bug?" by deliberately introducing small faults
(mutations) into the code — flip a `<` to `<=`, a `+` to `-`, delete a line —
and checking whether the tests fail. A mutant your tests still pass ("survives")
marks a gap: a line that's covered but not actually *verified*.

Reach for this when the user asks how good the tests are, when correctness is
critical and you want evidence beyond coverage, or after building a fuzz harness
to confirm it bites. Tools and workflow per language are in
**`references/mutation-testing.md`**.

### Agentic testing — for systems hard to pin down with fixed tests

The emerging approach for software whose behavior depends on timing,
tool-calling, distributed/replication effects, or natural-language interaction —
things fixed tests struggle to cover. Instead of (only) a static suite, point an
LLM agent at the system as a virtual QA engineer via a `testing.md` prompt: it
invents use cases, scales load progressively, checks coherence across replicas,
and probes states no fixed test enumerated. A second, independent agent verifies
whether flagged issues are real, filtering false positives. See
**`references/agentic-testing.md`**.

### Deterministic simulation testing — when the bug is an interleaving, not an input

For concurrent and distributed systems — databases, queues, consensus,
replication, storage engines, sync engines — the bug usually isn't a function of
the input; it's a function of *order, timing, and failure*. DST applies this
skill's principles (seeded reproducible randomness, biasing toward fragile
states, invariants over examples) to the whole system: randomize the *schedule
and faults* (not just the data) on a deterministic runtime, so any failure
replays bit-for-bit from a seed. It adds `sometimes`/liveness assertions
(checking the good thing *does* happen, not just that nothing bad does) and is
the home of `BUGGIFY`, FoundationDB, and TigerBeetle's simulator. fast-check's
`fc.scheduler` is small-scale DST inside a property test. See
**`references/deterministic-simulation-testing.md`**.

## How to apply this in a session

1. Identify what's under test and which principle dominates. A pure data
   structure / parser / codec → fuzz + invariant harness is the spine. A
   stateful system with many operations → fuzz + **swarm**. A concurrent /
   distributed / storage system → **deterministic simulation**. A timing/LLM
   system → consider **agentic**.
2. Write (or confirm) the implementation first; note the fragile spots out loud.
3. Decide *what to assert* before how to generate — reach for a reference model
   first, then round-trip / invariant / metamorphic relations. See
   `choosing-properties.md`.
4. Build the fuzz harness: seeded RNG, random ops through the API, a reference
   implementation and/or invariants, input generation that *constructs* (not
   filters) and biases toward edges, sanitizers on. Keep it fast.
5. If the API has competing operations, make it a swarm harness from the start.
6. Measure the distribution — confirm the generator actually reaches the fragile
   states, not just the boring middle (`pbt-craft.md`). Add assertions or
   statistics checks for the categories you care about (edge lengths, invalid
   inputs, duplicate IDs, DST zones, wrap-midnight windows, resize thresholds).
7. Wire the suite into the project: local make/npm targets, dependency install,
   CI path filters, and a safe isolated database/temp resource for destructive
   stateful tests.
8. Optionally validate the suite with mutation testing.
9. Always print the seed and make failures replayable; promote each shrunk
   counterexample to a permanent example test.

When you write the tests, **say which techniques you're using and why** — the
user is often learning this approach, and the reasoning is half the value.

For curated talks, blogs, books, exemplar repos, and the field's war stories
(AUTOSAR, Dropbox, AWS, the Anthropic agentic-PBT study), see
**`references/resources.md`**.
