export const PARTICLE_VERSE_EXAMPLES = Object.freeze({
  'Bloom pulse': `particle_verse := 1

OnBegin():void=
    Scene.SetBloom(1.6)
    Wait(1.0)
    Scene.SetBloom(0.8)
`,
  'Staged burst': `particle_verse := 1

OnBegin():void=
    Emitter.Burst("Sparks", 40)
    Wait(0.5)
    Emit("afterglow")

OnEvent("afterglow"):void=
    Emitter.SetRate("Sparks", 8)
`,
});
