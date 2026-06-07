# PBT craft — generators, shrinking, distribution, and the pitfalls

`choosing-properties.md` tells you *what to assert*. This file is about making
the test actually *bite*: writing generators that reach the bugs, understanding
the shrinking that turns a 5,000-element failure into a 2-element repro, proving
your generator goes where you think, and avoiding the failure modes that make a
green property suite a false comfort.

Read this when you're writing the generator, when a property "runs forever and
finds nothing," or when a counterexample looks wrong.

## Table of contents
- [Construct, don't filter](#construct-dont-filter)
- [Bias toward the edges (uniform hovers in the boring middle)](#bias-toward-the-edges-uniform-hovers-in-the-boring-middle)
- [Measure the distribution — prove the generator goes where you think](#measure-the-distribution--prove-the-generator-goes-where-you-think)
- [Targeted PBT — let the search hill-climb to the extremes](#targeted-pbt--let-the-search-hill-climb-to-the-extremes)
- [Shrinking — the feature that makes PBT usable](#shrinking--the-feature-that-makes-pbt-usable)
- [The failure-example database — turn every bug into a regression](#the-failure-example-database--turn-every-bug-into-a-regression)
- [Async / race-condition scheduling](#async--race-condition-scheduling)
- [The pitfalls table](#the-pitfalls-table)

## Construct, don't filter

The dominant generator mistake — and the most-repeated lesson from practitioners
— is **generate-then-reject**: lean on `assume` / `==>` / `suchThat` / `filter`
to throw away inputs that don't satisfy a precondition. It's slow, it skews your
distribution, and it interacts badly with shrinking. Three failure modes:

- **It wastes the budget.** If 1% of random inputs are valid, you do 100× the
  work per real test.
- **It starves the run.** Frameworks abort after too many rejects (QuickCheck
  "Arguments exhausted after 97 tests"; Hypothesis "filtered too much" health
  check). Your property effectively ran a handful of times, not the thousands
  you assume.
- **It fights the shrinker.** The shrinker drives values toward the simplest
  case (zeros, empty), which often *fails the filter*, so minimization gives up
  or stalls. This is the single most-cited Hypothesis frustration, and it's
  almost always a generate-then-filter design.

The fix is to **build valid inputs directly**:

```
# BAD: generate random lists, keep the sorted ones — almost none are sorted
ordered(xs) ==> ordered(insert(x, xs))

# GOOD: generate ordered lists by construction
xs = cumulative_sum(list_of(non_negative_int))   # prefix sums are sorted
assert ordered(insert(x, xs))
```

The pattern generalizes: generate a **valid date** by picking a year, then a
month, then a day within *that month's* length — never `(y, m, d)` uniformly
with a "reject Feb 30" filter. Generate a **valid AST / well-typed term** by
recursing on the grammar so every node is well-formed. Generate a **permutation**
by shuffling a base list; a **DAG** by only adding edges `i → j` with `i < j`. A
light, bounded `filter` for rare local fix-ups is fine — *construct the bulk,
filter only the residue, never filter the bulk*.

## Bias toward the edges (uniform hovers in the boring middle)

This is the generator-side of the same insight that motivates swarm testing
(`swarm-testing.md`): uniform-random generation spends almost all its time in the
unremarkable center of the input space. A uniform list length sits near its mean
and rarely hits 0 or huge; random strings essentially never collide; random ints
cluster far from `0`, `-1`, `MAX`. Bugs live at the edges, so push the generator
there on purpose:

- **Weighted choice** to over-represent special values:
  `frequency([(3, edge_values), (7, full_range)])`, `oneof([...])`.
- **Small alphabets to force collisions.** Drawing characters from `"ab"`
  instead of all of Unicode makes duplicate keys, repeated substrings, and hash
  collisions *common* — essential for testing maps, dedup, parsers. (This is the
  generator analogue of the rax test's small-character-set key mode.)
- **Sizing knobs** to reach genuinely large structures without making *every*
  case huge: `sized` (QuickCheck), `Range.exponential`/`Gen.scale` (Hedgehog),
  the `size`/`max_size` settings elsewhere.
- **Oversample the values with dedicated code paths:** `0`, `1`, `-1`, max/min,
  max±1, empty, one-element, NaN/±inf/−0.0, the NULL-encoded case.

## Measure the distribution — prove the generator goes where you think

The silent killer of PBT: a generator that *can* produce an edge case but does
so essentially never. The suite is green, runs millions of cases, and never
once exercised the branch you cared about. This is the feedback loop the model
almost never adds, and it's the antidote to "the fuzzer found nothing." It also
operationalizes the skill's core principle that *coverage counts states, not
lines* — you measure which states you actually reached.

Every framework can report and even *enforce* the distribution:

| Capability | Python (Hypothesis) | TS (fast-check) | Java (jqwik) | Haskell (QuickCheck / Hedgehog) |
|---|---|---|---|---|
| Print distribution | `event(label)` + `--hypothesis-show-statistics` | `fc.statistics(arb, classify, {numRuns})` | `Statistics.collect(...)`, `@StatisticsReport` | `collect` / `label` / `classify` |
| **Enforce** coverage (fail if too rare) | `target()` + manual check | — | `Statistics.coverage(c -> c.check(v).percentage(p -> p > 20.0))` | `cover` + `checkCoverage` / `cover` + `withConfidence` |

```python
# Hypothesis: tag cases, then run pytest --hypothesis-show-statistics
@given(st.lists(st.integers()))
def test_dedup(xs):
    event("empty" if not xs else "has-dupes" if len(set(xs)) < len(xs) else "all-unique")
    ...
# If "has-dupes" is 0.3% of cases, your dedup logic is barely tested — fix the generator.
```

```haskell
-- QuickCheck: make adequate coverage a hard, statistically-sound requirement
prop xs = checkCoverage $
  cover 30 (not (null xs))    "non-empty" $
  cover 10 (hasDuplicates xs) "has dupes" $
    dedupCorrect xs
-- The run FAILS (not just warns) if it can't reach 30%/10%, using a sequential
-- test that runs more cases as needed so it won't flake on an unlucky sample.
```

jqwik's `Statistics.coverage(...)` likewise turns inadequate distribution into a
*red test*, not just a printout — the strongest form. Rule of thumb: **if a
branch matters, add a coverage check that it actually occurs at a meaningful
rate.** Don't trust that "the generator can produce it."

## Targeted PBT — let the search hill-climb to the extremes

Sometimes the bug lives at an extreme that random sampling reaches only by
luck — maximum recursion depth, the largest allocation, the deepest queue, the
worst-case running time. **Targeted property-based testing** turns the blind
random walk into guided hill-climbing: you report a numeric metric and the
framework mutates inputs to *maximize* it. This is the framework-native way to
honor the skill's "push N to the limits" principle.

```python
# Hypothesis: steer the search toward the worst case
@given(st.lists(st.integers()))
def test_balance(xs):
    tree = build(xs)
    target(tree.height, label="height")   # search hill-climbs toward tall trees
    assert tree.height <= 2 * log2(len(xs) + 1)
```

`hypothesis.target()` is the built-in; the idea originated in PropEr's targeted
testing (search/simulated-annealing toward a user-supplied utility). When you'd
otherwise write "I hope a random run happens to build a degenerate structure,"
reach for this instead.

## Shrinking — the feature that makes PBT usable

A random input big enough to trip a bug carries a mountain of irrelevant
structure. **Shrinking** is the automatic search for the smallest, simplest
input that still fails — the difference between "here's a 5,000-element list that
crashes" and "`[0, 0]` crashes." For stateful tests it deletes commands from the
failing sequence, so a 100-step trace collapses to the 2 steps that matter. It
is the single most valuable feature of a PBT library, and it's worth
understanding because its failure modes will bite you.

**Three architectures, and why it matters which you have:**

- **Type-based / manual (classic QuickCheck).** Generation and shrinking are
  *separate* functions; the `shrink` for a type is independent of how a value was
  generated. Three consequences: you can *forget* it (the default is "no
  shrinking"); you can write it *wrong* so it shrinks an even number to an odd
  one, drifting off your generator's contract and reporting a *different* bug;
  and it *doesn't compose* — shrinking can't flow through a `map`/`fmap`, so
  every derived generator needs its own hand-written shrinker. (When you *do*
  write a good one, it can beat the alternatives, because it knows domain
  structure the framework can't infer.)

- **Integrated (Hedgehog, test.check).** The generator *is* the shrinker: it
  yields a lazy tree of (value, smaller values). Shrinking composes through
  `map`/`fmap` automatically and **always respects the generator's invariants**
  — a `filter`ed generator only ever shrinks to values that still pass the
  filter. The even-becomes-odd bug is impossible by construction.

- **Internal / bytewise (Hypothesis).** The generator is a function from a byte
  stream to a value; the framework shrinks the *byte stream* and re-runs the
  generator, so every shrink is by-construction valid. Same family as integrated
  shrinking — both minimize the *input to the generator*, not the value — which
  is why both respect `assume`/`filter` and why the same mechanism powers the
  failure database below.

**The catch — there is no free shrinker.** Integrated shrinking composes well
*applicatively* but **shrinks poorly through monadic `bind` / dependent
generators**: once it starts shrinking the second draw it won't go back to
re-shrink the first. Generating a list by drawing a length and *then* the
elements entangles the two, and you land on junk like `[0,1,0]` instead of the
minimal `[1,0]`. Practical guidance:

- **Prefer applicative composition** (`(,) <$> genA <*> genB`) over monadic
  `do`/`>>=`/`flatMap` when you don't truly need dependency — both components
  shrink independently.
- **For genuinely dependent generators, use the framework's built-in
  combinators** (`Gen.list`, `Gen.recursive`, `frequency`) — they re-implement
  the correct shrink interleaving internally. A hand-rolled dependent generator
  inherits the bad `bind` behavior.
- **Put the simplest alternative first** in `choice`/`frequency`/`element` —
  many frameworks shrink toward the head of the list, so `[base, recursive]`
  shrinks toward the base case.
- **Guard recursion with the size parameter** so generators terminate and shrink
  well: `Gen.recursive` (Hedgehog) halves the size each step and falls back to
  base cases; in QuickCheck use `sized` with an explicit depth decrement.

**A non-deterministic property makes shrinking lie.** If the property's pass/fail
isn't a deterministic function of the input, the shrinker chases noise and the
"minimal" case may not reproduce. Hypothesis raises `FlakyFailure` when a
replayed input no longer fails. Fix the property's determinism (freeze the
clock, seed the RNG, sort before comparing sets) rather than fighting the
shrinker; disable shrinking only for irreducibly expensive or non-deterministic
properties while you debug.

## The failure-example database — turn every bug into a regression

Because internal/integrated shrinking works on the input-to-the-generator, a
found failure can be serialized and replayed. Hypothesis does this
automatically: it writes minimized failing examples to `.hypothesis/examples/`
and replays them *first* on the next run, so a bug, once found, keeps reproducing
deterministically until it's fixed — a free ratchet. Practical moves:

- **Cache `.hypothesis/` in CI** (and consider `MultiplexedDatabase` /
  `GitHubArtifactDatabase`) so a failure found on one machine replays on every
  machine and on developer laptops.
- **Pin the shrunk counterexample as a permanent example test** (`@example` in
  Hypothesis, `examples:` in fast-check, seed corpus `f.Add` in Go). Property
  tests and concrete known-answer tests are complementary, not substitutes — the
  counterexample shrinking hands you is exactly the example test worth keeping.
- Frameworks without a DB still print a **seed** (and fast-check a `path`) — log
  it on every failure so any run is replayable, exactly as the fuzz harness
  insists.

## Async / race-condition scheduling

For concurrent code, the bug is a specific *interleaving*, and a flaky retry will
never reliably reproduce it. Some frameworks let you make the schedule itself the
generated thing — deterministically permuting the order promises/tasks resolve,
then shrinking to a minimal failing interleaving:

- **fast-check `fc.scheduler()`** — wrap promises with `s.schedule(...)`, drive
  with `s.waitAll()`/`s.waitOne()`, and fast-check explores interleavings and
  shrinks the schedule. `scheduledModelRun` combines this with model-based
  testing (random command sequences *under* random interleavings).
- **PropEr `parallel_commands` / `run_parallel_commands`** — the Erlang ancestor:
  run command sequences concurrently and check the results are linearizable.
- **Rust AWS Shuttle, .NET Microsoft Coyote** — concurrency-interleaving
  explorers in the same spirit.

This is the bridge to deterministic simulation testing, where the *entire*
environment (clock, network, faults) becomes the generated, replayable input —
see `deterministic-simulation-testing.md`.

## The pitfalls table

| Pitfall | Smell | Fix |
|---|---|---|
| **Fake oracle** (property re-implements the code) | the check looks like a second copy of the function; would still pass if you pasted in the production logic | use a *different-in-kind* reference (simpler/slower), or a relationship (round-trip, invariant, metamorphic) — see `choosing-properties.md` |
| **Weak / trivial property** | passes for `return []`, `return None`, or any shape-correct garbage | add a *characterizing* check (sortedness **and** permutation); imagine the buggy impl that should fail it |
| **Property encodes the same misconception as the code** | property and code written together from the same reading of the spec | derive the property from an *independent* source — the written spec, a reference, a maths law, a different person |
| **The filtering trap** | "gave up / exhausted / filtered too much"; few cases actually ran | construct valid inputs; put unavoidable `assume`s as early/cheap as possible |
| **Bad distribution** | never see empty/huge/duplicate/boundary cases in failures | measure with `classify`/`collect`/coverage checks; bias the generator |
| **Slow generator / property** | timeouts, `deadline` flakiness, you lowered `max_examples` to cope | make generation cheap; move setup out of the property; raise/disable `deadline` deliberately (note filtered cases don't count toward `max_examples`) |
| **Flaky / non-deterministic property** | same input sometimes passes; shrunk case won't reproduce; failure mentions time/order/hashing | freeze clock & RNG, register PRNGs, sort before comparing sets, never assert dict/set iteration order — flakiness *corrupts shrinking and the replay DB* |
| **Float exact-equality** | `==` on floats; asserting associativity/distributivity (which floats don't satisfy) | compare with a tolerance (`isclose`/`approx`); assert only laws that hold (commutativity, monotonicity, bounds) |
| **No example tests** | only properties; a literal known-answer regression slips through | keep a handful of concrete cases; promote every counterexample to one |
| **False confidence from green** | "all green, must be correct" | green means "none of my stated properties was violated in N tries" — it only tests what you thought to assert; always investigate the *minimized* counterexample |

Sources: David R. MacIver / hypothesis.works (shrinking internals, performance,
flaky failures); Well-Typed (*Integrated vs Manual Shrinking*); Hedgehog docs;
the QuickCheck manual; Hypothesis docs (`target`, statistics, example database,
stateful); fast-check docs (`statistics`, scheduler); jqwik user guide;
Hacker News practitioner threads. Curated links in `resources.md`.
