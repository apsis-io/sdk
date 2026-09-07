// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// ═══════════════════════════════════════════════════════════════════════════
// A RESUME IS A TREE, NOT A STRING.
//
// engi, 2026-09-06: *"in sdk we should generate resume object, instead of
// manually adding || backstop and rendering (A || B)"*.
//
// ***WHAT THE STRING COST: THE SDK PARSED BACK OUT WHAT IT HAD JUST DISCARDED.***
// Every builder used to concatenate - `E.or` is `bs.map(paren).join(' || ')` -
// so by the time `on()` needed to know how many `||` operands an arm
// contributes, the structure was gone and it had to RE-DERIVE it from the text
// with a hand-written paren- and quote-aware scanner (`topLevelOrCount`).
//
// The host has the real answer and computes it from its own parse tree
// (`internal/aperture/eval.go`, `flattenOr`, recursive on both sides). Two
// definitions of one fact, in two languages, agreeing by care. Its comment
// records what happened when they stopped: *"MEASURED LIVE on `sentinel-demo`:
// four such arms flattened to FIVE operands ... a wake on the LAST arm ran the
// handler for the third. It reported a healthy cluster while a watched
// Deployment had zero pods."*
//
// Keeping the tree deletes the class. `operands` is a structural walk that
// mirrors `flattenOr` exactly, and there is nothing left to parse.
//
// ───────────────────────────────────────────────────────────────────────────
// ⚠ ***IT STILL CROSSES THE WIRE AS A STRING, AND NOTHING ABOUT THE HOST
// CHANGES.*** `examples/.../sentinel-main.ts` does `JSON.stringify(outcome)`, so
// `toJSON` renders and the host sees byte-identical bytes. `toString` covers
// template literals and `String(...)`. Measured before this was built, all four
// arms - stringify, computed key, template literal, structure preserved.
//
// ⚠ ***THE TREE SHAPE IS PRESERVED, NOT FLATTENED.*** `anyOf(anyOf(a,b), c)`
// renders `((a) || (b)) || (c)` exactly as the string form did, and `operands`
// recurses to answer 3 - which is what the host's own recursive flatten answers
// for the same text. Flattening at build time would have been equally correct
// and would have changed the emitted text of every nested park, so the refactor
// could not then be proven byte-identical. It is, against 22 captured cases.
// ═══════════════════════════════════════════════════════════════════════════

// A VALUE import, not `import type`: `collectExpr` tests `instanceof ExprNode`
// to tell a child node from a literal path, which needs the class at runtime.
import * as E from './expr.js'

type Kind = 'leaf' | 'or' | 'and' | 'backstop'

/**
 * One node of a park expression.
 *
 * Construct through the builders in `perseid.ts` (`fieldNe`, `anyOf`, …) - the
 * constructor is private so a resume cannot be assembled from text that nothing
 * checked.
 */
export class ResumeNode {
  private constructor(
    readonly kind: Kind,
    private readonly text: string,
    readonly of: readonly ResumeNode[],
    /**
     * The comparison this leaf IS - an expression node, not its rendering.
     *
     * ⭐ ***THE TREE USED TO STOP HERE.*** A leaf held the STRING `expr.ts` had
     * concatenated, so the boolean structure was inspectable and everything
     * below a comparison - which object, which field, which operator - was text
     * again. Holding the node is what lets a walker answer "what does this park
     * READ", which is how `spec.reads` is derived rather than hand-maintained.
     *
     * `null` for the two literal nodes (`backstop`, `always`): they are not
     * comparisons and have no operands to expose.
     */
    readonly expr: E.Expr<'bool'> | null = null,
  ) {}

  /** A single comparison, kept as the expression node it was built from. */
  static leaf(e: E.Expr<'bool'>): ResumeNode {
    return new ResumeNode('leaf', '', [], e)
  }

  /**
   * Wake at the host's backstop and nothing else.
   *
   * Its own kind rather than `leaf('false')`, because `anyOf` has to RECOGNISE
   * it to fold it away, and recognising it by rendered text would also match a
   * literal `false` an author wrote for some other reason.
   */
  static readonly backstop = new ResumeNode('backstop', 'false', [])

  /** Poll on the next tick - `true` holds immediately. */
  static readonly always = new ResumeNode('leaf', 'true', [])

  static or(of: readonly ResumeNode[]): ResumeNode {
    return new ResumeNode('or', '', of)
  }

  static and(of: readonly ResumeNode[]): ResumeNode {
    return new ResumeNode('and', '', of)
  }

