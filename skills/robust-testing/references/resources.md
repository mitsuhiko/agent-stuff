# Resources — talks, writing, books, repos, and war stories

A curated, high-signal reading/watching list from people who ship property-based
and simulation testing in production, plus the field's credibility cases. Each
entry says *why* it's worth your time and what non-obvious technique it
contributes. Pull from here when you want depth on a specific topic or when the
user asks for sources.

## Start here (if you read only three things)

1. **John Hughes — *How to Specify It!*** — the best single resource on the hard
   part (coming up with properties). Five property categories scored against a
   buggy BST. Paper: research.chalmers.se/publication/517894 · talk:
   youtube.com/watch?v=zvRAyq5wj38. This is the backbone of
   `choosing-properties.md`.
2. **Scott Wlaschin — *Choosing properties for property-based testing*** — the
   approachable on-ramp with the sticky pattern names (round-trip, invariant,
   idempotence, …). fsharpforfunandprofit.com/posts/property-based-testing-2/
3. **David R. MacIver — *How Hypothesis Works*** — how the machinery (generators,
   internal shrinking) actually works. hypothesis.works/articles/how-hypothesis-works/

## Talks

- **John Hughes — Testing the Hard Stuff and Staying Sane** (youtube.com/watch?v=zi0rHwfiX1Q).
  The canonical "PBT in industry" talk by QuickCheck's co-inventor: stateful /
  model-based testing, and shrinking a 3,000-operation trace to a minimal repro.
- **John Hughes — Don't Write Tests!** (youtube.com/watch?v=hXnS_Xjwk2Y). The
  polemic version — hand it to skeptics.
- **Will Wilson — Testing Distributed Systems w/ Deterministic Simulation**
  (Strange Loop 2014, youtube.com/watch?v=4fFDFbi3toc). The talk that launched
  simulation testing (FoundationDB → Antithesis). The DST primer.
- **Jacob Stanley — Gens N' Roses: Appetite for Reduction**
  (youtube.com/watch?v=LfD0DHqpeVQ). By Hedgehog's author — the clearest
  explanation of why type-directed shrinking is broken and what integrated
  (rose-tree) shrinking fixes.
- **Oskar Wickström — Property-Based Testing the Ugly Parts** (wickstrom.tech/talks.html).
  The worked example of PBT on a *stateful, effectful, real* application (a video
  editor): integration-level properties and metamorphic relations for a
  non-deterministic classifier.
- **Hillel Wayne — Beyond Unit Tests** (hillelwayne.com/talks/beyond-unit-tests/).
  PBT plus runtime contracts as complementary layers, from a formal-methods
  practitioner honest about where each pays off.

## Blogs and writeups

- **David R. MacIver — hypothesis.works / drmaciver.com.** The deepest writer on
  shrinking and generators. Must-reads: *Integrated vs type-based shrinking*,
  *Compositional shrinking*, *Notes on Test-Case Reduction*. The source for why
  internal shrinking respects generator invariants.
- **Hillel Wayne — Metamorphic Testing** (hillelwayne.com/post/metamorphic-testing/)
  and **Finding Property Tests** (hillelwayne.com/post/contract-examples/). The
  best short treatment of the no-oracle technique, plus a practical method for
  mining properties out of existing example tests.
- **Fred Hébert — PropEr Testing** (propertesting.com). Free (older, Erlang-only)
  draft of his book; deep on stateful state-machine testing and generators that
  shrink well.
- **Johannes Link — How to Specify It! In Java!** (johanneslink.net/how-to-specify-it/)
  and his model-based / stateful testing posts. The Hughes taxonomy as runnable
  jqwik code (repo: github.com/jlink/how-to-specify-it).
- **Nicolas Dubien — fast-check track record** (fast-check.dev/docs/introduction/track-record/).
  Documented real bugs fast-check found in js-yaml, jest, query-string, left-pad,
  jsonwebtoken — concrete proof PBT finds bugs in widely-used code.
- **antirez — fuzzing philosophy** (antirez.com, rax README). "Fuzzing for system
  software should perform random operations according to a sane operation model
  and compare with a reference implementation — not just search for crashes."
  Model-based PBT expressed in C. The skill's home turf.
