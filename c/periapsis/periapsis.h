// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1
//
// periapsis.h - the C (WASM guest) SDK for the Periapsis host capabilities
// (ADR-0026 `periapsis:host/*` / ADR-0028 checkpoint), the C counterpart to
// `sdk/ts/periapsis`. It is an ERGONOMIC wrapper over the raw, verbose bindings
// wit-bindgen generates from `wit/` (`generated/trail_host.h`) - it hides the
// component-model string/option/result/list machinery behind plain C types
// (`const char*`, small enums, out-params) so a guest reads and writes host
// caps without touching `trail_host_string_t` or the `_free` helpers.
//
// Scope: the SYNC host capabilities of the `trail-host` world -
// identity/config/log/metrics/status/checkpoint. The magic SEAM
// (`periapsis:magic/handler`) is deliberately OUT: its `handle()` is
// `async func` and no non-Rust toolchain (TinyGo, C/wit-bindgen, jco) can bind
// an async component-model export/import today - see
// `done/2026-07-16_tinygo-sdk-blocked.md`. Every interface here is sync, so
// unlike the seam it binds cleanly and this SDK is complete, not a scaffold.
//
// Build: a guest links this SDK + `generated/trail_host.c` +
// `generated/trail_host_component_type.o` and is compiled for wasm32-wasip3
// (see the Makefile / README). Regenerate the bindings with `./bindgen.sh`
// after any change to `wit/`.
//
// Memory: functions that RETURN host data (`periapsis_identity_get`,
// `periapsis_config_get`, `periapsis_config_get_text`, `periapsis_checkpoint_load`)
// hand back heap-owned copies the caller frees with the matching `_free` /
// `periapsis_free`. Functions that TAKE data (log/metrics/status/checkpoint-save)
// borrow the caller's strings/buffers for the duration of the call only - the
// caller retains ownership and nothing is freed on its behalf.

#ifndef PERIAPSIS_SDK_H
#define PERIAPSIS_SDK_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// A string key/value attribute, shared by log / metrics / status / identity.
// As an INPUT (log/metrics/status) the pointers are borrowed for the call. As
// an OUTPUT (identity) they are heap-owned and freed by periapsis_identity_free.
typedef struct {
  const char *key;
  const char *value;
} periapsis_attr_t;

// Free any single heap buffer/string this SDK returned by-pointer
// (periapsis_config_get_text, periapsis_checkpoint_load). Just wraps free();
// safe on NULL.
void periapsis_free(void *p);

// ---------------------------------------------------------------------------
// identity - host-provided component/workload identity (informational).
// ---------------------------------------------------------------------------

// Optional fields are NULL when the host omits them. All strings + attributes
// are heap-owned; free the whole struct with periapsis_identity_free.
typedef struct {
  char *component;
  char *instance;
  char *sdk_version;
  char *workload;   // optional
  char *namespace_; // optional
  char *pod_name;   // optional
  char *pod_uid;    // optional
  char *pawn_name;  // optional
  char *node_name;  // optional
  periapsis_attr_t *attributes; // owned; keys/values heap-owned
  size_t attribute_count;
} periapsis_identity_t;

// Fill *out with host identity (heap-owned copies). Returns true; free with
// periapsis_identity_free.
bool periapsis_identity_get(periapsis_identity_t *out);
void periapsis_identity_free(periapsis_identity_t *id);

// ---------------------------------------------------------------------------
// config - read-only host-scoped configuration.
// ---------------------------------------------------------------------------

typedef enum {
  PERIAPSIS_CONFIG_OK = 0,
  PERIAPSIS_CONFIG_INVALID_KEY,
  PERIAPSIS_CONFIG_TOO_LARGE,
  PERIAPSIS_CONFIG_UNAVAILABLE,
} periapsis_config_status_t;

// Which arm of periapsis_config_value_t's `as` union is live.
typedef enum {
  PERIAPSIS_CONFIG_TEXT = 0,
  PERIAPSIS_CONFIG_BOOL,
  PERIAPSIS_CONFIG_SIGNED,
  PERIAPSIS_CONFIG_UNSIGNED,
  PERIAPSIS_CONFIG_FLOAT,
  PERIAPSIS_CONFIG_BYTES,
  PERIAPSIS_CONFIG_TEXT_LIST,
} periapsis_config_kind_t;

// A retrieved config value; heap-owned, free with periapsis_config_value_free.
typedef struct {
  periapsis_config_kind_t kind;
  union {
    char *text;                            // PERIAPSIS_CONFIG_TEXT (nul-terminated)
    bool boolean;                          // PERIAPSIS_CONFIG_BOOL
    int64_t signed_;                       // PERIAPSIS_CONFIG_SIGNED
    uint64_t unsigned_;                    // PERIAPSIS_CONFIG_UNSIGNED
    double float_;                         // PERIAPSIS_CONFIG_FLOAT
    struct { uint8_t *ptr; size_t len; } bytes;      // PERIAPSIS_CONFIG_BYTES
    struct { char **ptr; size_t len; } text_list;    // PERIAPSIS_CONFIG_TEXT_LIST
  } as;
} periapsis_config_value_t;