  /**
   * How many operands this contributes to the host's FLATTENED disjunction.
   *
   * ***THIS IS `flattenOr`, STRUCTURALLY.*** `or` sums its children and
   * everything else is one - including `and`, which the host does not descend
   * into. `on()` maps a reported index back to an arm with this, so the two
   * definitions have to agree; being a walk over the same shape rather than a
   * scan over the rendered text is what makes them agree by construction.
   */
  get operands(): number {
    return this.kind === 'or' ? this.of.reduce((n, c) => n + c.operands, 0) : 1
  }

  /**
   * The aperture expression.
   *
   * ⚠ ***EVERY OPERAND IS PARENTHESISED, WHICH IS NOT COSMETIC.*** It is what
   * the string form did (`expr.ts`'s `paren`), and the emitted text is compared
   * against captured goldens - a park whose text changed would be a different
   * expression to the host even where it is the same to a reader.
   */
  render(): string {
    switch (this.kind) {
      case 'or':
        return this.of.map((c) => `(${c.render()})`).join(' || ')
      case 'and':
        return this.of.map((c) => `(${c.render()})`).join(' && ')
      default:
        // A comparison renders itself; `backstop`/`always` carry a literal.
        return this.expr === null ? this.text : this.expr.render()
    }
  }

  /** Template literals, `String(...)`, and computed object keys. */
  toString(): string {
    return this.render()
  }

  /**
   * ***WHAT LETS AN OUTCOME CARRY A TREE AND STILL SERIALIZE AS THE HOST
   * EXPECTS.*** A program's `-main.ts` does `JSON.stringify(outcome)`; with this,
   * `resume` comes out as the rendered string and neither the host nor the WIT
   * contract knows the guest kept a tree.
   */
  toJSON(): string {
    return this.render()
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// WHAT A PARK READS - derived, not declared.
//
// ⭐ ***THIS IS WHAT THE TREE IS FOR.*** A Perseid's `spec.reads` names the
// CLUSTER-SCOPED objects it may read, and it is written BY HAND in each
// program's YAML today. Nothing checks it against the park, and the failure is
// the quiet kind: a path the manifest does not declare reads ABSENT on every
// wake, an absent operand compares UNKNOWN, and the park simply never fires.
// The program looks subscribed and polls - `drainer.yaml`'s header is an account
// of exactly that costing a 60-second delay nobody could see.
//
// Deriving it from the park makes the two ONE FACT, the same way `derive-wit`
// makes the component's world one fact with the code that calls into it.
// ═══════════════════════════════════════════════════════════════════════════

/** The ops that READ an object or a collection. `parts[0]` is what they address. */
const READ_OPS = new Set(['Get', 'List', 'Fields'])

function collectExpr(e: E.ExprNode<E.ApType>, into: Set<string>): void {
  if (READ_OPS.has(e.op)) {
    const target = e.parts[0]
    // ***ONLY A LITERAL PATH.*** `Get(OwnedBy(pod), field)` addresses whatever
    // the traversal resolves to at evaluation time - a path the guest cannot
    // know and `spec.reads` cannot name. Recursing into it below still finds the
    // read the traversal itself performs.
    if (typeof target === 'string') into.add(target)
  }
  for (const p of e.parts) {
    if (p instanceof E.ExprNode) collectExpr(p as E.ExprNode<E.ApType>, into)
  }
}

/** Every object and collection path this park reads, sorted and deduplicated. */
export function readsOf(r: ResumeNode): readonly string[] {
  const found = new Set<string>()
  const walk = (n: ResumeNode): void => {
    if (n.expr !== null) collectExpr(n.expr as E.ExprNode<E.ApType>, found)
    n.of.forEach(walk)
  }
  walk(r)

  return [...found].sort()
}

/**
 * The subset a Perseid's `spec.reads` must declare: the CLUSTER-SCOPED paths.
 *
 * ***NAMESPACED READS ARE NOT IN `spec.reads` AND ADDING THEM WOULD BE WRONG.***
 * They are bounded by the grant's namespace, which is the whole point of a
 * namespaced grant; `spec.reads` exists for objects that have no namespace to
 * bound them. Collections are not consulted for it either.
 *
 * The test is the absence of `/namespaces/`, which is a property of the
 * canonical apiserver path rather than a guess: `path.nodes(n)` is
 * `/api/v1/nodes/n` and every namespaced builder puts `/namespaces/<ns>/` in.
 */
export function clusterReadsOf(r: ResumeNode): readonly string[] {
  return readsOf(r).filter((p) => !p.includes('/namespaces/'))
}
