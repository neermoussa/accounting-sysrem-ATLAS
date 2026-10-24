// backend/lib/analytics/expr.js
//
// Prompt 12b — calculated ratios in the Report Builder. A tiny, SAFE
// arithmetic language; never eval / new Function / vm:
//   numbers (1, 2.5, .5), measure names from the query's own measures,
//   + - * / , unary minus, parentheses.
// parse() turns the text into a small AST (or throws ExprError with an
// Arabic message); evaluate() walks the AST over one row of measure values.
// Division by zero, or any missing operand, gives null (shown as "—"),
// never Infinity / NaN. Limits keep a hostile input cheap: 200 characters,
// 60 tokens, nesting depth 20.

const MAX_LEN = 200;
const MAX_TOKENS = 60;
const MAX_DEPTH = 20;

class ExprError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.status = 400;
  }
}
const fail = (code, message) => { throw new ExprError(code, message); };

function tokenize(text) {
  if (typeof text !== 'string' || !text.trim()) fail('expr_empty', 'اكتب معادلة النسبة');
  if (text.length > MAX_LEN) fail('expr_too_long', `المعادلة أطول من ${MAX_LEN} حرفًا`);
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === ' ' || ch === '\t') { i += 1; continue; }
    if ('+-*/()'.includes(ch)) { tokens.push({ t: ch }); i += 1; continue; }
    const num = /^(\d+(\.\d+)?|\.\d+)/.exec(text.slice(i));
    if (num) { tokens.push({ t: 'num', v: Number(num[0]) }); i += num[0].length; continue; }
    const id = /^[a-z_][a-z0-9_]*/.exec(text.slice(i));
    if (id) { tokens.push({ t: 'id', v: id[0] }); i += id[0].length; continue; }
    fail('expr_bad_char', `حرف غير مسموح في المعادلة: «${ch}»`);
  }
  if (tokens.length > MAX_TOKENS) fail('expr_too_long', 'المعادلة طويلة جدًا');
  return tokens;
}

// expr   := term (('+' | '-') term)*
// term   := unary (('*' | '/') unary)*
// unary  := '-' unary | atom
// atom   := num | id | '(' expr ')'
function parse(text, allowedNames = []) {
  const tokens = tokenize(text);
  const allowed = new Set(allowedNames);
  let pos = 0;
  const peek = () => tokens[pos];
  const take = () => tokens[pos++];
  // Depth = nesting of parentheses and unary minus (not parser frames).
  const depthGuard = (d) => { if (d > MAX_DEPTH) fail('expr_too_deep', 'المعادلة متداخلة أكثر من اللازم'); };
  function expr(d) {
    let node = term(d);
    while (peek() && (peek().t === '+' || peek().t === '-')) node = { op: take().t, a: node, b: term(d) };
    return node;
  }
  function term(d) {
    let node = unary(d);
    while (peek() && (peek().t === '*' || peek().t === '/')) node = { op: take().t, a: node, b: unary(d) };
    return node;
  }
  function unary(d) {
    if (peek() && peek().t === '-') { take(); depthGuard(d + 1); return { op: 'neg', a: unary(d + 1) }; }
    return atom(d);
  }
  function atom(d) {
    const tk = take();
    if (!tk) fail('expr_incomplete', 'المعادلة ناقصة');
    if (tk.t === 'num') return { num: tk.v };
    if (tk.t === 'id') {
      if (!allowed.has(tk.v)) fail('expr_unknown_name', `«${tk.v}» ليس مقياسًا في هذا التقرير`);
      return { ref: tk.v };
    }
    if (tk.t === '(') {
      depthGuard(d + 1);
      const node = expr(d + 1);
      if (!peek() || take().t !== ')') fail('expr_paren', 'قوس غير مغلق');
      return node;
    }
    fail('expr_syntax', 'صيغة المعادلة غير صحيحة');
  }
  const ast = expr(0);
  if (pos !== tokens.length) fail('expr_syntax', 'صيغة المعادلة غير صحيحة');
  return ast;
}

// Names the expression reads (to validate and to order calculated measures).
function refs(ast, out = new Set()) {
  if (ast.ref) out.add(ast.ref);
  if (ast.a) refs(ast.a, out);
  if (ast.b) refs(ast.b, out);
  return out;
}

function evaluate(ast, values) {
  if (ast.num !== undefined) return ast.num;
  if (ast.ref !== undefined) {
    const v = values[ast.ref];
    return v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v);
  }
  const a = evaluate(ast.a, values);
  if (ast.op === 'neg') return a === null ? null : -a;
  const b = evaluate(ast.b, values);
  if (a === null || b === null) return null;
  switch (ast.op) {
    case '+': return a + b;
    case '-': return a - b;
    case '*': return a * b;
    case '/': return b === 0 ? null : a / b;
    default: return null;
  }
}

module.exports = { parse, evaluate, refs, ExprError, MAX_LEN };
