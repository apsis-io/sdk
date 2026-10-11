// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { declareBackstop } from '@apsis-io/perseid/backstop.js'

/**
 * The podmaker's park bound.
 *
 * ⚠ ***THIS PROGRAM IS THE ONE THAT CAUSED A WRITE STORM***, so its bound is
 * worth reading rather than copying. It parks on `anyOf(objectGone(POD),
 * deadline(now+30s))`, and at `3b1c16244` the wake attribution evaluated that at
 * the WALL CLOCK: every 30s the author's own deadline fired, the whole
 * expression was true, the wake was attributed to the CONDITION, the obligation
 * tracker was invalidated, and the Create was re-applied - 8 writes in 3.5
 * minutes on a pod that existed throughout.
 *
 * That is fixed (attributeWake pins Now() at park time), and the reason it is
 * recalled here is narrower: this program parks on something that genuinely
 * disappears, so the backstop is a safety net rather than its clock. 60s.
 */
/**
 * ⭐ ***30s, MOVED HERE FROM THE PARK (2026-09-07) - THE PACE IS STATED ONCE.***
 *
 * This declared 60s while every park in the program ALSO disjoined
 * `deadline(Date.now() + RECHECK_MS)` at 30s. The host takes the MINIMUM of the
 * declared bound and its flag (`internal/perseidrun/assemble.go`, `backstopFor`),
 * so the operand was the real pace and this number was decorative - two places
 * saying how long the program may sleep, and the quieter one winning.
 *
 * The operand is gone and the effective bound is UNCHANGED at 30s. What changed
 * is that it is now readable off the artifact, refusable at admission, and
 * adjustable without touching the step.
 */
export const backstop = declareBackstop.seconds(30)
