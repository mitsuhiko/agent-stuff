# Swarm Testing

Read this when an API has several operations, when any operation can undo
another, or when fuzzing runs huge op counts and finds nothing.

> Source: Groce, Zhang, Eide, Chen, Regehr, "Swarm Testing", ISSTA 2012
> (`users.cs.utah.edu/~regehr/papers/swarm12.pdf`), plus Will Wilson's talk
> on it. This file is the practical distillation.

## The one-sentence technique

For each test run, **randomly choose a subset of the available operations /
input features to enable, and disable the rest for that run.** Then do many
short runs with varied subsets, rather than one long run with everything
enabled.

The standard instinct is the opposite — find one "good" configuration that
includes as many features as possible and run it forever. Swarm deliberately
*omits* features, varying which ones are absent from each test. That variation is
the whole mechanism.

## Why uniform-everything fails

Internalize this intuition — it's how you recognize when to reach for swarm.

If you call every operation with uniform probability every run, the *mix* of
operations is a memoryless process. Take a container with `insert` and `remove`
at 50/50: the element count is a **1-D random walk**, which is exponentially
unlikely to drift far from where it started (reaching distance 30 takes ~tens of
millions of steps in expectation). So if the container's capacity / resize
threshold / overflow point is well above that, a uniform fuzzer runs billions of
ops and **never fills it** — the eviction/resize/overflow path never executes,
and its bug is never found. The suite stays green and you ship the segfault.

Concrete illustration from the paper — a stack that crashes above 32 items:

- **Uniform 50/50 push/pop:** ~**1 in 370,000** tests ever reaches 32 items.
- **Swarm (each test enables a random subset of {push, pop}):** a third of runs
  are push-only and fill the stack immediately → ~**1 in 16** tests trips it.

The counterintuitive lesson: *something that looks less random finds more bugs.*

## What disabling features buys you: two kinds of suppression

A feature **suppresses** a bug if the bug is less likely to show up in tests
that include the feature. Two flavors, both worth watching for:

**Active suppression** — running the feature mechanically hides a class of bugs:
- A filesystem test that ever calls `sync` hides buffering bugs.
- A compiler test whose input contains pointers disables alias-based
  optimizations, hiding optimizer bugs.
- A distributed-systems test that always restarts servers hides slow leaks and
  timer overflows.
You must sometimes *omit* these to find what they mask — and sometimes *include*
them to find bugs that need them. Only varying the subset gets you both.

**Passive suppression** (more general, more important) — a feature that doesn't
hide bugs causally, it just *crowds out* the operations that find them, eating
test budget. A `read` finds no bugs itself but consumes steps, making it even
less likely you do enough `insert`s in a bounded run. Any system with many
modular features has pervasive passive suppression.

**The example that should make you never hard-wire a feature:** across 17 C
compilers, *pointers* in the test program were a **trigger for 33% of bugs** but
a **suppressor for 41%**. Always emit pointers → miss ~41% of bugs; never emit
them → miss ~33%. The same feature both reveals and hides, depending on the bug.
The only way to win both halves is to randomly include/exclude it across runs.
This is the rule: **never enable or disable any feature across the whole suite.**

## How to implement it

1. **Enumerate your "features"** — whatever the generator can toggle: API
   operations, input-language constructs (arrays, pointers, structs), fault
   types, structural choices. The toggle is usually trivial to add.
2. **Coin-toss per test (the default and best practice):** at the start of each
   run, include each feature independently with probability ~0.5. Generating a
   fresh random subset for *every* test is nearly free and outperforms fancier
   schemes — don't reach for covering arrays or elaborate config-selection
   unless you have a specific reason.
3. **Run the fuzz loop** using only the enabled features.
4. **Favor many short runs over one long run** — short runs let the active
   subset (and the reachable state region) vary, and stop the random walk from
   re-centering. Thousands of cheap runs also make it overwhelmingly likely that
   any realistic feature combination (≤ ~5–10 features) co-occurs in *some* run —
   and that run finds the combination bug precisely because the crowding-out
   features are absent.
5. **Log the active subset + seed on failure.** "Bug found with {insert, resize}
   enabled, seed 12345" is a near-complete repro.

### Sketch

```
features = ["insert", "remove", "resize", "get", "iterate"]

def run(seed):
    rng = random.Random(seed)
    enabled = [f for f in features if rng.random() < 0.5] or [rng.choice(features)]
    # ... fuzz loop using only `enabled`, cross-checked against a reference ...

for seed in range(2000):       # many short runs, varied subsets
    run(seed)
```

## Examples of "features" by domain

| System under test | Features to toggle per run |
|---|---|
| Container / cache | insert, remove, get, resize, evict, clear, iterate |
| Filesystem | read, write, open, close, sync, mkdir, rmdir, rename, truncate |
| Compiler fuzzer | pointers, arrays, structs, bitfields, unions, goto, comma operator |
| Allocator | alloc, free, realloc, large sizes, alignment requests |
| Network/distributed | connect, disconnect, partition, restart, slow link |
| Media/file parser | valid headers, corrupt headers, oversized fields, truncation |

## The deeper pattern: bursty beats uniform

The same memoryless-vs-correlated insight recurs wherever you inject randomness
into a test — apply it everywhere, not just to operation subsets:

- **Fault injection / deterministic simulation testing:** don't flip a per-packet
  coin to drop packets — TCP retransmit absorbs uniform loss and you find
  nothing. Inject *long clean stretches punctuated by total partitions*, so the
  system reaches an interesting state and *then* gets disrupted.
- **Load testing:** don't send a request per tick with uniform probability —
  that's flat load with jitter. Model real traffic: long quiet periods then
  sharp spikes.
- **Sequential-input fuzzers (driving a game/UI):** uniform random button
  presses never hold an action long enough to make progress. You want long runs
  of an action then long runs of its absence.

Whenever you reach for `random()` in a test, ask: *am I generating a memoryless
uniform process that hovers in the boring middle? Or a bursty, correlated one
that actually reaches the edges?*
