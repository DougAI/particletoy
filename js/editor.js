// Lightweight Slang code editor: transparent textarea over a highlighted <pre>,
// with line numbers, error markers, tab handling, and auto-indent.

const TOKEN_RE = new RegExp(
  [
    '(\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/)',                     // 1 comment
    '(#[^\\n]*|\\[[A-Za-z_]\\w*(?:\\([^)]*\\))?\\])',              // 2 preprocessor / attribute
    '\\b(\\d+\\.\\d*(?:[eE][+-]?\\d+)?|\\.\\d+|\\d+)\\b',          // 3 number
    '\\b(void|bool|int|uint|half|float|double|float2|float3|float4|int2|int3|int4|uint2|uint3|uint4|bool2|bool3|bool4|float2x2|float3x3|float4x4|row_major|column_major|if|else|for|while|do|switch|case|default|return|in|out|inout|uniform|const|static|struct|class|interface|extension|typedef|namespace|import|export|break|continue|discard|true|false|let|var|nointerpolation|Atomic|ConstantBuffer|StructuredBuffer|RWStructuredBuffer|Texture2D|SamplerState)\\b', // 4 keyword
    '\\b(lerp|clamp|saturate|dot|cross|normalize|length|pow|exp|exp2|log|log2|sqrt|rsqrt|sin|cos|tan|asin|acos|atan|atan2|abs|floor|ceil|frac|fmod|min|max|step|smoothstep|mul|transpose|reflect|refract|distance|sign|ddx|ddy|fwidth|SampleLevel|Load|hash11|hash21|hash33|noise2|noise3|fbm2|fbm3|rand|randRange|randUnitVec|curveSpeed|curveSize|curveColor|curveAlpha|screenUV|sceneDepth|sceneLinearDepth|sceneWorldPos|sampleGBuffer|gbufferAvailable|shadeSurface|skyColor|linearizeDepth)\\b', // 5 builtin
    '\\b(Surface|SurfaceInput|Particle|VertexData|GBuffer|SpawnCtx|SimCtx|mainSurface|mainVertex|spawn|simulate|neighbors|PI|TAU)\\b', // 6 api
  ].join('|'),
  'g'
);

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function highlight(src) {
  let out = '';
  let last = 0;
  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(src)) !== null) {
    out += escapeHtml(src.slice(last, m.index));
    const cls = m[1] ? 'tok-comment' : m[2] ? 'tok-preproc' : m[3] ? 'tok-number'
      : m[4] ? 'tok-keyword' : m[5] ? 'tok-builtin' : 'tok-api';
    out += `<span class="${cls}">${escapeHtml(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  out += escapeHtml(src.slice(last));
  return out;
}

export class CodeEditor {
  constructor(container, { onChange, onSubmit } = {}) {
    this.onChange = onChange;
    this.onSubmit = onSubmit;
    this.errorLines = new Set();

    container.classList.add('ce-wrap');
    container.innerHTML = `
      <div class="ce-gutter"></div>
      <div class="ce-body">
        <pre class="ce-highlight" aria-hidden="true"><code></code></pre>
        <textarea class="ce-input" spellcheck="false" autocomplete="off" autocapitalize="off" wrap="off"></textarea>
      </div>`;
    this.gutter = container.querySelector('.ce-gutter');
    this.pre = container.querySelector('.ce-highlight');
    this.code = container.querySelector('code');
    this.ta = container.querySelector('.ce-input');

    this.ta.addEventListener('input', () => { this._render(); this.onChange?.(this.getValue()); });
    this.ta.addEventListener('scroll', () => {
      this.pre.scrollTop = this.ta.scrollTop;
      this.pre.scrollLeft = this.ta.scrollLeft;
      this.gutter.scrollTop = this.ta.scrollTop;
    });
    this.ta.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        this._insert('  ');
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.onSubmit?.();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const v = this.ta.value;
        const start = this.ta.selectionStart;
        const lineStart = v.lastIndexOf('\n', start - 1) + 1;
        const indent = (v.slice(lineStart, start).match(/^[ \t]*/) || [''])[0];
        this._insert('\n' + indent);
      }
    });
  }

  _insert(text) {
    const ta = this.ta;
    const s = ta.selectionStart;
    const e = ta.selectionEnd;
    ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
    ta.selectionStart = ta.selectionEnd = s + text.length;
    this._render();
    this.onChange?.(this.getValue());
  }

  setValue(text) {
    this.ta.value = text ?? '';
    this._render();
  }

  getValue() { return this.ta.value; }

  setErrors(errors) {
    this.errorLines = new Set(errors.map((e) => e.line));
    this._renderGutter();
  }

  _render() {
    // trailing newline so the last empty line has height
    this.code.innerHTML = highlight(this.ta.value) + '\n';
    this._renderGutter();
  }

  _renderGutter() {
    const lines = this.ta.value.split('\n').length;
    let html = '';
    for (let i = 1; i <= lines; i++) {
      html += `<div class="ce-ln${this.errorLines.has(i) ? ' ce-ln-err' : ''}">${i}</div>`;
    }
    this.gutter.innerHTML = html;
    this.gutter.scrollTop = this.ta.scrollTop;
  }
}
