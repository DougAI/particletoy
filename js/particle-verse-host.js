const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value)));

export class ParticleVerseHost {
  constructor(app, { onMutate = () => {} } = {}) {
    this.app = app;
    this.onMutate = onMutate;
  }

  emitter(ref) {
    const key = String(ref);
    const emitter = this.app.emitters.find((item) => item.p.id === key || item.p.name === key);
    if (!emitter) throw new Error(`Particle Verse cannot find emitter: ${key}`);
    return emitter;
  }

  dispatch(call) {
    const { namespace, method, args = [] } = call;
    const key = `${namespace}.${method}`;
    const allowed = new Set([
      'Scene.SetBloom', 'Scene.SetExposure', 'Scene.SetBackground',
      'Playback.Play', 'Playback.Pause', 'Playback.SetTimeScale',
      'Emitter.SetRate', 'Emitter.SetEnabled', 'Emitter.Burst',
    ]);
    if (!allowed.has(key)) throw new Error(`Particle Verse API does not allow ${key}`);
    this.onMutate(call);
    if (key === 'Scene.SetBloom') this.app.scene.bloom = clamp(args[0], 0, 5);
    else if (key === 'Scene.SetExposure') this.app.scene.exposure = clamp(args[0], -10, 10);
    else if (key === 'Scene.SetBackground') this.app.scene.background = args.slice(0, 3).map((value) => clamp(value, 0, 10));
    else if (key === 'Playback.Play') this.app.playing = true;
    else if (key === 'Playback.Pause') this.app.playing = false;
    else if (key === 'Playback.SetTimeScale') this.app.timeScale = clamp(args[0], 0.1, 4);
    else {
      const emitter = this.emitter(args[0]);
      if (key === 'Emitter.SetRate') emitter.p.spawn.rate = clamp(args[1], 0, 100_000);
      else if (key === 'Emitter.SetEnabled') emitter.p.enabled = Boolean(args[1]);
      else emitter.requestBurst(clamp(args[1], 0, 10_000) | 0);
    }
    return key;
  }
}
