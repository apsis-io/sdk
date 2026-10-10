// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { declareBackstop } from '@apsis-io/perseid/backstop.js'

/**
 * The measuring program's park bound.
 *
 * ***LOOSER THAN THE CANARY'S 30s ON PURPOSE, AND THE ASYMMETRY IS THE
 * OPPOSITE ONE.*** A canary that sleeps past a readiness flip holds a good
 * version back or leaves a bad one live, so its cost is per-second. A probe that
 * sleeps past its sampling interval loses ONE SAMPLE from a twelve-sample
 * window - the measurement degrades slightly and self-repairs on the next pass.
 *
 * 90s is three missed samples' worth of slack over the 15s interval, which is
 * enough that the backstop never becomes the thing that paces the probe: the
 * deadline park is the sampling clock, and a backstop that fired first would
 * silently take that role and make the window's spacing a function of host
 * configuration instead of the program's own decision.
 */
export const backstop = declareBackstop.seconds(90)
