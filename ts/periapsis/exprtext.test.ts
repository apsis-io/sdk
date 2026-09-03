// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Runtime guards for the TEXT `create` emits - the half `expr.test.ts`
// deliberately does not cover (that file is type-only, checked by tsc; see its
// own header). These check the actual STRING content, because the defect this
// file exists for is invisible to the type checker: an array value typechecks
// fine either way, and only the RENDERED TEXT tells you whether it came out as
// a JSON array or a JSON object with scrambled keys.

import { expect, test } from 'bun:test'
import { create, length, listPods, minus, plus, times } from './expr'
import { objects } from './perseid'

// ***THE DEFECT: AN ARRAY VALUE RENDERED AS A SORTED-KEY OBJECT.*** `isStruct`
// used to accept anything with `typeof v === 'object'`, which is true for an
// array. `structText` then ran `Object.keys` (returning string indices),
// `.sort()` (lexicographic - '10' before '2') and wrapped the result in
// `{...}` - so a `command`/`args` array (podTemplate's, exactly this path;
// it reached here through an `as unknown as StructShape` that the array case
// in `StructShape` has since made unnecessary) rendered as a JSON OBJECT
// with its elements in the WRONG ORDER, which periapsis's grammar's
// array-literal rule (internal/aperture/grammar.go, "order is significant")
// cannot read back as the intended command.
test('a container command array renders as an array literal, elements in order', () => {
  const text = create(
    objects.ns('default').deployment('api').spec({
      replicas: 1,
      selector: { app: 'api' },
      containers: [{ name: 'api', image: 'nginx:alpine', command: ['sh', '-c', 'run'] }],
    }),
  )

  expect(text).toContain(`"command": ["sh", "-c", "run"]`)
})

// THE CASE THAT ACTUALLY CAUGHT THE BUG: ten-plus elements, where the
// lexicographic-sort defect reorders '10' and '11' ahead of '2'.
test('an args array with more than ten elements keeps numeric order', () => {
  const args = Array.from({ length: 12 }, (_, i) => `arg${i}`)
  const text = create(
    objects.ns('default').deployment('api').spec({
      replicas: 1,
      selector: { app: 'api' },
      containers: [{ name: 'api', image: 'nginx:alpine', args }],
    }),
  )

  const want = `["${args.join('", "')}"]`
  expect(text).toContain(`"args": ${want}`)
  // The lexicographic-sort defect would have put "arg10"/"arg11" right after
  // "arg1" and before "arg2" - assert the failure mode is actually absent,
  // not just that SOME array-shaped text appears.
  expect(text.indexOf('"arg10"')).toBeGreaterThan(text.indexOf('"arg9"'))
})

// CONTROL: a plain struct field (no array anywhere) still renders as an
// object with SORTED keys, exactly as before - the array exclusion must not
// have disabled struct rendering for everything else.
test('a struct field with no arrays still renders as a sorted object', () => {
  const text = create(
    objects.ns('default').deployment('api').spec({
      replicas: 3,
      selector: { app: 'api' },
      containers: [{ name: 'api', image: 'nginx:alpine' }],
    }),
  )

  expect(text).toContain(`{"image": "nginx:alpine", "name": "api"}`)
})

// ***THE DEFECT: A BARE Expr<'int'> REPLICAS COUNT WAS JSON-QUOTED AS A
// LITERAL STRING.*** `DeploymentSpec.replicas`'s own type is
// `number | Expr<'int'> | Expr<'observed-int'> | Expr<'value'>`, so a caller
// passing `plus(length(listPods('app=x')), 2)` is using a documented,
// type-checked input - but `Expr<T>` is a plain string at runtime (the brand
// is erased) and expr.ts's generic field renderer cannot tell that string
// apart from a literal one to quote. Without wrapping it in `computed()`
// before it reaches the renderer, `spec.replicas` came out as the quoted
// STRING `"ListPods(\"app=x\").length + 2"` instead of the live expression -
// silently writing the wrong type to the field, with no error signal since
// `create` returns nothing to the guest by contract.
test('a computed replicas count renders as bare expression text, not a quoted literal', () => {
  const count = plus(length(listPods('app=x')), 2)
  const text = create(
    objects.ns('default').deployment('api').spec({
      replicas: count,
      selector: { app: 'api' },
      containers: [{ name: 'api', image: 'nginx:alpine' }],
    }),
  )

  expect(text).toContain(`"replicas": ${count}`)
  // The failure mode, named explicitly: a quoted copy of the same text must
  // NOT also be present, or a loose `toContain` on the bare form would pass
  // against output that ALSO still has the quoted (wrong) form somewhere else.
  expect(text).not.toContain(`"replicas": "${count}"`)
})

// CONTROL: a plain number replicas count is unaffected - it must still render
// as a bare number, not routed through computed()/wrapped in any way.
test('a numeric replicas count still renders as a bare number', () => {
  const text = create(
    objects.ns('default').deployment('api').spec({
      replicas: 3,
      selector: { app: 'api' },
      containers: [{ name: 'api', image: 'nginx:alpine' }],
    }),
  )

  expect(text).toContain(`"replicas": 3`)
})

// ***THE DEFECT: `times(plus(a, b), c)` USED TO RENDER `"a + b * c"`.*** The
// grammar's `*` binds tighter than `+`, so unparenthesised text for a
// `plus` result embedded as an operand of `times` parsed as `a + (b * c)`
// instead of the intended `(a + b) * c` - silently computing the wrong
// value. This evaluates the emitted text as plain JS arithmetic (same
// operators, same grouping rules) rather than merely checking a substring,
// so it catches parens present in the WRONG place, not just parens absent.
test('times(plus(a, b), c) groups correctly, not by operator precedence alone', () => {
  const text = String(times(plus(2, 3), 4))
  // eslint-disable-next-line no-new-func -- evaluating our own generated
  // numeric-arithmetic text, not external input.
  const got = new Function(`return ${text}`)() as number

  expect(got).toBe((2 + 3) * 4)
  // Name the failure mode explicitly: the unparenthesised bug would have
  // evaluated to 2 + 3 * 4 = 14, not (2 + 3) * 4 = 20.
  expect(got).not.toBe(2 + 3 * 4)
})

// CONTROL: an expression that needs NO regrouping (no arith nested inside a
// tighter arith) must still evaluate to the same thing either way - the fix
// must not have broken the ordinary, unambiguous case.
test('plus(a, minus(b, c)) evaluates correctly', () => {
  const text = String(plus(10, minus(5, 2)))
  // eslint-disable-next-line no-new-func -- see above.
  const got = new Function(`return ${text}`)() as number

  expect(got).toBe(10 + (5 - 2))
})
