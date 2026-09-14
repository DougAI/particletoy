# Twenty-milestone iteration roadmap

The next development loop concentrates on two everyday workflows—using the editor on a
phone or tablet and collaborating with an AI assistant—then spends the architectural
budget earned there on sandboxed scene scripting.

Each milestone should be independently reviewable, preserve the static/no-build-step
deployment, and include a focused automated or browser-level check.

## Mobile foundation

1. **Workspace navigation** — switch between full-size Preview, Inspect, and Code views
   on narrow screens without disturbing the desktop split layout.
2. **Compact command bar** — keep playback and primary save/share actions reachable while
   moving infrequent commands into an overflow sheet.
3. **Touch camera controls** — document and support one-finger orbit plus two-finger pan
   and zoom without fighting page gestures.
4. **Touch-sized inspector** — enlarge targets, make property rows reflow, and keep numeric
   controls usable with the software keyboard open.
5. **Precision curve editing** — add selection, nudge, and delete affordances that do not
   depend on hover or right-click.
6. **Responsive dialogs** — make library, publish, import, export, and help flows fit safe
   areas and small landscape screens.
7. **Adaptive render quality** — scale resolution and expensive effects against measured
   frame time, with a manual override.
8. **Installable/offline shell** — add a manifest and conservative service worker for the
   static editor shell while keeping shared and published data network-aware.

## AI-assisted creation

9. **Effect brief** — generate a structured, copyable description of the current effect
   and the particletoy schema for use with any assistant.
10. **Safe patch preview** — validate and display an AI-proposed effect patch before the
    user applies it; never execute arbitrary returned JavaScript.
11. **Prompt workspace** ✅ — add an in-editor conversation surface that can operate in
    clipboard mode before any provider is configured.
12. **Provider boundary** ✅ — define an optional server-side adapter contract so API keys
    are never embedded in the static client or published effects.
13. **Prompt-to-properties** ✅ — let assistants add and tune emitters through a constrained,
    versioned operation format.
14. **Prompt-to-material** ✅ — generate Slang vertex/fragment changes with compilation
    diagnostics and an explicit accept/reject step.
15. **Prompt-to-simulation** ✅ — generate compute simulation changes with capacity and
    performance guards.
16. **Repair loop** ✅ — feed structured compiler/runtime diagnostics back into an assistant
    while preserving undo, diffs, and user approval.

## Particle Verse scene scripting

Epic does not currently ship its Verse compiler/runtime as a standalone browser
dependency. These milestones therefore target a clearly documented **Particle Verse
subset**, not false claims of full UEFN compatibility.

17. **Parser and diagnostics** — parse a versioned, indentation-sensitive Verse-shaped
    subset into an AST without `eval`, with useful line/column errors.
18. **Deterministic lifecycle** — add bounded `OnBegin` and per-frame execution with
    restart semantics, instruction budgets, and deterministic time.
19. **Scene and emitter API** — expose allow-listed lighting, playback, emitter, and burst
    operations through undoable editor state.
20. **Events, examples, compatibility** — add bounded coroutines/events, presets, reference
    documentation, serialization tests, and an explicit compatibility matrix against Epic
    Verse syntax and semantics.

