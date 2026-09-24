// A hand-written tokenizer and recursive-descent parser for the documented JQL subset (canonical
// plan §7). It produces the transport-neutral IssueQuery from @records/contracts; names are
// resolved through a JqlResolver and dates are resolved against `now` at parse time.
//
//   query    := [or] [ORDER BY sortKey ("," sortKey)*]
//   or       := and ((OR | "||" | "|") and)*
//   and      := not ((AND | "&&" | "&") not)*
//   not      := (NOT | "!") not | "(" or ")" | clause
//   clause   := field operator operand
//   operator := "=" | "!=" | "~" | "!~" | "<" | "<=" | ">" | ">=" | IN | NOT IN | IS | IS NOT
//   operand  := value | "(" value ("," value)* ")" | function "(" [arg ("," arg)*] ")" | EMPTY | NULL
//
// Keywords and field names are case-insensitive. Anything outside the subset fails with a
// JqlError carrying Jira's 400 body.

import {
  ISSUE_QUERY_LIMITS,
  IssueQuerySchema,
  measureIssueQuery,
  type IssueOrder,
  type IssuePredicate,
  type IssueQuery,
  type IssueQueryNode,
  type Priority,
  type WorkflowCategory,
} from "@records/contracts";

import { JiraError } from "../errors.js";
import { priorityFromJira, statusCategoryFromJira } from "../values.js";
import { evaluateDateFunction, parseJqlDate, type DateContext } from "./dates.js";
import type { JqlResolver } from "./resolver.js";

export const JQL_MAX_LENGTH = 4000;

export class JqlError extends JiraError {
  override name = "JqlError";
  constructor(message: string) {
    super(400, [message]);
  }
}

export type JqlContext = { resolver: JqlResolver } & DateContext;

// ---------------------------------------------------------------------------------------------
// Tokens

type TokKind = "str" | "word" | "op" | "(" | ")" | "," | "&" | "|" | "!" | "eof";
type Tok = { kind: TokKind; value: string; pos: number };

const OPERATOR_LIST = "'=', '!=', '<', '>', '<=', '>=', '~', '!~', 'IN', 'NOT IN', 'IS' and 'IS NOT'";
const WORD_STOP = /[\s"'(),=!<>~&|]/;

function where(src: string, pos: number): string {
  const before = src.slice(0, pos);
  const line = before.split("\n").length;
  const character = pos - before.lastIndexOf("\n");
  return `(line ${line}, character ${character})`;
}

export function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const start = i;
    if (c === '"' || c === "'") {
      let value = "";
      i++;
      let closed = false;
      while (i < src.length) {
        const ch = src[i]!;
        if (ch === "\\" && i + 1 < src.length) {
          const next = src[i + 1]!;
          if (next === "u" && /^[0-9a-fA-F]{4}$/.test(src.slice(i + 2, i + 6))) {
            value += String.fromCharCode(parseInt(src.slice(i + 2, i + 6), 16));
            i += 6;
            continue;
          }
          value += next === "n" ? "\n" : next === "t" ? "\t" : next === "r" ? "\r" : next;
          i += 2;
          continue;
        }
        if (ch === c) {
          closed = true;
          i++;
          break;
        }
        value += ch;
        i++;
      }
      if (!closed) throw new JqlError(`Error in the JQL Query: The quoted string '${value}' has not been completed. ${where(src, start)}`);
      toks.push({ kind: "str", value, pos: start });
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === "!=" || two === "!~" || two === "<=" || two === ">=") {
      toks.push({ kind: "op", value: two, pos: start });
      i += 2;
      continue;
    }
    if (two === "&&" || two === "||") {
      toks.push({ kind: two[0] as "&" | "|", value: two, pos: start });
      i += 2;
      continue;
    }
    if (c === "=" || c === "~" || c === "<" || c === ">") {
      toks.push({ kind: "op", value: c, pos: start });
      i++;
      continue;
    }
    if (c === "(" || c === ")" || c === "," || c === "&" || c === "|" || c === "!") {
      toks.push({ kind: c, value: c, pos: start });
      i++;
      continue;
    }
    let value = "";
    while (i < src.length && !WORD_STOP.test(src[i]!)) {
      if (src[i] === "\\" && i + 1 < src.length) {
        value += src[i + 1];
        i += 2;
        continue;
      }
      value += src[i];
      i++;
    }
    toks.push({ kind: "word", value, pos: start });
  }
  toks.push({ kind: "eof", value: "", pos: src.length });
  return toks;
}

