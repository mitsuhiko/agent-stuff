# Mutation Testing

Read this when the question is "are my tests actually any good?" — not "does the
code work" but "would my suite *notice* if the code broke?"

## The idea

Coverage tells you a line *ran*. It does not tell you the line was *verified*. A
test can execute a branch and assert nothing meaningful about it. Mutation
testing closes that gap empirically:

1. Make many small, semantically-meaningful edits to the code — one at a time.
   Each edit is a **mutant**: `<` → `<=`, `+` → `-`, `&&` → `||`, `return x` →
   `return 0`, delete a statement, negate a condition.
2. Run the test suite against each mutant.
3. If a test **fails**, the mutant is **killed** — good, your suite caught that
   fault.
4. If all tests still **pass**, the mutant **survived** — bad. That's a real
   fault the code could contain that your tests would never detect.

The **mutation score** = killed / total. A surviving mutant is a precise,
actionable pointer at a weak spot: a line that's exercised but not asserted on.

## Why it complements the fuzz harness

The two techniques check different things:
- The fuzz + invariant harness asks *does the implementation satisfy its
  contract under wild inputs?*
- Mutation testing asks *is the harness strong enough to catch violations?*

A great use of mutation testing is **right after building a fuzz harness**: if a
mutant survives, your invariants or input generation aren't reaching/checking
that code, so strengthen them. It keeps you honest about a passing suite that
might be passing for the wrong reason.

## When to reach for it

- The user asks how good / trustworthy the tests are.
- Correctness is critical and you want evidence beyond line coverage.
- You just wrote a fuzz/property harness and want to confirm it bites.
- A bug slipped through despite "good coverage" — find the unasserted lines.

## Watch out for

- **Equivalent mutants:** some mutations produce code that behaves identically
  to the original (e.g. mutating an unreachable branch, or a change a later step
  masks). These *can't* be killed and aren't real gaps — they're the main source
  of noise. Most tools let you ignore known-equivalent mutants.
- **Cost:** running the suite once per mutant is expensive. Scope it to the
  module you care about, and lean on the "fast tests" principle — a slow suite
  makes mutation testing impractical.
- Don't chase 100%. Use surviving mutants as a *to-do list of weak assertions*,
  prioritized by how much the mutated code matters.

## Tooling by language

| Language | Tool |
|---|---|
| Python | `mutmut`, `cosmic-ray` |
| JavaScript / TypeScript | StrykerJS (`@stryker-mutator/core`) |
| Java / Kotlin / JVM | PIT (`pitest`) |
| C / C++ | `mull`, `dextool mutate` |
| Rust | `cargo-mutants` |
| Go | `go-mutesting` |
| C# / .NET | Stryker.NET |
| Ruby | `mutant` |

Typical workflow: install the tool, point it at the module + its tests, run, then
read the surviving-mutant report and add or sharpen assertions until the
mutants that matter are killed.
