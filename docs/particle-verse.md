# Particle Verse subset v1

Particle Verse is particletoy's small, sandboxed, Verse-shaped scene language. It is
**not Epic Verse**, does not run UEFN packages, and makes no claim of source compatibility.
Scripts are parsed into inert data and executed with deterministic time and an instruction
budget; source is never evaluated as JavaScript.

## Example

```verse
particle_verse := 1

OnBegin():void=
    Scene.SetBloom(1.4)
    Emitter.Burst("Sparks", 40)
    Wait(0.5)
    Emit("settle")

OnTick(Delta):void=
    Scene.SetExposure(Time)

OnEvent("settle"):void=
    Emitter.SetRate("Sparks", 8)
```

## Lifecycle and values

- `OnBegin():void=` runs on Apply and Restart.
- `OnTick(Delta):void=` runs once per simulation frame. `Time` and `Delta` are
  deterministic simulation seconds, not wall-clock values.
- `OnEvent("name"):void=` runs when `Emit("name")` is reached.
- `Wait(seconds)` suspends the current handler for 0–60 simulation seconds.
- Values are finite numbers, booleans, strings, `Time`, and `Delta`.
- Statements use four-space indentation. Scripts are limited to 64 KB, 500 instructions
  per frame, 128 tasks, and 64-character event names.

## Allow-listed API

- `Scene.SetBloom(value)` — clamped to 0–5
- `Scene.SetExposure(value)` — clamped to -10–10
- `Scene.SetBackground(r, g, b)` — each channel clamped to 0–10
- `Playback.Play()`, `Playback.Pause()`, `Playback.SetTimeScale(value)`
- `Emitter.SetRate(id_or_name, value)`, `Emitter.SetEnabled(id_or_name, bool)`
- `Emitter.Burst(id_or_name, count)` — capped at 10,000

## Epic Verse compatibility matrix

| Construct | Particle Verse v1 | Epic Verse relationship |
| --- | --- | --- |
| Indentation and `name := value` declaration | Supported | Similar surface syntax |
| Typed `:void=` handlers | Supported for fixed lifecycle forms | Narrow subset |
| `OnBegin`, suspension, events | Supported with deterministic local semantics | Inspired by, not runtime-compatible |
| Classes, modules, interfaces, failure contexts | Unsupported | Epic Verse only |
| UEFN devices and Fortnite APIs | Unsupported | Epic Verse only |
| General expressions, loops, mutation, async tasks | Unsupported | Epic Verse only |
| Browser, DOM, storage, and network access | Intentionally unavailable | Sandbox boundary |

Unknown syntax and API calls are errors rather than silently accepted behavior.