// ---------------------------------------------------------------------------------------------
// Fields

type FieldSpec =
  | { kind: "project" | "key" | "status" | "statusCategory" | "assignee" | "priority" | "issuetype" }
  | { kind: "date"; field: "created" | "updated" }
  | { kind: "text"; in: "all" | "title" | "description" };

const FIELDS: Record<string, FieldSpec> = {
  project: { kind: "project" },
  key: { kind: "key" },
  issuekey: { kind: "key" },
  issue: { kind: "key" },
  status: { kind: "status" },
  statuscategory: { kind: "statusCategory" },
  assignee: { kind: "assignee" },
  priority: { kind: "priority" },
  issuetype: { kind: "issuetype" },
  type: { kind: "issuetype" },
  created: { kind: "date", field: "created" },
  createddate: { kind: "date", field: "created" },
  updated: { kind: "date", field: "updated" },
  updateddate: { kind: "date", field: "updated" },
  text: { kind: "text", in: "all" },
  summary: { kind: "text", in: "title" },
  description: { kind: "text", in: "description" },
};

/** Jira fields a client might reasonably send that this server does not support. */
const KNOWN_UNSUPPORTED = new Set([
  "reporter", "creator", "labels", "sprint", "component", "fixversion", "affectedversion", "resolution",
  "resolved", "resolutiondate", "due", "duedate", "parent", "epic link", "watcher", "watchers", "comment",
  "environment", "votes", "voter", "worklogdate", "timespent", "originalestimate", "remainingestimate",
  "lastviewed", "filter", "request", "attachments", "level", "category", "statuscategorychangeddate", "id",
]);

const ORDER_FIELDS: Record<string, IssueOrder[number]["field"]> = {
  created: "created", createddate: "created", updated: "updated", updateddate: "updated",
  priority: "priority", key: "key", issuekey: "key", issue: "key",
};
/** Jira's default direction when ORDER BY names none. */
const DEFAULT_DIRECTION: Record<IssueOrder[number]["field"], "asc" | "desc"> = {
  created: "asc", updated: "asc", key: "asc", priority: "desc",
};

// ---------------------------------------------------------------------------------------------
// Operands

type Operand =
  | { kind: "value"; value: string; quoted: boolean; pos: number }
  | { kind: "empty"; pos: number }
  | { kind: "function"; name: string; args: string[]; pos: number };

type Op = "=" | "!=" | "~" | "!~" | "<" | "<=" | ">" | ">=" | "in" | "not in" | "is" | "is not";

const TRUE: IssueQueryNode = { type: "pred", field: "key", op: "not_in", values: [] };
const FALSE: IssueQueryNode = { type: "pred", field: "key", op: "in", values: [] };

function show(op: Op): string {
  return op.toUpperCase();
}

// ---------------------------------------------------------------------------------------------
// Parser

class Parser {
  private i = 0;
  private nesting = 0;
  private readonly toks: Tok[];

  /** Bound recursion before the tree is measured, so deep input cannot exhaust the stack. */
  private enter(): void {
    if (++this.nesting > 2 * ISSUE_QUERY_LIMITS.maxDepth) throw new JqlError("The JQL query is too complex. Simplify it and try again.");
  }

  constructor(private readonly src: string, private readonly ctx: JqlContext) {
    this.toks = tokenize(src);
  }

