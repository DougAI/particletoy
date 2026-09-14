// Particle Verse: a deliberately small, deterministic Verse-shaped language.
// Parsing produces inert data. No source text is ever passed to eval/Function.

export const PARTICLE_VERSE_VERSION = 1;
const HANDLER = /^(OnBegin|OnTick|OnEvent)(?:\((.*?)\))?:void=$/;
const CALL = /^([A-Z][A-Za-z0-9_]*)\.([A-Z][A-Za-z0-9_]*)\((.*)\)$/;
const SIMPLE_CALL = /^(Wait|Emit)\((.*)\)$/;

function diagnostic(line, column, message) { return { line, column, message }; }

function splitArgs(text, line, diagnostics) {
  if (!text.trim()) return [];
  const args = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let i = 0; i <= text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    if ((char === ',' && !quoted) || i === text.length) {
      const token = text.slice(start, i).trim();
      if (!token) diagnostics.push(diagnostic(line, start + 1, 'Expected an argument'));
      else if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(token)) args.push({ type: 'Number', value: Number(token) });
      else if (/^(true|false)$/.test(token)) args.push({ type: 'Boolean', value: token === 'true' });
      else if (/^"(?:[^"\\]|\\.)*"$/.test(token)) {
        try { args.push({ type: 'String', value: JSON.parse(token) }); }
        catch { diagnostics.push(diagnostic(line, start + 1, 'Invalid string literal')); }
      } else if (/^(Time|Delta)$/.test(token)) args.push({ type: 'Identifier', name: token });
      else diagnostics.push(diagnostic(line, start + 1, `Unsupported expression: ${token}`));
      start = i + 1;
    }
  }
  if (quoted) diagnostics.push(diagnostic(line, text.length, 'Unterminated string literal'));
  return args;
}

function parseStatement(text, line, diagnostics) {
  const call = text.match(CALL);
  if (call) return { type: 'Call', namespace: call[1], method: call[2], args: splitArgs(call[3], line, diagnostics), line };
  const simple = text.match(SIMPLE_CALL);
  if (simple) return { type: simple[1], args: splitArgs(simple[2], line, diagnostics), line };
  diagnostics.push(diagnostic(line, 1, `Unsupported statement: ${text}`));
  return null;
}

export function parseParticleVerse(source) {
  const diagnostics = [];
  const ast = { type: 'Program', version: PARTICLE_VERSE_VERSION, handlers: [] };
  if (typeof source !== 'string' || source.length > 64 * 1024) {
    return { ast: null, diagnostics: [diagnostic(1, 1, 'Script must be text under 64 KB')] };
  }
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  let first = lines.findIndex((line) => line.trim() && !line.trim().startsWith('#'));
  if (first < 0 || lines[first].trim() !== `particle_verse := ${PARTICLE_VERSE_VERSION}`) {
    diagnostics.push(diagnostic(Math.max(1, first + 1), 1, `First declaration must be particle_verse := ${PARTICLE_VERSE_VERSION}`));
  }
  let handler = null;
  for (let i = first + 1; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (/\t/.test(raw.slice(0, raw.search(/\S/)))) {
      diagnostics.push(diagnostic(i + 1, 1, 'Use spaces for indentation, not tabs'));
      continue;
    }
    const indent = raw.length - raw.trimStart().length;
    if (indent === 0) {
      const match = trimmed.match(HANDLER);
      if (!match) {
        diagnostics.push(diagnostic(i + 1, 1, 'Expected OnBegin, OnTick, or OnEvent handler'));
        handler = null;
        continue;
      }
      const eventArgs = splitArgs(match[2] || '', i + 1, diagnostics);
      handler = { type: 'Handler', name: match[1], event: match[1] === 'OnEvent' ? eventArgs[0]?.value : null, body: [], line: i + 1 };
      if (handler.name === 'OnEvent' && (eventArgs.length !== 1 || typeof handler.event !== 'string')) {
        diagnostics.push(diagnostic(i + 1, 1, 'OnEvent requires one string event name'));
      }
      ast.handlers.push(handler);
      continue;
    }
    if (indent !== 4) {
      diagnostics.push(diagnostic(i + 1, 1, 'Handler statements must be indented by four spaces'));
      continue;
    }
    if (!handler) {
      diagnostics.push(diagnostic(i + 1, 1, 'Statement appears outside a handler'));
      continue;
    }
    const statement = parseStatement(trimmed, i + 1, diagnostics);
    if (statement) handler.body.push(statement);
  }
  for (const name of ['OnBegin', 'OnTick']) {
    if (ast.handlers.filter((item) => item.name === name).length > 1) diagnostics.push(diagnostic(1, 1, `${name} may only be declared once`));
  }
  return { ast: diagnostics.length ? null : ast, diagnostics };
}

export function formatVerseDiagnostics(diagnostics) {
  return diagnostics.map((item) => `${item.line}:${item.column} ${item.message}`).join('\n');
}

function valueOf(expression, time, delta) {
  if (expression.type === 'Identifier') return expression.name === 'Time' ? time : delta;
  return expression.value;
}

export class ParticleVerseRuntime {
  constructor(ast, { dispatch = () => {}, instructionBudget = 500 } = {}) {
    if (!ast || ast.type !== 'Program') throw new Error('Particle Verse runtime requires a parsed Program');
    this.ast = ast;
    this.dispatch = dispatch;
    this.instructionBudget = Math.max(1, Math.min(10_000, instructionBudget | 0));
    this.time = 0;
    this.tasks = [];
    this.lastError = null;
  }

  handlers(name, event = null) {
    return this.ast.handlers.filter((item) => item.name === name && (name !== 'OnEvent' || item.event === event));
  }

  enqueue(handler) { this.tasks.push({ handler, pc: 0, wake: this.time }); }

  restart() {
    this.time = 0;
    this.tasks = [];
    this.lastError = null;
    for (const handler of this.handlers('OnBegin')) this.enqueue(handler);
    return this.run(0);
  }

  tick(delta) {
    if (!Number.isFinite(delta) || delta < 0) throw new Error('Particle Verse delta must be a finite non-negative number');
    this.time += delta;
    for (const handler of this.handlers('OnTick')) this.enqueue(handler);
    return this.run(delta);
  }

  run(delta) {
    let instructions = 0;
    for (let i = 0; i < this.tasks.length;) {
      const task = this.tasks[i];
      if (task.wake > this.time + 1e-9) { i++; continue; }
      let yielded = false;
      while (task.pc < task.handler.body.length) {
        if (++instructions > this.instructionBudget) {
          this.lastError = { line: task.handler.body[task.pc]?.line || task.handler.line, column: 1, message: `Instruction budget of ${this.instructionBudget} exceeded` };
          this.tasks = [];
          return { instructions, error: this.lastError };
        }
        const statement = task.handler.body[task.pc++];
        const args = statement.args.map((arg) => valueOf(arg, this.time, delta));
        if (statement.type === 'Wait') {
          const seconds = Number(args[0]);
          if (!Number.isFinite(seconds) || seconds < 0 || seconds > 60) {
            this.lastError = { line: statement.line, column: 1, message: 'Wait must be between 0 and 60 seconds' };
            this.tasks = [];
            return { instructions, error: this.lastError };
          }
          task.wake = this.time + seconds;
          yielded = true;
          break;
        }
        this.dispatch({ namespace: statement.namespace || statement.type, method: statement.method || statement.type, args, line: statement.line });
      }
      if (task.pc >= task.handler.body.length) this.tasks.splice(i, 1);
      else if (yielded) i++;
    }
    return { instructions, error: null };
  }
}
