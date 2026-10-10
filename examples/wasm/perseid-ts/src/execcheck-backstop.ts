// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { declareBackstop } from '@apsis-io/perseid/backstop.js'

/**
 * 60s.
 *
 * ***THE BACKSTOP IS THIS PROGRAM'S ONLY LIVENESS WHILE THE SEAM IS UNWIRED.***
 * Every other arm parks on the SUBJECT moving, and the subject does not move when
 * the thing that is wrong is that no checker was ever allowlisted - so on the
 * fleet as it stands, a backstop tick is the only thing that re-publishes
 * `NoChecker`. A program whose failure mode is silence needs a bound it declares
 * rather than one it inherits: `backstopFor` (internal/perseidrun/assemble.go:450)
 * takes the TIGHTER of this and the host's `-perseid-backstop`, and falls back to
 * this one when the host's is `off`.
 */
export const backstop = declareBackstop.seconds(60)