  private peek(offset = 0): Tok {
    return this.toks[Math.min(this.i + offset, this.toks.length - 1)]!;
  }
  private next(): Tok {
    const t = this.peek();
    if (t.kind !== "eof") this.i++;
    return t;
  }
  private isWord(t: Tok, word: string): boolean {
    return t.kind === "word" && t.value.toLowerCase() === word;
  }
  private describe(t: Tok): string {
    return t.kind === "eof" ? "end of query" : `'${t.value}'`;
  }
  private fail(message: string, t: Tok): never {
    throw new JqlError(`Error in the JQL Query: ${message} ${where(this.src, t.pos)}`);
  }

  parse(): IssueQuery {
    let whereNode: IssueQueryNode | null = null;
    if (this.peek().kind !== "eof" && !(this.isWord(this.peek(), "order") && this.isWord(this.peek(1), "by"))) {
      whereNode = this.parseOr();
    }
    const orderBy: IssueOrder = [];
    const t = this.peek();
    if (this.isWord(t, "order")) {
      this.next();
      const by = this.next();
      if (!this.isWord(by, "by")) this.fail(`Expecting 'BY' but got ${this.describe(by)}.`, by);
      for (;;) {
        const f = this.next();
        if (f.kind !== "word" && f.kind !== "str") this.fail(`Expecting a field name but got ${this.describe(f)}.`, f);
        const field = ORDER_FIELDS[f.value.toLowerCase()];
        if (!field) throw new JqlError(`Not able to sort using field '${f.value}'.`);
        let direction = DEFAULT_DIRECTION[field];
        if (this.isWord(this.peek(), "asc") || this.isWord(this.peek(), "desc")) direction = this.next().value.toLowerCase() as "asc" | "desc";
        if (orderBy.length >= ISSUE_QUERY_LIMITS.maxOrderKeys) throw new JqlError(`The JQL query orders by more than ${ISSUE_QUERY_LIMITS.maxOrderKeys} fields.`);
        orderBy.push({ field, direction });
        if (this.peek().kind !== ",") break;
        this.next();
      }
    }
    const end = this.peek();
    if (end.kind !== "eof") {
      this.fail(`Expecting either 'OR' or 'AND' but got ${this.describe(end)}.`, end);
    }
    const query: IssueQuery = { where: whereNode, orderBy };
    const { depth, nodes } = measureIssueQuery(whereNode);
    if (depth > ISSUE_QUERY_LIMITS.maxDepth || nodes > ISSUE_QUERY_LIMITS.maxNodes) {
      throw new JqlError("The JQL query is too complex. Simplify it and try again.");
    }
    const checked = IssueQuerySchema.safeParse(query);
    if (!checked.success) throw new JqlError(`The JQL query could not be interpreted: ${checked.error.issues[0]?.message ?? "invalid"}.`);
    return query;
  }

  private parseOr(): IssueQueryNode {
    const clauses = [this.parseAnd()];
    while (this.isWord(this.peek(), "or") || this.peek().kind === "|") {
      this.next();
      clauses.push(this.parseAnd());
    }
    return clauses.length === 1 ? clauses[0]! : { type: "or", clauses };
  }

  private parseAnd(): IssueQueryNode {
    const clauses = [this.parseNot()];
    while (this.isWord(this.peek(), "and") || this.peek().kind === "&") {
      this.next();
      clauses.push(this.parseNot());
    }
    return clauses.length === 1 ? clauses[0]! : { type: "and", clauses };
  }

  private parseNot(): IssueQueryNode {
    const t = this.peek();
    if (this.isWord(t, "not") || t.kind === "!") {
      this.next();
      this.enter();
      const clause = this.parseNot();
      this.nesting--;
      return { type: "not", clause };
    }
    if (t.kind === "(") {
      this.next();
      this.enter();
      const inner = this.parseOr();
      this.nesting--;
      const close = this.next();
      if (close.kind !== ")") {
        if (close.kind === "eof") throw new JqlError("Error in the JQL Query: Expecting ')' before the end of the query.");
        this.fail(`Expecting ')' but got ${this.describe(close)}.`, close);
      }
      return inner;
    }
    return this.parseClause();
  }

