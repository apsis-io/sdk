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

import type * as E from './expr.js'

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
  ) {}

  /** A single comparison - whatever `expr.ts` rendered. */
  static leaf(text: E.Expr<'bool'>): ResumeNode {
    return new ResumeNode('leaf', text, [])
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
        return this.text
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
