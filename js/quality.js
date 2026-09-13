// Device-local render resolution policy. Auto mode uses a slow-moving frame-time
// signal with asymmetric thresholds so a single hitch cannot make the viewport pulse.

export const QUALITY_KEY = 'particletoy.quality.v1';
export const QUALITY_MODES = ['auto', 'full', 'balanced', 'performance'];
const AUTO_STEPS = [0.55, 0.7, 0.85, 1];

export function normalizeQualityMode(value) {
  return QUALITY_MODES.includes(value) ? value : 'auto';
}

export function fixedQualityScale(mode) {
  return { full: 1, balanced: 0.75, performance: 0.5 }[mode] ?? null;
}

export class AdaptiveQuality {
  constructor({ mode = 'auto', initialScale = 1 } = {}) {
    this.mode = normalizeQualityMode(mode);
    this.autoIndex = AUTO_STEPS.reduce((best, value, index) =>
      Math.abs(value - initialScale) < Math.abs(AUTO_STEPS[best] - initialScale) ? index : best, 0);
    this.average = 1 / 60;
    this.slowFrames = 0;
    this.fastFrames = 0;
  }

  get scale() { return fixedQualityScale(this.mode) ?? AUTO_STEPS[this.autoIndex]; }

  setMode(mode) {
    this.mode = normalizeQualityMode(mode);
    this.slowFrames = 0;
    this.fastFrames = 0;
  }

  update(dt) {
    if (this.mode !== 'auto' || !Number.isFinite(dt) || dt <= 0 || dt >= 0.05) return this.scale;
    this.average += (dt - this.average) * 0.04;
    if (this.average > 1 / 45) {
      this.slowFrames++;
      this.fastFrames = 0;
      if (this.slowFrames >= 90 && this.autoIndex > 0) {
        this.autoIndex--;
        this.slowFrames = 0;
        this.average = 1 / 60;
      }
    } else if (this.average < 1 / 57) {
      this.fastFrames++;
      this.slowFrames = 0;
      if (this.fastFrames >= 300 && this.autoIndex < AUTO_STEPS.length - 1) {
        this.autoIndex++;
        this.fastFrames = 0;
        this.average = 1 / 60;
      }
    } else {
      this.slowFrames = 0;
      this.fastFrames = 0;
    }
    return this.scale;
  }
}

export function loadQualityMode(storage) {
  try { return normalizeQualityMode(storage?.getItem?.(QUALITY_KEY)); }
  catch { return 'auto'; }
}

export function saveQualityMode(storage, mode) {
  try { storage?.setItem?.(QUALITY_KEY, normalizeQualityMode(mode)); }
  catch { /* storage can be disabled */ }
}

