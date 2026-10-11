// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { declareBackstop } from '@apsis-io/perseid/backstop.js'

/**
 * ***THE SENTINEL'S BOUND IS ALSO ITS FALLBACK BUDGET, WHICH NO OTHER PROGRAM
 * HERE HAS.*** A backstop tick is where this program reads EVERY subject rather
 * than the one the host named - `held` is empty on a backstop, so the dispatch
 * has nothing to dispatch on and the total-function path runs.
 *
 * 75s: long enough that the cheap path is the common one, short enough that a
 * subject which changed while `woke` was unavailable is noticed within about a
 * minute. A watchdog that reports late is worth less than one that costs a
 * little more.
 */
export const backstop = declareBackstop.seconds(75)
