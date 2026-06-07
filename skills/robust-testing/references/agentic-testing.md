# Agentic Testing

Read this for systems whose behavior is hard to pin down with fixed tests:
software that depends on timing, tool-calling, replication / distributed effects,
or natural-language interaction. This is antirez's "a new kind of testing may
soon emerge" — point LLM agents at your system as virtual QA engineers.

## The core idea

A fixed test suite encodes states *you thought of*. An LLM agent can act as a
virtual QA engineer / virtual user and explore states you didn't enumerate. Two
independent sources of randomness compound and explore far more of the state
space than fixed tests:

1. **The agent's nondeterminism** — it samples during generation, so each run
   invents different use cases, inputs, and sequences.
2. **The system's nondeterminism** — timing, replication sync, scheduling,
   distributed-ish behavior.

This is the LLM-era version of QA teams running smoke tests, integration tests,
and accelerated production-traffic simulations — work that exists precisely
because traditional test suites are "full of holes." "100% of tests pass" is not
a correctness proof for a large system; it just means the holes weren't hit.

## When to use it (and when not)

Use it when fixed tests are structurally inadequate:
- behavior depends on **timing** or scheduling,
- the system involves **tool-calling** / how coding agents hit your API,
- **distributed / replication** coherence matters,
- the interface is **natural language** and correctness is fuzzy.

It's a *complement*, not a replacement. For a pure data structure or parser, the
fuzz + invariant harness is sharper and cheaper — don't reach for an agent there.

## How to set it up

### 1. Write a `testing.md` prompt

A file that tells an agent to act as a QA engineer and run trial sessions
against the system. It should describe the operations a human QA would do, made
concrete and scalable. A good `testing.md` covers:

- **Role:** "In this session you act as a QA engineer running trial sessions
  against <system>."
- **What to exercise:** the API endpoints / tools / CLI to hit, what a correct
  response looks like, what coherence means.
- **Use-case invention:** instruct the agent to invent realistic use cases and
  write small programs (e.g. Python) that drive the system for each.
- **Progressive scaling:** scale the load in stages so you reach the extreme
  states — e.g. for a Redis array feature: 10 → 100 → 100k → 1M → 10M → 50M
  entries.
- **Cross-cutting checks:** put the system mid-replication, confirm data is
  perfectly coherent across both replicas, save, reload, and re-verify — encode
  the whole checklist into the one prompt.

### 2. Run at meaningful checkpoints

You don't run this every commit. After a significant change, re-run the prompt
to confirm things still work. It's cheap to invoke — you just execute the file —
and it does broad exploratory work each time.

### 3. Use a self-verifying two-agent pipeline

Agents produce false positives, so split the work:

- **Session A** runs the tests and *flags* potential bugs.
- **Session B**, independent, *verifies* whether each flagged issue is actually
  real, filtering false positives.
- If a real bug is confirmed → email / auto-open an issue.

This separation is what makes agentic testing trustworthy enough to run
continuously: an army of virtual users hammering the system, catching bugs that
would otherwise surface days after release.

## Relationship to the rest of this skill

Agentic testing scales the *exploration* (reaching novel states) the way swarm
testing scales it for a fixed operation set, and the way fuzzing scales it for a
fixed harness. The verification half (session B, invariants) is the same
discipline as the reference-implementation cross-check — just expressed in
natural language by a second model instead of a dumb reference in code. Same
philosophy, applied where code-level invariants are impractical.