  private parseOperator(): Op {
    const t = this.next();
    if (t.kind === "op") return t.value as Op;
    if (t.kind === "word") {
      const w = t.value.toLowerCase();
      if (w === "in") return "in";
      if (w === "is") {
        if (this.isWord(this.peek(), "not")) {
          this.next();
          return "is not";
        }
        return "is";
      }
      if (w === "not" && this.isWord(this.peek(), "in")) {
        this.next();
        return "not in";
      }
      if (w === "was" || w === "changed") throw new JqlError(`The operator '${t.value.toUpperCase()}' is not supported by this Jira-compatible API.`);
    }
    if (t.kind === "eof") throw new JqlError(`Error in the JQL Query: Expecting operator before the end of the query. The valid operators are ${OPERATOR_LIST}.`);
    this.fail(`Expecting operator but got ${this.describe(t)}. The valid operators are ${OPERATOR_LIST}.`, t);
  }

  private parseSingleOperand(): Operand {
    const t = this.next();
    if (t.kind === "str") return { kind: "value", value: t.value, quoted: true, pos: t.pos };
    if (t.kind === "word") {
      const w = t.value.toLowerCase();
      if (this.peek().kind === "(") {
        this.next();
        const args: string[] = [];
        if (this.peek().kind !== ")") {
          for (;;) {
            const a = this.next();
            if (a.kind !== "word" && a.kind !== "str") this.fail(`Expecting a function argument but got ${this.describe(a)}.`, a);
            args.push(a.value);
            if (this.peek().kind !== ",") break;
            this.next();
          }
        }
        const close = this.next();
        if (close.kind !== ")") this.fail(`Expecting ')' but got ${this.describe(close)}.`, close);
        return { kind: "function", name: t.value, args, pos: t.pos };
      }
      if (w === "empty" || w === "null") return { kind: "empty", pos: t.pos };
      return { kind: "value", value: t.value, quoted: false, pos: t.pos };
    }
    if (t.kind === "eof") throw new JqlError("Error in the JQL Query: Expecting either a value, list or function before the end of the query.");
    this.fail(`Expecting either a value, list or function but got ${this.describe(t)}. You must surround '${t.value}' in quotation marks to use it as a value.`, t);
  }

  private parseListOperand(): Operand[] {
    if (this.peek().kind !== "(") {
      const single = this.parseSingleOperand();
      if (single.kind !== "function") this.fail(`Expecting '(' but got '${single.kind === "value" ? single.value : "EMPTY"}'.`, this.toks[this.i - 1]!);
      return [single];
    }
    this.next();
    const items: Operand[] = [];
    for (;;) {
      items.push(this.parseSingleOperand());
      if (items.length > ISSUE_QUERY_LIMITS.maxValues) throw new JqlError(`A list in the JQL query may hold at most ${ISSUE_QUERY_LIMITS.maxValues} values.`);
      const sep = this.next();
      if (sep.kind === ")") break;
      if (sep.kind !== ",") {
        if (sep.kind === "eof") throw new JqlError("Error in the JQL Query: Expecting ')' before the end of the query.");
        this.fail(`Expecting ',' or ')' but got ${this.describe(sep)}.`, sep);
      }
    }
    return items;
  }

