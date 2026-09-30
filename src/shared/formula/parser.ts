// Formula parser (R12): a Pratt parser over ./lexer.ts tokens. See ./index.ts.
import { FormulaSyntaxError, type Token, tokenize } from "./lexer";

export type BinaryOp =
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "^"
  | "&"
  | "="
  | "!="
  | "<"
  | "<="
  | ">"
  | ">=";

export type Node =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "bool"; v: boolean }
  /** A field of the record (`width`, `{Pixel width}`). */
  | { t: "ref"; name: string }
  /** `obj.name`: a pixel size's `.w`/`.h`, or a link's field (`parent.width`). */
  | { t: "member"; obj: Node; name: string }
  | { t: "call"; fn: string; args: Node[] }
  | { t: "neg"; arg: Node }
  | { t: "bin"; op: BinaryOp; l: Node; r: Node };

/** Binding power of each infix operator (higher binds tighter). */
const INFIX: Record<string, { bp: number; op: BinaryOp; right?: boolean }> = {
  "=": { bp: 10, op: "=" },
  "==": { bp: 10, op: "=" },
  "!=": { bp: 10, op: "!=" },
  "<>": { bp: 10, op: "!=" },
  "<": { bp: 10, op: "<" },
  "<=": { bp: 10, op: "<=" },
  ">": { bp: 10, op: ">" },
  ">=": { bp: 10, op: ">=" },
  "&": { bp: 20, op: "&" },
  "+": { bp: 30, op: "+" },
  "-": { bp: 30, op: "-" },
  "*": { bp: 40, op: "*" },
  "/": { bp: 40, op: "/" },
  "%": { bp: 40, op: "%" },
  "^": { bp: 60, op: "^", right: true },
};
/** Unary minus: tighter than * and /, looser than ^ (-2^2 = -4). */
const PREFIX_BP = 50;
const MEMBER_BP = 80;

/**
 * `depth`: the formula nests deeper than MAX_DEPTH (brackets, calls, operator chains),
 * refused so evaluation can't exhaust the stack.
 */
export type ParseResult = { ast: Node } | { error: string; pos: number; depth?: true };

/** The deepest a formula may nest (parser recursion and AST depth). */
export const MAX_DEPTH = 200;

class DepthError extends FormulaSyntaxError {}

/** Source → AST, or `{error, pos}` (never throws). */
export function parse(src: string): ParseResult {
  try {
    const p = new Parser(tokenize(src));
    if (p.peek().type === "eof") throw new FormulaSyntaxError("Empty formula", 0);
    const ast = p.expr(0);
    const rest = p.peek();
    if (rest.type !== "eof") throw new FormulaSyntaxError(`Unexpected "${rest.text}"`, rest.pos);
    // Left-leaning chains (1+1+1…) are built by a loop, not recursion: measure them too.
    if (astDepth(ast) > MAX_DEPTH) throw new DepthError(tooDeep, 0);
    return { ast };
  } catch (e) {
    if (e instanceof DepthError) return { error: e.message, pos: e.pos, depth: true };
    if (e instanceof FormulaSyntaxError) return { error: e.message, pos: e.pos };
    throw e;
  }
}

const tooDeep = `Formula nests more than ${MAX_DEPTH} levels deep`;

/** The AST's depth, measured with an explicit stack (no recursion). */
export function astDepth(root: Node): number {
  let max = 0;
  const stack: [Node, number][] = [[root, 1]];
  while (stack.length) {
    const [n, d] = stack.pop() as [Node, number];
    if (d > max) max = d;
    if (d > MAX_DEPTH) return d;
    switch (n.t) {
      case "member":
        stack.push([n.obj, d + 1]);
        break;
      case "neg":
        stack.push([n.arg, d + 1]);
        break;
      case "bin":
        stack.push([n.l, d + 1], [n.r, d + 1]);
        break;
      case "call":
        for (const a of n.args) stack.push([a, d + 1]);
        break;
      default:
        break;
    }
  }
  return max;
}

class Parser {
  private i = 0;
  private depth = 0;
  constructor(private readonly tokens: Token[]) {}

