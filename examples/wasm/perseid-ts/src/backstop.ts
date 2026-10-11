// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { declareBackstop } from '@apsis-io/perseid/backstop.js'

/**
 * ***HOW LONG THIS PROGRAM MAY SIT AFTER A MISSED WAKE BEFORE ANYTHING RECHECKS
 * IT.***
 *
 * Declared ONCE, here, and compiled into the artifact as a `perseid:backstop`
 * custom section by `tools/attach-backstop.ts`. It is not a field on the Perseid
 * object: the bound is a property of the PROGRAM, not something an operator
 * tunes per deployment, the same standing a controller's resync interval has.
 *
 * 60s rather than the host's 300s because this program parks on a Deployment's
 * `status.readyReplicas` and a rollout that stalls should be visible within a
 * minute, not five. That is the whole reason to declare one: the default is not
 * wrong, it is just not a decision.
 */
export const backstop = declareBackstop.seconds(60)
