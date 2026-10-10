// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { declareBackstop } from '@apsis-io/perseid/backstop.js'

/**
 * The janitor's park bound.
 *
 * 120s. A cleanup program is the one place a LONG bound is genuinely cheap: it
 * waits for objects to finish going away, nothing downstream is blocked on it,
 * and a late sweep costs storage rather than correctness. Declared anyway rather
 * than inherited, because "long is fine here" is the decision - and it is the
 * opposite of the canary's, which is the point of every program stating its own.
 */
/**
 * ⭐ ***60s, MOVED HERE FROM THE PARK (2026-09-07) - THE PACE IS STATED ONCE.***
 *
 * This declared 120s while every park in the program ALSO disjoined
 * `deadline(Date.now() + RECHECK_MS)` at 60s. The host takes the MINIMUM of the
 * declared bound and its flag (`internal/perseidrun/assemble.go`, `backstopFor`),
 * so the operand was the real pace and this number was decorative - two places
 * saying how long the program may sleep, and the quieter one winning.
 *
 * The operand is gone and the effective bound is UNCHANGED at 60s. What changed
 * is that it is now readable off the artifact, refusable at admission, and
 * adjustable without touching the step.
 */
export const backstop = declareBackstop.seconds(60)
