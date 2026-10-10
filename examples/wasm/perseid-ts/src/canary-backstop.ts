// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { declareBackstop } from '@apsis-io/perseid/backstop.js'

/**
 * The readiness-gated canary's park bound.
 *
 * 30s, the tightest of the three, and for a reason specific to what this program
 * does: a canary gates PROMOTION on another workload's observed readiness. Every
 * second it sleeps past the moment that readiness flips is a second a bad
 * version stays live or a good one stays held - so the cost of a missed wake
 * here is asymmetric with the other two, where it only means a slow reconcile.
 */
export const backstop = declareBackstop.seconds(30)
