# Deterministic simulation testing (DST)

Property-based testing randomizes the *data* flowing through an API. Deterministic
simulation testing randomizes the *environment* — the scheduling, the timing, the
faults — while making the whole run perfectly reproducible so any failure replays
bit-for-bit from a seed. It's the technique that makes concurrent and distributed
systems testable, and it's the natural endpoint of this skill's principles
(seeded reproducible randomness, biasing toward the fragile states, invariants
over examples) applied to whole systems instead of single functions.

Read this for anything where the bug is an *interleaving* or a *fault*, not an
input: databases, queues, consensus, replication, storage engines, schedulers,
sync engines, anything with concurrency or partial failure.

## The one-line distinction

- **PBT:** random *inputs* + invariants. Shrinks a failing input.
- **DST:** random *schedules / faults / timing* + invariants + **full
  determinism**. Replays an entire failing *execution* — a specific interleaving
  of thousands of events — from one seed.

That replay is the superpower. A Heisenbug that surfaces once in a million runs
becomes a debuggable, re-runnable artifact.

## The recipe

1. **Make the system run on virtual infrastructure.** Replace disk, network,
   clock, and threads with deterministic in-process mocks that honor the same
   contracts but are fully controllable. The production code runs unchanged
   against these mocks. (FoundationDB built a whole actor language, Flow, so the
   same source compiles to production *and* to simulation.)
2. **Drive everything from a single seeded PRNG.** All "randomness" — message
   delays, which node acts next, when a disk fails — flows from one seed, so the
   workload looks random yet is perfectly reproducible. Print the seed.
3. **Run single-threaded as a discrete-event simulation.** One process
   simulates the entire cluster; determinism comes from removing real
   concurrency and stepping a logical clock. This also lets you *compress time*:
   simulate hours of timeouts in seconds (TigerBeetle reports ~3.3s of
   simulation ≈ ~39 minutes of real cluster time).
4. **Inject faults aggressively and in bursts.** Network partitions, dropped /
   reordered / duplicated messages, disk corruption and full disks, process
   crashes and restarts, clock skew, even whole-datacenter loss. Per
   `swarm-testing.md`, *bursty beats uniform*: long clean stretches punctuated by
   total partitions reach interesting states a per-packet coin-flip never will —
   uniform packet loss is just absorbed by retransmits.
5. **Check invariants continuously**, and replay from the seed on any violation.

**`BUGGIFY` (FoundationDB)** is worth stealing as a pattern: a macro that is
*only* true in simulation and biases the system toward dangerous-but-legal
behavior — inject a 10-second delay 1% of the time, flush early, return the
maximum-allowed error. It deliberately seeds the rare internal conditions that
cause real heisenbugs, not just external faults. **"Swizzle-clog"** is another:
stop random nodes' networking one at a time, then restore them in random order —
unusually good at deep, rare-ordering bugs.

**A subtlety on reproducibility (TigerBeetle's VOPR):** a raw seed's *meaning*
drifts as the code changes, so for evolving tests, persist the *derived
structured scenario* (predicates over system state), not only the seed — so a
saved failure still means the same thing after a refactor.

## "Sometimes" assertions — liveness and coverage of situations

DST platforms add an assertion vocabulary that classic PBT lacks, because in a
continuously-explored state space you care not just that nothing bad *ever*
happens, but that the good/interesting things *do* happen somewhere. Antithesis
names them:

| Assertion | Meaning |
|---|---|
| `always(cond)` | must hold every time evaluated — classic safety invariant |
| `alwaysOrUnreachable(cond)` | must hold whenever reached, but never reaching it also passes |
| **`sometimes(cond)`** | must be true **at least once** across the whole exploration |
| `reachable()` | this location must execute at least once |
| `unreachable()` | this location must never execute (guard a forbidden path) |

The unusual and most valuable one is **`sometimes`** — the *inverse* of a normal
assertion. `always(x > 0)` fails if `x` is ever ≤ 0; `sometimes(x < 1)` fails if
`x` is *never* < 1 in any explored timeline. Two uses:

- **Liveness / reachability of *situations*.** `sometimes(checkout_completed)`
  fails if a bug ever makes the checkout flow impossible — a class of bug
  ordinary "nothing went wrong" assertions can't see.
- **A test-quality signal.** If a `sometimes` you believe is reachable (and is
  reached in production) is *never* hit by your tests, your exploration is
  leaving important ground uncovered. As Antithesis puts it: *code coverage
  covers locations; sometimes-assertions cover situations.* A human places them
  deliberately, so hitting or missing one is always meaningful — unlike line
  coverage, which is both too coarse and too noisy.

Bombadil's temporal operators (`always` / `eventually` / `next`) are the
single-timeline cousins: `eventually(cond)` is `sometimes` for one UI run.

## Tools and worked examples

- **FoundationDB** — the origin (Will Wilson's 2014 Strange Loop talk). Tens of
  thousands of simulations nightly with Flow + `BUGGIFY` + swizzle-clog; the
  result was robust enough that Jepsen's author declined to test it.
- **TigerBeetle VOPR** ("Viewstamped Operation Replicator") — the modern, open,
  readable instance: deterministic cluster simulation with storage/network fault
  injection, liveness checking, time compression, seed replay. Their "A Tale of
  Four Fuzzers" and "Simulation Testing for Liveness" posts are excellent.
- **Antithesis** — a deterministic *hypervisor* that forces *existing*
  non-deterministic software into deterministic execution, so you get
  FoundationDB-grade determinism without a Flow-style rewrite; you supply
  invariants via their SDK (the assertion table above).
- **Bombadil** (Antithesis, open source) — PBT for web UIs: autonomously drives a
  real browser with random click/type/scroll/navigate sequences and checks
  temporal properties (`always` the cart total equals the sum of items;
  `eventually` submitting clears the form) after every action. The UI analogue of
  this whole skill — invariants over exploration, not scripted scenarios.
- **WarpStream, S2, Dropbox (Nucleus), MongoDB** — production teams running
  millions of deterministic randomized runs nightly; Dropbox's sync-engine rewrite
  is the canonical "designed the system to be deterministically testable" story.

## When to reach for DST vs plain PBT

Use plain fuzz+invariant PBT (the rest of this skill) when the bug is a function
of the *input*. Reach for DST when correctness depends on *order, timing, or
failure*: concurrency, replication/consensus, crash-recovery and durability,
distributed transactions, anything where "it worked in the test but not under a
partition" is a real risk. The two compose — fast-check's `fc.scheduler`
(`pbt-craft.md`) is small-scale DST inside a property test; full DST is the same
idea scaled to the whole system with a deterministic runtime underneath.

Sources: Will Wilson, *Testing Distributed Systems w/ Deterministic Simulation*
(Strange Loop 2014); FoundationDB testing docs (apple.github.io/foundationdb);
TigerBeetle VOPR docs and blog (tigerbeetle.com); Antithesis docs on DST,
property-based testing, and assertions (antithesis.com/docs); Bombadil
(github.com/antithesishq/bombadil); WarpStream / S2 / Dropbox engineering posts.
Curated links in `resources.md`.