  private parseClause(): IssueQueryNode {
    const f = this.next();
    if (f.kind !== "word" && f.kind !== "str") {
      if (f.kind === "eof") throw new JqlError("Error in the JQL Query: Expecting a field name before the end of the query.");
      this.fail(`Expecting a field name but got ${this.describe(f)}.`, f);
    }
    const name = f.value;
    const spec = FIELDS[name.toLowerCase()];
    if (!spec) {
      if (KNOWN_UNSUPPORTED.has(name.toLowerCase()) || /^cf\[\d+\]$/i.test(name) || /^customfield_\d+$/i.test(name)) {
        throw new JqlError(
          `Field '${name}' is not supported by this Jira-compatible API. Searchable fields are project, key, status, statusCategory, assignee, priority, issuetype, created, updated, summary, description and text.`,
        );
      }
      throw new JqlError(`Field '${name}' does not exist or you do not have permission to view it.`);
    }
    const op = this.parseOperator();
    const operands = op === "in" || op === "not in" ? this.parseListOperand() : [this.parseSingleOperand()];
    return this.build(name, spec, op, operands);
  }

  // -------------------------------------------------------------------------------------------
  // Clause construction

  private unsupportedOp(name: string, op: Op): never {
    throw new JqlError(`The operator '${show(op)}' is not supported by the '${name}' field.`);
  }

  private notFound(name: string, value: string): never {
    throw new JqlError(`The value '${value}' does not exist for the field '${name}'.`);
  }

  private functionNotSupported(name: string, fn: string): never {
    throw new JqlError(`Unable to find JQL function '${fn}()' for the field '${name}'.`);
  }

  private build(name: string, spec: FieldSpec, op: Op, operands: Operand[]): IssueQueryNode {
    const positive = op === "=" || op === "in" || op === "is";
    switch (spec.kind) {
      case "date":
        return this.buildDate(name, spec.field, op, operands[0]!);
      case "text": {
        if (op !== "~" && op !== "!~") this.unsupportedOp(name, op);
        const o = operands[0]!;
        if (o.kind !== "value") this.fail(`Expecting a text value for the field '${name}'.`, this.toks[this.i - 1]!);
        const value = o.value.replace(/[*?]/g, " ").trim();
        if (!value) throw new JqlError(`The value '${o.value}' is not a valid text search for the field '${name}'.`);
        return { type: "pred", field: "text", op, value: value.slice(0, 200), in: spec.in };
      }
      default:
        break;
    }

    if (op === "~" || op === "!~" || op === "<" || op === "<=" || op === ">" || op === ">=") this.unsupportedOp(name, op);
    const emptyAllowed = spec.kind === "assignee" || spec.kind === "priority" || spec.kind === "issuetype";
    if ((op === "is" || op === "is not") && (!emptyAllowed || operands[0]!.kind !== "empty")) {
      if (!emptyAllowed) this.unsupportedOp(name, op);
      throw new JqlError(`The operator '${show(op)}' only supports EMPTY or NULL as a value for the '${name}' field.`);
    }

    // Collect resolved values and whether EMPTY was named.
    let wantsEmpty = false;
    const values: string[] = [];
    for (const o of operands) {
      if (o.kind === "empty") {
        if (!emptyAllowed) throw new JqlError(`The field '${name}' does not support searching for EMPTY values.`);
        wantsEmpty = true;
        continue;
      }
      if (o.kind === "function") {
        if (spec.kind === "assignee" && o.name.toLowerCase() === "currentuser") {
          if (o.args.length) throw new JqlError(`Function 'currentUser' expected '0' arguments but received '${o.args.length}'.`);
          const me = this.ctx.resolver.currentUser();
          if (me) values.push(me);
          continue;
        }
        this.functionNotSupported(name, o.name);
      }
      values.push(this.resolveValue(name, spec, o.value));
    }

    const listOp = op === "in" || op === "not in";
    const eqOp: "=" | "!=" | "in" | "not_in" = listOp ? (positive ? "in" : "not_in") : positive ? "=" : "!=";

    if (spec.kind === "issuetype") {
      // One issue type exists, so these reduce to always/never.
      if (wantsEmpty && values.length === 0) return positive ? FALSE : TRUE;
      return positive ? TRUE : FALSE;
    }

    const leaf = (vals: string[]): IssuePredicate => {
      const dedup = [...new Set(vals)];
      switch (spec.kind) {
        case "project": return { type: "pred", field: "project", op: eqOp, values: dedup };
        case "key": return { type: "pred", field: "key", op: eqOp, values: dedup };
        case "status": return { type: "pred", field: "status", op: eqOp, values: dedup };
        case "statusCategory": return { type: "pred", field: "statusCategory", op: eqOp, values: dedup as WorkflowCategory[] };
        case "assignee": return { type: "pred", field: "assignee", op: eqOp, values: dedup };
        case "priority": return { type: "pred", field: "priority", op: eqOp, values: dedup as Priority[] };
      }
      throw new JqlError(`Field '${name}' cannot be searched this way.`);
    };

    if (!wantsEmpty) return leaf(values);
    const field = spec.kind as "assignee" | "priority";
    const empty: IssuePredicate = { type: "pred", field, op: positive ? "is_empty" : "is_not_empty", values: [] };
    if (values.length === 0) return empty;
    // `x in (EMPTY, a)` = empty OR in (a); `x not in (EMPTY, a)` = not empty AND not in (a).
    return positive ? { type: "or", clauses: [empty, leaf(values)] } : { type: "and", clauses: [empty, leaf(values)] };
  }