// Look up `key`. On PERIAPSIS_CONFIG_OK, *found says whether the key exists; if
// found, *value is populated (free with periapsis_config_value_free). `found`
// and `value` may be NULL if not needed.
periapsis_config_status_t periapsis_config_get(const char *key, bool *found,
                                               periapsis_config_value_t *value);
void periapsis_config_value_free(periapsis_config_value_t *value);

// Convenience: return a text config value as a fresh heap string, or NULL if
// the key is absent, not text, or the lookup failed. Free with periapsis_free.
char *periapsis_config_get_text(const char *key);

// ---------------------------------------------------------------------------
// log - bounded structured logging through the host.
// ---------------------------------------------------------------------------

typedef enum {
  PERIAPSIS_LOG_TRACE = 0,
  PERIAPSIS_LOG_DEBUG,
  PERIAPSIS_LOG_INFO,
  PERIAPSIS_LOG_WARN,
  PERIAPSIS_LOG_ERROR,
} periapsis_log_level_t;

typedef enum {
  PERIAPSIS_LOG_OK = 0,
  PERIAPSIS_LOG_TOO_LARGE,
  PERIAPSIS_LOG_RATE_LIMITED,
  PERIAPSIS_LOG_UNAVAILABLE,
} periapsis_log_status_t;

// Emit one log entry. `target` may be NULL; `attrs` may be NULL with count 0.
periapsis_log_status_t periapsis_log_emit(periapsis_log_level_t level,
                                          const char *target, const char *message,
                                          const periapsis_attr_t *attrs,
                                          size_t attr_count);
// Convenience: level + message, no target or attributes.
periapsis_log_status_t periapsis_log(periapsis_log_level_t level, const char *message);

// ---------------------------------------------------------------------------
// metrics - low-cardinality metric reporting through the host.
// ---------------------------------------------------------------------------

typedef enum {
  PERIAPSIS_METRIC_OK = 0,
  PERIAPSIS_METRIC_INVALID_NAME,
  PERIAPSIS_METRIC_INVALID_VALUE,
  PERIAPSIS_METRIC_TOO_MANY_LABELS,
  PERIAPSIS_METRIC_RATE_LIMITED,
  PERIAPSIS_METRIC_UNAVAILABLE,
} periapsis_metric_status_t;

// `labels` may be NULL with count 0 for all three.
periapsis_metric_status_t periapsis_metric_increment_counter(const char *name, uint64_t by,
                                                             const periapsis_attr_t *labels,
                                                             size_t label_count);
periapsis_metric_status_t periapsis_metric_record_gauge(const char *name, double value,
                                                        const periapsis_attr_t *labels,
                                                        size_t label_count);
periapsis_metric_status_t periapsis_metric_record_histogram(const char *name, double value,
                                                            const periapsis_attr_t *labels,
                                                            size_t label_count);

// ---------------------------------------------------------------------------
// status - best-effort component-local status (NOT Kubernetes PodStatus).
// ---------------------------------------------------------------------------

typedef enum {
  PERIAPSIS_STATE_STARTING = 0,
  PERIAPSIS_STATE_READY,
  PERIAPSIS_STATE_DEGRADED,
  PERIAPSIS_STATE_FAILED,
  PERIAPSIS_STATE_STOPPING,
} periapsis_state_t;

typedef enum {
  PERIAPSIS_STATUS_OK = 0,
  PERIAPSIS_STATUS_INVALID,
  PERIAPSIS_STATUS_TOO_LARGE,
  PERIAPSIS_STATUS_RATE_LIMITED,
  PERIAPSIS_STATUS_UNAVAILABLE,
} periapsis_status_status_t;

// `reason` and `message` may be NULL to omit. `attributes` may be NULL with
// count 0. Set has_sequence=false to omit the sequence number.
typedef struct {
  const char *component;
  const char *instance;
  periapsis_state_t state;
  const char *reason;  // optional
  const char *message; // optional
  const periapsis_attr_t *attributes;
  size_t attribute_count;
  bool has_sequence;
  uint64_t sequence;
} periapsis_status_report_t;

periapsis_status_status_t periapsis_status_notify(const periapsis_status_report_t *report);

// ---------------------------------------------------------------------------
// checkpoint - cooperative checkpoint/restore (ADR-0028 Phase 7).
//
// The component drives it: at startup call periapsis_checkpoint_load (a true
// return is prior state to restore, false is a cold start); in the run loop
// poll periapsis_checkpoint_requested, and when it returns true serialize your
// state, call periapsis_checkpoint_save, then RETURN from the entrypoint -
// saving must be the guest's last act so the snapshot is consistent.
// ---------------------------------------------------------------------------

// True when the host wants a checkpoint before an imminent coordinated restart.
bool periapsis_checkpoint_requested(void);

// Persist serialized state across the restart. `state` is borrowed for the call.
// Should be the guest's final act (call, then return).
void periapsis_checkpoint_save(const uint8_t *state, size_t len);

// On restore, return true and set *state (heap-owned, free with periapsis_free)
// + *len. On a cold start, return false with *state=NULL, *len=0. `state`/`len`
// may be NULL if not needed.
bool periapsis_checkpoint_load(uint8_t **state, size_t *len);

#ifdef __cplusplus
}
#endif

#endif // PERIAPSIS_SDK_H
