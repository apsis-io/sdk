// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { declareBackstop } from '@apsis-io/perseid/backstop.js'

/**
 * The governance step's park bound.
 *
 * ⚠ ***THIS PROGRAM IS THE ONE THAT IS ACTUALLY RUNNING ON THE FLEET*** -
 * `gazer-governance`, Running rather than Parked, and the only live Perseid that
 * reads CLUSTER-SCOPED (`observe-cluster.get`). That makes it the one whose
 * bound matters most and the one this repo had never declared: it was not built
 * by `build.sh` at all, so it inherited the host default and nobody chose it.
 *
 * ***AND IT IS WHY THE BOUND EXISTS AT ALL HERE.*** A declared backstop is what
 * lets the host signal a wedged pass (ADR-0106); without one, `signal` is
 * exported and never called, and a governance step blocked on a cluster read
 * stays blocked. Its reads are cluster-wide and therefore the slowest and most
 * likely to be answered late, so a bound that is too tight would signal a pass
 * that was merely working.
 *
 * 120s: the same order as the janitor's, which is the other program whose reads
 * are broad. Chosen rather than inherited, which is the whole point of declaring
 * it - `DEFAULT_BACKSTOP_MS` says "a program nobody has thought about".
 */
export const backstop = declareBackstop.seconds(120)
