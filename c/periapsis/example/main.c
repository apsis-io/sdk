// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1
//
// Minimal example guest exercising every capability of sdk/c/periapsis. Built
// as a wasm32-wasip3 component that imports the periapsis:component host caps
// and exports wasi:cli/run - see build.sh. Not a benchmark or a real workload;
// it just shows the SDK surface end to end.

#include <stdio.h>
#include <string.h>

#include "../periapsis.h"

int main(void) {
  // identity: who am I, per the host.
  periapsis_identity_t id;
  if (periapsis_identity_get(&id)) {
    printf("component=%s instance=%s sdk=%s node=%s\n", id.component, id.instance,
           id.sdk_version, id.node_name ? id.node_name : "(none)");
    periapsis_identity_free(&id);
  }

  // config: read an optional text key.
  char *greeting = periapsis_config_get_text("greeting");
  periapsis_log(PERIAPSIS_LOG_INFO, greeting ? greeting : "hello from the C guest SDK");
  periapsis_free(greeting);

  // log with structured attributes.
  periapsis_attr_t attrs[] = {{"phase", "startup"}, {"lang", "c"}};
  periapsis_log_emit(PERIAPSIS_LOG_DEBUG, "example", "structured log line", attrs, 2);

  // metrics: a counter, a gauge, a histogram.
  periapsis_attr_t labels[] = {{"kind", "demo"}};
  periapsis_metric_increment_counter("periapsis_c_sdk_calls_total", 1, labels, 1);
  periapsis_metric_record_gauge("periapsis_c_sdk_ready", 1.0, NULL, 0);
  periapsis_metric_record_histogram("periapsis_c_sdk_latency_seconds", 0.001, NULL, 0);

  // status: report ready.
  periapsis_status_report_t report;
  memset(&report, 0, sizeof report);
  report.component = "c-sdk-example";
  report.instance = "0";
  report.state = PERIAPSIS_STATE_READY;
  report.message = "example guest up";
  periapsis_status_notify(&report);

  // checkpoint/restore: restore prior state, or cold-start; then, if a
  // checkpoint is requested, persist and return.
  uint8_t *state = NULL;
  size_t state_len = 0;
  if (periapsis_checkpoint_load(&state, &state_len)) {
    printf("restored %zu bytes of state\n", state_len);
    periapsis_free(state);
  } else {
    printf("cold start\n");
  }
  if (periapsis_checkpoint_requested()) {
    const char *snapshot = "example-state-v1";
    periapsis_checkpoint_save((const uint8_t *)snapshot, strlen(snapshot));
    return 0; // saving must be the guest's last act
  }

  return 0;
}