- **Jane Street — QuickCheck for Core** (blog.janestreet.com/quickcheck-for-core/).
  How a large shop bakes PBT into its stdlib: `[@@deriving quickcheck]` auto-derives
  generators *and* integrated shrinkers from type definitions.
- **TigerBeetle — Simulation Testing for Liveness** and **A Tale of Four
  Fuzzers** (tigerbeetle.com/blog). The clearest modern, open writeups of DST.
- **Ted Kaminski — Fuzzing and Property Testing**
  (tedinski.com/2018/12/11/fuzzing-and-property-testing.html). The clearest take
  on the (blurry) PBT-vs-fuzzing boundary.

## Books

- **Fred Hébert — *Property-Based Testing with PropEr, Erlang, and Elixir***
  (PragProg, 2019). The only full-length practitioner book; mine it for technique
  (custom generators that shrink, stateful modeling, targeted properties) even if
  you don't write Erlang.
- **Hypothesis documentation** (hypothesis.readthedocs.io). The authoritative
  reference for the modern internal-shrinking model; see `stateful`, `target()`,
  and the example database.

## Exemplar repos (worked examples to imitate)

- **antirez/rax — `rax-test.c`** — model-based fuzzing of a radix tree in plain C
  against a reference hash map, with a failing-allocator and Valgrind tricks. The
  proof that "you don't need a framework to do PBT." (Walked through in
  `fuzz-invariant-harness.md`.)
- **TigerBeetle VOPR** (github.com/tigerbeetle/tigerbeetle, docs/internals) — the
  modern open instance of deterministic simulation testing.
- **jlink/how-to-specify-it** — Hughes' five-property taxonomy as runnable jqwik
  code against a buggy BST. Best hands-on companion to the paper.
- **HypothesisWorks/hypothesis** — Hypothesis tests itself; instructive
  generator/shrinker meta-example.
- **janestreet/base_quickcheck** — derived generators/shrinkers as a
  production-library design reference.

## War stories (the credibility cases)

- **Volvo / AUTOSAR (Quviq).** ~3,000 pages of automotive spec translated into
  QuickCheck models, testing implementations from many vendors → ~200 issues,
  *including bugs in the standard itself*. The flagship industrial PBT result.
- **Dropbox "Nucleus" sync engine.** Two deterministic randomized testing systems
  (CanopyCheck, Trinity), tens of millions of runs nightly, ~100% green on
  master, every failing seed reproducible — the canonical "design for
  testability" story.
- **AWS S3 ShardStore.** Property-based testing with developer-written
  correctness specs plus coverage-guided fuzzing and failure injection, adding
  only ~13% more code; part of AWS's broader deterministic-simulation practice.
- **Anthropic agentic PBT (2026).** Claude autonomously writing Hypothesis tests
  found real, merged bugs across NumPy/SciPy/Pandas and others (e.g.
  `numpy.random.wald` producing negative samples) — and quantified the LLM
  failure modes that shape `choosing-properties.md`. red.anthropic.com/2026/property-based-testing/
  · arXiv:2510.09907.

## What the practitioners converge on (from the field, incl. HN)

The recurring consensus, kept to what isn't already covered elsewhere in the
skill:

- **The hard part is coming up with properties** — overwhelmingly the top-cited
  difficulty. Antidote: think about how a function *relates to other functions*,
  not "properties of `foo`"; treat the property as the function's contract. (This
  is why `choosing-properties.md` exists.)
- **Model-based / stateful testing is where the deep bugs are** — repeatedly
  named the highest-ROI style, including for "business" code people assume PBT
  can't touch.
- **"Non-deterministic test" fear is mostly a misconception** — PBT *is*
  reproducible (seed + shrinking + the failure database); commit the database as
  a ratchet.
- **PBT and fuzzing are converging** — coverage-guided fuzzers (libFuzzer, Go
  native, HypoFuzz) overlap heavily with PBT; the rough split is "fast tests +
  detailed assertions = PBT; long crash-hunting runs = fuzzing."

Ecosystem note for tooling: **Tyche** (tyche-pbt.github.io) visualizes generator
coverage/distribution; **Schemathesis** and **HypoFuzz** extend Hypothesis;
**rapid** (Go), **fast-check** (TS), **CsCheck** (.NET), **clojure.spec +
test.check** (Clojure), **proptest** + **AWS Shuttle** (Rust) are the
frequently-praised picks. Per-language entry points live in `frameworks.md`.