  private resolveValue(name: string, spec: FieldSpec, raw: string): string {
    const r = this.ctx.resolver;
    switch (spec.kind) {
      case "project":
        return r.project(raw) ?? this.notFound(name, raw);
      case "key": {
        const key = raw.trim().toUpperCase();
        if (!/^[A-Z][A-Z0-9]{1,9}-[1-9][0-9]{0,9}$/.test(key)) throw new JqlError(`The issue key '${raw}' for field '${name}' is invalid.`);
        return key;
      }
      case "status":
        return r.status(raw) ?? this.notFound(name, raw);
      case "statusCategory":
        return statusCategoryFromJira(raw) ?? this.notFound(name, raw);
      case "assignee":
        return r.user(raw) ?? this.notFound(name, raw);
      case "priority":
        return priorityFromJira(raw) ?? this.notFound(name, raw);
      case "issuetype":
        if (raw.trim().toLowerCase() === "task" || raw.trim() === "10001") return "task";
        return this.notFound(name, raw);
      default:
        return raw;
    }
  }

  private buildDate(name: string, field: "created" | "updated", op: Op, o: Operand): IssueQueryNode {
    if (op === "~" || op === "!~" || op === "in" || op === "not in" || op === "is" || op === "is not") this.unsupportedOp(name, op);
    let value: string | null = null;
    if (o.kind === "empty") throw new JqlError(`The field '${name}' does not support searching for EMPTY values.`);
    if (o.kind === "function") {
      const r = evaluateDateFunction(o.name, o.args, this.ctx);
      if (!r) this.functionNotSupported(name, o.name);
      if ("error" in r) throw new JqlError(r.error);
      value = r.value;
    } else {
      value = parseJqlDate(o.value, this.ctx);
      if (!value) {
        throw new JqlError(
          `Date value '${o.value}' for field '${name}' is invalid. Valid formats include: 'yyyy/MM/dd HH:mm', 'yyyy-MM-dd HH:mm', 'yyyy/MM/dd', 'yyyy-MM-dd', or a period format e.g. '-5d', '4w 2d'.`,
        );
      }
    }
    return { type: "pred", field, op: op as "=" | "!=" | "<" | "<=" | ">" | ">=", value };
  }
}

/**
 * Parse a JQL string into an IssueQuery. Throws JqlError (Jira's 400 body) for anything outside
 * the subset. An empty string matches everything.
 */
export function parseJql(jql: string, ctx: JqlContext): IssueQuery {
  if (jql.length > JQL_MAX_LENGTH) throw new JqlError(`The JQL query is too long; the limit is ${JQL_MAX_LENGTH} characters.`);
  return new Parser(jql, ctx).parse();
}