  peek(): Token {
    return this.tokens[this.i] as Token;
  }

  private next(): Token {
    const t = this.peek();
    if (t.type !== "eof") this.i++;
    return t;
  }

  private expect(type: Token["type"], what: string): Token {
    const t = this.next();
    if (t.type !== type) {
      throw new FormulaSyntaxError(
        t.type === "eof" ? `Expected ${what} at the end` : `Expected ${what}, got "${t.text}"`,
        t.pos,
      );
    }
    return t;
  }

  expr(minBp: number): Node {
    if (++this.depth > MAX_DEPTH) throw new DepthError(tooDeep, this.peek().pos);
    try {
      return this.exprInner(minBp);
    } finally {
      this.depth--;
    }
  }

  private exprInner(minBp: number): Node {
    let left = this.prefix();
    for (;;) {
      const t = this.peek();
      if (t.type === ".") {
        if (MEMBER_BP < minBp) break;
        this.next();
        const name = this.expect("ident", "a field name after '.'");
        left = { t: "member", obj: left, name: name.text };
        continue;
      }
      if (t.type !== "op") break;
      const info = INFIX[t.text];
      if (!info || info.bp < minBp) break;
      this.next();
      const right = this.expr(info.right ? info.bp : info.bp + 1);
      left = { t: "bin", op: info.op, l: left, r: right };
    }
    return left;
  }

  private prefix(): Node {
    const t = this.next();
    switch (t.type) {
      case "num": {
        const v = Number(t.text);
        if (!Number.isFinite(v)) throw new FormulaSyntaxError(`Bad number "${t.text}"`, t.pos);
        return { t: "num", v };
      }
      case "str":
        return { t: "str", v: t.text };
      case "ident": {
        const upper = t.text.toUpperCase();
        if (this.peek().type === "(" && /^[A-Za-z_]\w*$/.test(t.text)) {
          this.next();
          const args: Node[] = [];
          if (this.peek().type !== ")") {
            for (;;) {
              args.push(this.expr(0));
              if (this.peek().type === ",") {
                this.next();
                continue;
              }
              break;
            }
          }
          this.expect(")", "')'");
          return { t: "call", fn: upper, args };
        }
        if (upper === "TRUE" || upper === "FALSE") return { t: "bool", v: upper === "TRUE" };
        return { t: "ref", name: t.text };
      }
      case "(": {
        const inner = this.expr(0);
        this.expect(")", "')'");
        return inner;
      }
      case "op":
        if (t.text === "-") return { t: "neg", arg: this.expr(PREFIX_BP) };
        if (t.text === "+") return this.expr(PREFIX_BP);
        throw new FormulaSyntaxError(`Unexpected "${t.text}"`, t.pos);
      case "eof":
        throw new FormulaSyntaxError("Unexpected end of formula", t.pos);
      default:
        throw new FormulaSyntaxError(`Unexpected "${t.text}"`, t.pos);
    }
  }
}

/**
 * The fields a formula reads: `width`, and link paths like `parent.pixel_width` (the link
 * `parent` is listed too). Sorted, without duplicates; [] when it doesn't parse.
 */
export function dependencies(src: string | Node): string[] {
  const ast = typeof src === "string" ? parse(src) : { ast: src };
  if (!("ast" in ast)) return [];
  const out = new Set<string>();
  const path = (n: Node): string | null => {
    if (n.t === "ref") return n.name;
    if (n.t === "member") {
      const base = path(n.obj);
      return base === null ? null : `${base}.${n.name}`;
    }
    return null;
  };
  const walk = (n: Node): void => {
    switch (n.t) {
      case "ref":
        out.add(n.name);
        return;
      case "member": {
        const p = path(n);
        if (p) {
          const parts = p.split(".");
          for (let k = 1; k <= parts.length; k++) out.add(parts.slice(0, k).join("."));
        } else walk(n.obj);
        return;
      }
      case "call":
        for (const a of n.args) walk(a);
        return;
      case "neg":
        walk(n.arg);
        return;
      case "bin":
        walk(n.l);
        walk(n.r);
        return;
      default:
        return;
    }
  };
  walk(ast.ast);
  return [...out].sort();
}
