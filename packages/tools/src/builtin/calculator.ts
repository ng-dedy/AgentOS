import { z } from "zod";
import { ToolUserError } from "../registry";
import { defineTool } from "../types";

/**
 * Safe arithmetic evaluator (recursive descent). No eval, no identifiers other
 * than a fixed set of functions and constants.
 *
 * expr   := term (('+'|'-') term)*
 * term   := power (('*'|'/'|'%') power)*
 * power  := unary ('^' power)?
 * unary  := ('-'|'+') unary | call
 * call   := IDENT '(' args ')' | IDENT | NUMBER | '(' expr ')'
 */
const FUNCS: Record<string, (...a: number[]) => number> = {
  sqrt: Math.sqrt,
  abs: Math.abs,
  round: Math.round,
  floor: Math.floor,
  ceil: Math.ceil,
  min: Math.min,
  max: Math.max,
  ln: Math.log,
  log10: Math.log10,
};
const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E };

export function evaluateExpression(source: string): number {
  const tokens = tokenize(source);
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => {
    const t = tokens[pos++];
    if (t === undefined) throw new ToolUserError("Unexpected end of expression");
    return t;
  };
  const expect = (v: string) => {
    const t = next();
    if (t !== v) throw new ToolUserError(`Expected '${v}' but found '${t}'`);
  };

  const expr = (): number => {
    let v = term();
    while (peek() === "+" || peek() === "-") v = next() === "+" ? v + term() : v - term();
    return v;
  };
  const term = (): number => {
    let v = power();
    while (peek() === "*" || peek() === "/" || peek() === "%") {
      const op = next();
      const r = power();
      if ((op === "/" || op === "%") && r === 0) throw new ToolUserError("Division by zero");
      v = op === "*" ? v * r : op === "/" ? v / r : v % r;
    }
    return v;
  };
  const power = (): number => {
    const base = unary();
    if (peek() === "^") {
      next();
      return Math.pow(base, power());
    }
    return base;
  };
  const unary = (): number => {
    if (peek() === "-") {
      next();
      return -unary();
    }
    if (peek() === "+") {
      next();
      return unary();
    }
    return primary();
  };
  const primary = (): number => {
    const t = next();
    if (t === "(") {
      const v = expr();
      expect(")");
      return v;
    }
    if (/^[0-9.]/.test(t)) {
      const n = Number(t);
      if (!Number.isFinite(n)) throw new ToolUserError(`Invalid number '${t}'`);
      return n;
    }
    if (/^[a-z]/i.test(t)) {
      const name = t.toLowerCase();
      if (peek() === "(") {
        const fn = FUNCS[name];
        if (!fn) throw new ToolUserError(`Unknown function '${t}'`);
        next();
        const args: number[] = [];
        if (peek() !== ")") {
          args.push(expr());
          while (peek() === ",") {
            next();
            args.push(expr());
          }
        }
        expect(")");
        return fn(...args);
      }
      const c = CONSTS[name];
      if (c === undefined) throw new ToolUserError(`Unknown identifier '${t}'`);
      return c;
    }
    throw new ToolUserError(`Unexpected token '${t}'`);
  };

  const result = expr();
  if (pos !== tokens.length) throw new ToolUserError(`Unexpected token '${tokens[pos]}'`);
  if (!Number.isFinite(result)) throw new ToolUserError("Result is not a finite number");
  return result;
}

function tokenize(src: string): string[] {
  const out: string[] = [];
  const re = /\s*(\d+(?:\.\d+)?(?:e[+-]?\d+)?|\.\d+|[a-zA-Z_][a-zA-Z0-9_]*|[-+*/%^(),])/y;
  let i = 0;
  while (i < src.length) {
    if (/\s/.test(src[i] ?? "")) {
      i++;
      continue;
    }
    re.lastIndex = i;
    const m = re.exec(src);
    if (!m || m[1] === undefined) throw new ToolUserError(`Invalid character at position ${i}`);
    out.push(m[1]);
    i = re.lastIndex;
  }
  if (out.length === 0) throw new ToolUserError("Empty expression");
  return out;
}

export const calculatorTool = defineTool({
  name: "calculator",
  description:
    "Evaluate an arithmetic expression exactly as written. Supports + - * / % ^, parentheses, " +
    "sqrt, abs, round, floor, ceil, min, max, ln, log10, and constants pi and e.",
  inputSchema: z.object({ expression: z.string().min(1).max(500).describe("Arithmetic expression, e.g. (17 * 23) + 4") }).strict(),
  outputSchema: z.object({ expression: z.string(), result: z.number() }),
  permission: "tool:calculator",
  risk: "safe",
  requiresApproval: false,
  timeoutMs: 1000,
  handler: async ({ expression }) => ({ expression, result: evaluateExpression(expression) }),
});
