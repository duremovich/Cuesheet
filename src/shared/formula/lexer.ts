// Formula tokenizer (R12). See ./index.ts for the language.

export type TokenType = "num" | "str" | "ident" | "op" | "(" | ")" | "," | "." | "eof";

export interface Token {
  type: TokenType;
  /** Number text, the string's value, the identifier, or the operator. */
  text: string;
  /** Offset in the source (for messages). */
  pos: number;
}

export class FormulaSyntaxError extends Error {
  constructor(
    message: string,
    readonly pos: number,
  ) {
    super(message);
  }
}

const OPERATORS = ["<=", ">=", "<>", "!=", "==", "+", "-", "*", "/", "%", "^", "&", "=", "<", ">"];

/**
 * Source → tokens. Identifiers are letters, digits and `_` (not starting with a digit), or
 * any text in braces: `{Pixel width}`. Strings use "..." or '...'; a doubled quote or a
 * backslash escapes the quote (`"say ""hi"""`, `'it\'s'`). Throws FormulaSyntaxError.
 */
export function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i] as string;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    const start = i;
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      const m = /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i.exec(src.slice(i));
      const text = m?.[0] ?? ch;
      out.push({ type: "num", text, pos: start });
      i += text.length;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let value = "";
      i++;
      for (;;) {
        if (i >= src.length) throw new FormulaSyntaxError("Unclosed string", start);
        const c = src[i] as string;
        if (c === "\\" && i + 1 < src.length) {
          value += src[i + 1];
          i += 2;
        } else if (c === ch) {
          if (src[i + 1] === ch) {
            value += ch;
            i += 2;
          } else {
            i++;
            break;
          }
        } else {
          value += c;
          i++;
        }
      }
      out.push({ type: "str", text: value, pos: start });
      continue;
    }
    if (ch === "{") {
      const end = src.indexOf("}", i + 1);
      if (end < 0) throw new FormulaSyntaxError("Unclosed {field name}", start);
      const name = src.slice(i + 1, end).trim();
      if (!name) throw new FormulaSyntaxError("Empty {field name}", start);
      out.push({ type: "ident", text: name, pos: start });
      i = end + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
      const text = m?.[0] ?? ch;
      out.push({ type: "ident", text, pos: start });
      i += text.length;
      continue;
    }
    if (ch === "(" || ch === ")" || ch === "," || ch === ".") {
      out.push({ type: ch, text: ch, pos: start });
      i++;
      continue;
    }
    const op = OPERATORS.find((o) => src.startsWith(o, i));
    if (op) {
      out.push({ type: "op", text: op, pos: start });
      i += op.length;
      continue;
    }
    throw new FormulaSyntaxError(`Unexpected "${ch}"`, start);
  }
  out.push({ type: "eof", text: "", pos: src.length });
  return out;
}
