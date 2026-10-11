// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { declareBackstop } from '@apsis-io/perseid/backstop.js'

/**
 * ***THE DAG'S OWN PARK BOUND - AND THIS PROGRAM IS THE REASON THE BOUND MOVED
 * INTO THE ARTIFACT AT ALL.***
 *
 * `dag-demo` is the in-the-wild instance of board R25: it declared
 * `spec.maxSleepMs: 300000` on the object, wrote its own deadline in the park
 * expression, and the object's bound was silently discarded - so it ran on ~60s
 * while `kubectl get perseid` displayed 300s. Nothing reconciled the two because
 * nothing read the field.
 *
 * 90s: a dependency DAG waits on stages it does not control, so it is legitimately
 * a slow program - but 300s means a stalled stage is invisible for five minutes,
 * and this component exists to be watched.
 */
/**
 * ⭐ ***60s, MOVED HERE FROM THE PARK (2026-09-07) - THE PACE IS STATED ONCE.***
 *
 * This declared 90s while every park in the program ALSO disjoined
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
