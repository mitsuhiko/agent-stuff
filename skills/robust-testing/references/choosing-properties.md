# Choosing what to assert — the property catalogue

The fuzz harness gives you *volume*: millions of inputs through the API. But
volume is worthless if the only thing you check is "it didn't crash." The hard
part of property-based testing isn't generating inputs — frameworks do that —
it's deciding **what must be true of the output**. This file is the catalogue of
property shapes to reach for, plus the one rule that matters most when an LLM is
the one writing them.

Read this when you're staring at a function thinking "what do I even assert?"

## Table of contents
- [The governing rule: don't replicate the code](#the-governing-rule-dont-replicate-the-code)
- [For an agent writing properties: derive from the spec, not the implementation](#for-an-agent-writing-properties-derive-from-the-spec-not-the-implementation)
- [The shortcut: which kind of property to write first](#the-shortcut-which-kind-of-property-to-write-first)
- [Wlaschin's seven patterns (the brainstorming checklist)](#wlaschins-seven-patterns-the-brainstorming-checklist)
- [Three more from Hughes (the ones the checklist omits)](#three-more-from-hughes-the-ones-the-checklist-omits)
- [Metamorphic testing — when there is no oracle](#metamorphic-testing--when-there-is-no-oracle)
- [Two obligations people forget](#two-obligations-people-forget)
- [One-liner quick reference](#one-liner-quick-reference)

## The governing rule: don't replicate the code

Every property below is a way to check correctness **without recomputing the
expected answer the same way the code does**. The single most common way a
property test fails to find any bug is that its "oracle" is secretly a copy of
the implementation — if both share the same misconception, they agree on the
wrong answer and the test is a tautology in a lab coat.

The smell: the body of your property looks like a second implementation of the
function under test, and it would still pass if you pasted the production logic
into the check. The fix is to assert a *relationship* the answer must satisfy
(round-trip, invariant, a known algebraic law) or compare against a reference
that is **different in kind** — simpler, dumber, slower — not a clone.

## For an agent writing properties: derive from the spec, not the implementation

This skill is usually run by Claude writing tests for code Claude can see. That
creates a specific, well-documented failure mode, measured in Anthropic's 2026
"Agentic Property-Based Testing" work: an LLM that reads the implementation will
happily invent properties that merely *look* plausible, then report the code as
buggy when really the *property* was wrong. Their study found a raw false-bug
rate around 30–58% — and the fix that lifted the best slice to ~86% valid was a
single discipline:

> **Only test properties the code explicitly claims** — in its docstring,
> comments, type signature, or in how its callers actually use it. **Do not make
> up properties you merely think are true.** Every property should be *strongly
> supported by evidence* in the codebase.

Concretely, before asserting anything:

- **Follow the import chain to the real implementation.** A public module often
  re-exports from a private one (`numpy.linalg._linalg`); reason about *that*.
- **Read the callers.** They encode the implicit input domain and the contract
  the code actually has to honor — especially for internal helpers whose
  assumptions are undocumented.
- **Prefer soundness over completeness in the generator.** Generate only inputs
  the code promises to handle. If a failure comes from an input the code never
  claimed to support, that's not a bug — *tighten the generator* (`assume`,
  `filter`, `min_value`) rather than reporting it.
- **When a "failure" might be intentional design, flag it, don't assert it.**
  The blind spot LLMs can't resolve alone is telling a bug apart from a
  deliberate-but-surprising decision (e.g. a class named like a dict that the
  maintainers explicitly decided is *not* a dict). That's a question for a
  human or the maintainer, not a property.

The corollary the same study found encouraging: LLMs are genuinely *good* at
reading a function's name, docstring, and call sites and naming the property
that should hold. The taxonomy below is the menu to map that intuition onto.

## The shortcut: which kind of property to write first

John Hughes planted 8 bugs in a binary-search-tree map and measured how fast
each style of property caught them. The ranking is decisive enough to use as a
default strategy:

| Property kind | Bugs caught | Mean tests to first failure | Cost to write |
|---|---|---|---|
| **Model-based** | all 8 | **~6** | high (build a model) |
| Metamorphic | all (only in combination) | ~56 (high variance) | low each, need many |
| Postconditions | all (≥1 each) | ~77 | medium |
| Inductive | complete subset | — | medium |
| Validity / invariant **alone** | 3 of 8 | — | low |

Two takeaways drive everything:

1. **A model-based property is worth ten of anything else.** It checks *every*
   element of the result against a simple reference on *every* call, so it fails
   almost immediately and catches everything. This is exactly the "reference
   implementation in lockstep" the fuzz harness already advocates — the
   catalogue just names it as the strongest tool and tells you to start there.
2. **Validity properties alone are a trap.** "The result is always a valid BST"
   passes even if `insert` is defined to *delete* the key, or to return an empty
   tree every time — as long as the shape invariant holds. Validity constrains
   the *shape* of the answer, never its *meaning*. Always pair it with a
   behavioural property.

So: **if you can write a simple reference model, do that first** (plus a validity
property so malformed data doesn't produce confusing failures elsewhere). When a
faithful model is too expensive or would just duplicate the implementation's
hard parts, fall back to **metamorphic** properties — you'll need several, but
together they cover everything.

## Wlaschin's seven patterns (the brainstorming checklist)

When you're stuck, walk this list and ask "does my function fit this shape?"
These are sticky names worth adopting as team vocabulary. (Source: Scott
Wlaschin, *Choosing properties for property-based testing*.)

**1. Different paths, same destination** — *commutativity / order-independence.*
Two different routes reach the same result.
`f(g(x)) == g(f(x))` · `add(1, add(2, x)) == add(2, add(1, x))`
Reach for it when operations can be reordered or composed differently:
commutativity, associativity, distributivity, "insert these in any order."

**2. There and back again** — *inverse / round-trip.* The most reliable pattern
for codecs and persistence.
`decode(encode(x)) == x` · `deserialize(serialize(x)) == x` · `reverse(reverse(xs)) == xs`
Caveat: round-trips are blind to *symmetric* bugs (a matching mistake in both
directions cancels out). Pair with an invariant or a known concrete value.

**3. Some things never change** — *invariant under transformation.* The output
changes, but some quantity is preserved.
`length(map(f, xs)) == length(xs)` · `multiset(sort(xs)) == multiset(xs)` · `sum(after) == sum(before)`
Reach for conservation laws: cardinality, membership, a checksum, money-in =
money-out.

**4. The more things change, the more they stay the same** — *idempotence.*
`f(f(x)) == f(x)` · `sort(sort(xs)) == sort(xs)` · `normalize(normalize(s)) == normalize(s)`
For anything that should be safely repeatable: dedup, canonicalization,
PUT/upsert semantics, at-least-once message handling.

**5. Solve a smaller problem first** — *structural induction.* Define the
property recursively over a recursively-defined type.
`sorted(x:xs) == (x <= head(xs)) && sorted(xs)`, with `sorted([]) == true`
For lists, trees, ASTs — anything the function recurses over.

**6. Hard to prove, easy to verify.** Computing the answer is expensive;
*checking* a proposed answer is cheap. Test the cheap check.
`is_permutation(xs, sort(xs)) && pairwise_ordered(sort(xs))` · `multiply(factors(n)) == n`
For search, optimization, factorization, parsing, scheduling, constraint
solving. **Watch the gap:** for sorting, "adjacent pairs ordered" alone passes
for `[]` and for a function that drops elements — you must *also* assert the
output is a permutation of the input. Verification properties usually need to be
combined.

**7. The test oracle** — *a trusted alternative implementation.* Compare against
a brute-force baseline, a legacy system you're replacing, a spec-mandated
reference, or a slow-but-obviously-correct version.
`f_fast(x) == f_reference(x)`
The only pattern that needs a real oracle; the other six exist precisely because
you usually don't have one. This is Hughes' model-based property in informal
dress, and it's the one to prefer when you can get it.

## Three more from Hughes (the ones the checklist omits)

Hughes' five categories mostly overlap with the patterns above — his
*model-based* is Wlaschin's "test oracle" (#7, and your default per the ranking
table), and his *metamorphic* gets its own section below. Three categories are
worth adding because the checklist doesn't name them. (Source: John Hughes, *How
to Specify It!*)

- **Validity / invariant** — every operation returns a structurally valid
  result: `valid(insert(k, v, t))`. Cheap and necessary, but *insufficient
  alone* (the trap above): pair it with a behavioural property, and assert your
  *generator and shrinker* only ever emit valid values, or unrelated properties
  fail in confusing ways.

- **Postcondition** — relate the result to the arguments of a *single* call:
  `find(k', insert(k, v, t)) == (if k == k' then Just v else find(k', t))`. The
  natural first instinct. Use *two independent keys* — a postcondition over one
  key would pass for "discard the whole tree."

- **Inductive** — a *complete* set of relations covering a base case and an
  inductive step, mirroring an inductive proof:
  `union(nil, t) == t` plus `union(insert(k,v,t), t') ≈ insert(k,v, union(t,t'))`.
  If all hold, the operation is fully pinned down — provided the type can only be
  built the way you assume (so test that completeness too).

## Metamorphic testing — when there is no oracle

Patterns 1–4 above are all special cases of one powerful idea: when you *can't*
tell whether a single output is correct, transform the input in a known way and
assert the output changes (or doesn't) in the predicted way. A violation proves
a bug even though you never knew the right answer for any single run. This is the
tool for scientific/numeric code, ML models, search engines, compilers,
simulations, graphics, optimizers — anything without a reference.

Classic relations:

- **Symmetry:** `sin(x) == sin(π − x)` · `cos(x) == cos(−x)`
- **Permutation invariance:** `sort(xs) == sort(shuffle(xs))`
- **Subset under refinement:** `search(q AND filter) ⊆ search(q)` — adding a
  filter to a query can only shrink the result set. (Real search engines have
  shipped bugs this catches.)
- **Semantics-preserving transformation:** renaming variables / reordering
  independent statements / inserting dead code must not change a compiler's
  observable output. This is the basis of compiler fuzzers like Csmith.
- **Scaling / additive:** `classify(image) == classify(brighten(image))` for a
  classifier that should be brightness-invariant; `f(x) + f(−x) == 2·f(0)` for
  an even function.

The general shape: transform input `x` into a related `x'` via an *input
relation*, then assert an *output relation* between `f(x)` and `f(x')`. Hughes'
BST metamorphic properties are exactly this with two calls.

## Two obligations people forget

**Test your generators and shrinkers against the same invariants.** A buggy
generator that emits invalid values produces a storm of false failures in
unrelated properties, and a shrinker that drifts off the valid set reports a
*different* bug than the one you found. Add `valid(x)` as a property over your
own generator's output, and (where the framework exposes it) over shrink
candidates too. Integrated/internal shrinking (Hedgehog, Hypothesis) gives this
for free; classic QuickCheck-style manual shrinkers do not — see
`pbt-craft.md`.

**Mind your equality.** You often need *two* notions of "equal." Behavioural
properties compare by *observable contents* — two trees built by inserting the
same pairs in different orders are differently *shaped* but equivalent, so
compare `toList(a) == toList(b)`, not `a == b`. Completeness/shape properties
deliberately want *structural* equality, to prove an operation can't construct
an otherwise-unreachable representation. Using the wrong one either hides bugs or
manufactures spurious failures.

## One-liner quick reference

| Pattern | Form |
|---|---|
| Commutativity / order-independence | `f(g(x)) == g(f(x))` |
| Round-trip / inverse | `decode(encode(x)) == x` |
| Invariant under transform | `length(map(f, xs)) == length(xs)` |
| Idempotence | `f(f(x)) == f(x)` |
| Structural induction | `sorted(x:xs) == (x <= head(xs)) && sorted(xs)` |
| Hard to prove, easy to verify | `is_permutation(xs, sort(xs)) && pairwise_ordered(sort(xs))` |
| Test oracle / model-based | `f_fast(x) == f_reference(x)` |
| Postcondition | `find(k', insert(k,v,t)) == (k==k' ? Just v : find(k',t))` |
| Metamorphic — symmetry | `sin(x) == sin(π - x)` |
| Metamorphic — permutation | `sort(xs) == sort(shuffle(xs))` |
| Metamorphic — subset | `search(q AND filter) ⊆ search(q)` |

Sources: Scott Wlaschin, *Choosing properties for property-based testing*
(fsharpforfunandprofit.com); John Hughes, *How to Specify It! A Guide to Writing
Properties of Pure Functions* (2020); Chen, Cheung & Yiu, *Metamorphic testing*
(1998); Anthropic, *Agentic Property-Based Testing* (red.anthropic.com, 2026;
arXiv:2510.09907). Curated links in `resources.md`.
