// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { declareBackstop } from '@apsis-io/perseid/backstop.js'

/**
 * The drainer's park bound.
 *
 * ⚠ ***THIS WAS "THE ONLY PROGRAM HERE WHOSE BACKSTOP IS LOAD-BEARING RATHER
 * THAN A SAFETY NET" UNTIL 2026-09-06, AND IT IS NOW A SAFETY NET LIKE THE
 * OTHERS.*** The claim was: a drain request arrives as an annotation on a NODE,
 * a cluster-scoped subject cannot be wake-indexed at all (`NormalizeSubject`
 * refuses any subject whose namespace differs from the grant's, and a Node has
 * none), so this bound IS the latency of noticing a drain.
 *
 * That was true when written. Three changes retired it and it took all three -
 * a cluster arm in the wake index bounded by `spec.reads`, a node informer in
 * radiant to feed it, and `Get` learning to READ a cluster path so the condition
 * can evaluate. **Measured: 128ms to notice a request, 125ms to notice its
 * withdrawal**, both reported by radiant as "via the wake index".
 *
 * ⇒ So the number below is no longer the latency of anything an operator waits
 * on. It is what fires if the index misses - which is what a backstop is for,
 * and why it stays.
 *
 * 45s. This used to read "tighter than the 60s recheck the program declares, so
 * whichever fires first...". ***THAT 60s OPERAND WAS DEAD AND THIS COMMENT SAID
 * SO WITHOUT ANYONE NOTICING*** - the host takes the MINIMUM of the declared
 * bound and its flag (`internal/perseidrun/assemble.go`, `backstopFor`), so a
 * park operand at 60s could never fire before a declared bound of 45s. It was
 * removed 2026-09-07 and nothing changed.
 *
 * ⇒ THIS IS NOW THE ONLY PLACE THIS PROGRAM'S PACE IS STATED, which is the point:
 * a bound an operator can read off the artifact and admission can refuse, rather
 * than one buried in an expression assembled at runtime.
 */
export const backstop = declareBackstop.seconds(45)
