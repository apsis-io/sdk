// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1
//
// Ergonomic wrappers over the wit-bindgen-generated `trail-host` bindings. See
// periapsis.h for the public contract and memory rules. The pattern throughout:
//   - INPUT strings/lists are borrowed via trail_host_string_set (no copy) and
//     any temporary attribute array is freed after the sync host call returns;
//   - OUTPUT host data is copied into plain malloc'd C memory, then the raw
//     component-model value is released with its generated `_free`, so callers
//     only ever see (and free) ordinary heap pointers.

#include "periapsis.h"

#include <stdlib.h>
#include <string.h>

#include "generated/trail_host.h"

// --- small copy helpers ----------------------------------------------------

// Copy a (non-nul-terminated) component-model string into a fresh nul-terminated
// heap string. Returns NULL only on allocation failure.
static char *str_copy(const trail_host_string_t *s) {
  char *out = (char *)malloc(s->len + 1);
  if (!out) {
    return NULL;
  }
  if (s->len) {
    memcpy(out, s->ptr, s->len);
  }
  out[s->len] = '\0';
  return out;
}

static char *opt_str_copy(const trail_host_option_string_t *o) {
  return o->is_some ? str_copy(&o->val) : NULL;
}

// Build a borrowed component-model attribute array from the caller's plain
// key/value pairs. Returns NULL for an empty list or on allocation failure
// (callers treat NULL as "no attributes"). Free the result with free().
static periapsis_component_types_attribute_t *build_attrs(const periapsis_attr_t *attrs,
                                                          size_t n) {
  if (n == 0) {
    return NULL;
  }
  periapsis_component_types_attribute_t *arr =
      (periapsis_component_types_attribute_t *)malloc(n * sizeof *arr);
  if (!arr) {
    return NULL;
  }
  for (size_t i = 0; i < n; i++) {
    trail_host_string_set(&arr[i].key, attrs[i].key ? attrs[i].key : "");
    trail_host_string_set(&arr[i].value, attrs[i].value ? attrs[i].value : "");
  }
  return arr;
}

void periapsis_free(void *p) { free(p); }

// --- identity --------------------------------------------------------------

bool periapsis_identity_get(periapsis_identity_t *out) {
  if (!out) {
    return false;
  }
  memset(out, 0, sizeof *out);

  periapsis_component_identity_identity_info_t info;
  periapsis_component_identity_get(&info);

  out->component = str_copy(&info.component);
  out->instance = str_copy(&info.instance);
  out->sdk_version = str_copy(&info.sdk_version);
  out->workload = opt_str_copy(&info.workload);
  out->namespace_ = opt_str_copy(&info.namespace_);
  out->pod_name = opt_str_copy(&info.pod_name);
  out->pod_uid = opt_str_copy(&info.pod_uid);
  out->pawn_name = opt_str_copy(&info.pawn_name);
  out->node_name = opt_str_copy(&info.node_name);

  size_t n = info.attributes.len;
  if (n) {
    out->attributes = (periapsis_attr_t *)malloc(n * sizeof *out->attributes);
    if (out->attributes) {
      for (size_t i = 0; i < n; i++) {
        out->attributes[i].key = str_copy(&info.attributes.ptr[i].key);
        out->attributes[i].value = str_copy(&info.attributes.ptr[i].value);
      }
      out->attribute_count = n;
    }
  }

  periapsis_component_identity_identity_info_free(&info);
  return true;
}

void periapsis_identity_free(periapsis_identity_t *id) {
  if (!id) {
    return;
  }
  free(id->component);
  free(id->instance);
  free(id->sdk_version);
  free(id->workload);
  free(id->namespace_);
  free(id->pod_name);
  free(id->pod_uid);
  free(id->pawn_name);
  free(id->node_name);
  for (size_t i = 0; i < id->attribute_count; i++) {
    free((void *)id->attributes[i].key);
    free((void *)id->attributes[i].value);
  }
  free(id->attributes);
  memset(id, 0, sizeof *id);
}

// --- config ----------------------------------------------------------------

static periapsis_config_status_t map_config_err(periapsis_component_config_config_error_t e) {
  switch (e) {
    case PERIAPSIS_COMPONENT_CONFIG_CONFIG_ERROR_INVALID_KEY:
      return PERIAPSIS_CONFIG_INVALID_KEY;
    case PERIAPSIS_COMPONENT_CONFIG_CONFIG_ERROR_TOO_LARGE:
      return PERIAPSIS_CONFIG_TOO_LARGE;
    default:
      return PERIAPSIS_CONFIG_UNAVAILABLE;
  }
}

static void copy_config_value(const periapsis_component_config_config_value_t *src,
                              periapsis_config_value_t *dst) {
  memset(dst, 0, sizeof *dst);
  switch (src->tag) {
    case PERIAPSIS_COMPONENT_CONFIG_CONFIG_VALUE_TEXT:
      dst->kind = PERIAPSIS_CONFIG_TEXT;
      dst->as.text = str_copy(&src->val.text);
      break;
    case PERIAPSIS_COMPONENT_CONFIG_CONFIG_VALUE_BOOLEAN:
      dst->kind = PERIAPSIS_CONFIG_BOOL;
      dst->as.boolean = src->val.boolean;
      break;
    case PERIAPSIS_COMPONENT_CONFIG_CONFIG_VALUE_SIGNED:
      dst->kind = PERIAPSIS_CONFIG_SIGNED;
      dst->as.signed_ = src->val.signed_;
      break;
    case PERIAPSIS_COMPONENT_CONFIG_CONFIG_VALUE_UNSIGNED:
      dst->kind = PERIAPSIS_CONFIG_UNSIGNED;
      dst->as.unsigned_ = src->val.unsigned_;
      break;
    case PERIAPSIS_COMPONENT_CONFIG_CONFIG_VALUE_FLOAT:
      dst->kind = PERIAPSIS_CONFIG_FLOAT;
      dst->as.float_ = src->val.float_;
      break;
    case PERIAPSIS_COMPONENT_CONFIG_CONFIG_VALUE_BYTES: {
      dst->kind = PERIAPSIS_CONFIG_BYTES;
      size_t len = src->val.bytes.len;
      dst->as.bytes.len = len;
      if (len) {
        dst->as.bytes.ptr = (uint8_t *)malloc(len);
        if (dst->as.bytes.ptr) {
          memcpy(dst->as.bytes.ptr, src->val.bytes.ptr, len);
        } else {
          dst->as.bytes.len = 0;
        }
      }
      break;
    }
    case PERIAPSIS_COMPONENT_CONFIG_CONFIG_VALUE_TEXT_LIST: {
      dst->kind = PERIAPSIS_CONFIG_TEXT_LIST;
      size_t n = src->val.text_list.len;
      if (n) {
        dst->as.text_list.ptr = (char **)malloc(n * sizeof(char *));
        if (dst->as.text_list.ptr) {
          for (size_t i = 0; i < n; i++) {
            dst->as.text_list.ptr[i] = str_copy(&src->val.text_list.ptr[i]);
          }
          dst->as.text_list.len = n;
        }
      }
      break;
    }
    default:
      // Unknown tag: leave dst zeroed (kind TEXT, text NULL). Should not happen.
      break;
  }
}

periapsis_config_status_t periapsis_config_get(const char *key, bool *found,
                                               periapsis_config_value_t *value) {
  if (found) {
    *found = false;
  }
  trail_host_string_t k;
  trail_host_string_set(&k, key ? key : "");

  periapsis_component_config_option_config_value_t ret;
  periapsis_component_config_config_error_t err;
  bool ok = periapsis_component_config_get(&k, &ret, &err);
  if (!ok) {
    return map_config_err(err);
  }
  if (ret.is_some) {
    if (found) {
      *found = true;
    }
    if (value) {
      copy_config_value(&ret.val, value);
    }
  }
  periapsis_component_config_option_config_value_free(&ret);
  return PERIAPSIS_CONFIG_OK;
}

void periapsis_config_value_free(periapsis_config_value_t *value) {
  if (!value) {
    return;
  }
  switch (value->kind) {
    case PERIAPSIS_CONFIG_TEXT:
      free(value->as.text);
      break;
    case PERIAPSIS_CONFIG_BYTES:
      free(value->as.bytes.ptr);
      break;
    case PERIAPSIS_CONFIG_TEXT_LIST:
      for (size_t i = 0; i < value->as.text_list.len; i++) {
        free(value->as.text_list.ptr[i]);
      }
      free(value->as.text_list.ptr);
      break;
    default:
      break;
  }
  memset(value, 0, sizeof *value);
}

char *periapsis_config_get_text(const char *key) {
  bool found = false;
  periapsis_config_value_t v;
  if (periapsis_config_get(key, &found, &v) != PERIAPSIS_CONFIG_OK || !found) {
    return NULL;
  }
  char *out = NULL;
  if (v.kind == PERIAPSIS_CONFIG_TEXT) {
    out = v.as.text;   // steal the heap string; skip it in the free below
    v.as.text = NULL;
  }
  periapsis_config_value_free(&v);
  return out;
}

// --- log -------------------------------------------------------------------

periapsis_log_status_t periapsis_log_emit(periapsis_log_level_t level, const char *target,
                                          const char *message, const periapsis_attr_t *attrs,
                                          size_t attr_count) {
  periapsis_component_log_entry_t entry;
  entry.level = (periapsis_component_log_level_t)level;
  if (target) {
    entry.target.is_some = true;
    trail_host_string_set(&entry.target.val, target);
  } else {
    entry.target.is_some = false;
    entry.target.val.ptr = NULL;
    entry.target.val.len = 0;
  }
  trail_host_string_set(&entry.message, message ? message : "");

  periapsis_component_types_attribute_t *arr = build_attrs(attrs, attr_count);
  entry.attributes.ptr = arr;
  entry.attributes.len = arr ? attr_count : 0;

  periapsis_component_log_log_error_t err;
  bool ok = periapsis_component_log_emit(&entry, &err);
  free(arr);
  if (ok) {
    return PERIAPSIS_LOG_OK;
  }
  switch (err) {
    case PERIAPSIS_COMPONENT_LOG_LOG_ERROR_TOO_LARGE:
      return PERIAPSIS_LOG_TOO_LARGE;
    case PERIAPSIS_COMPONENT_LOG_LOG_ERROR_RATE_LIMITED:
      return PERIAPSIS_LOG_RATE_LIMITED;
    default:
      return PERIAPSIS_LOG_UNAVAILABLE;
  }
}

periapsis_log_status_t periapsis_log(periapsis_log_level_t level, const char *message) {
  return periapsis_log_emit(level, NULL, message, NULL, 0);
}

// --- metrics ---------------------------------------------------------------

static periapsis_metric_status_t map_metric_err(periapsis_component_metrics_metric_error_t e) {
  switch (e) {
    case PERIAPSIS_COMPONENT_METRICS_METRIC_ERROR_INVALID_NAME:
      return PERIAPSIS_METRIC_INVALID_NAME;
    case PERIAPSIS_COMPONENT_METRICS_METRIC_ERROR_INVALID_VALUE:
      return PERIAPSIS_METRIC_INVALID_VALUE;
    case PERIAPSIS_COMPONENT_METRICS_METRIC_ERROR_TOO_MANY_LABELS:
      return PERIAPSIS_METRIC_TOO_MANY_LABELS;
    case PERIAPSIS_COMPONENT_METRICS_METRIC_ERROR_RATE_LIMITED:
      return PERIAPSIS_METRIC_RATE_LIMITED;
    default:
      return PERIAPSIS_METRIC_UNAVAILABLE;
  }
}

periapsis_metric_status_t periapsis_metric_increment_counter(const char *name, uint64_t by,
                                                             const periapsis_attr_t *labels,
                                                             size_t label_count) {
  trail_host_string_t nm;
  trail_host_string_set(&nm, name ? name : "");
  periapsis_component_types_attribute_t *arr = build_attrs(labels, label_count);
  periapsis_component_metrics_labels_t lb;
  lb.values.ptr = arr;
  lb.values.len = arr ? label_count : 0;

  periapsis_component_metrics_metric_error_t err;
  bool ok = periapsis_component_metrics_increment_counter(&nm, by, &lb, &err);
  free(arr);
  return ok ? PERIAPSIS_METRIC_OK : map_metric_err(err);
}

periapsis_metric_status_t periapsis_metric_record_gauge(const char *name, double value,
                                                        const periapsis_attr_t *labels,
                                                        size_t label_count) {
  trail_host_string_t nm;
  trail_host_string_set(&nm, name ? name : "");
  periapsis_component_types_attribute_t *arr = build_attrs(labels, label_count);
  periapsis_component_metrics_labels_t lb;
  lb.values.ptr = arr;
  lb.values.len = arr ? label_count : 0;

  periapsis_component_metrics_metric_error_t err;
  bool ok = periapsis_component_metrics_record_gauge(&nm, value, &lb, &err);
  free(arr);
  return ok ? PERIAPSIS_METRIC_OK : map_metric_err(err);
}

periapsis_metric_status_t periapsis_metric_record_histogram(const char *name, double value,
                                                            const periapsis_attr_t *labels,
                                                            size_t label_count) {
  trail_host_string_t nm;
  trail_host_string_set(&nm, name ? name : "");
  periapsis_component_types_attribute_t *arr = build_attrs(labels, label_count);
  periapsis_component_metrics_labels_t lb;
  lb.values.ptr = arr;
  lb.values.len = arr ? label_count : 0;

  periapsis_component_metrics_metric_error_t err;
  bool ok = periapsis_component_metrics_record_histogram(&nm, value, &lb, &err);
  free(arr);
  return ok ? PERIAPSIS_METRIC_OK : map_metric_err(err);
}

// --- status ----------------------------------------------------------------

static periapsis_status_status_t map_status_err(periapsis_component_status_status_error_t e) {
  switch (e) {
    case PERIAPSIS_COMPONENT_STATUS_STATUS_ERROR_INVALID:
      return PERIAPSIS_STATUS_INVALID;
    case PERIAPSIS_COMPONENT_STATUS_STATUS_ERROR_TOO_LARGE:
      return PERIAPSIS_STATUS_TOO_LARGE;
    case PERIAPSIS_COMPONENT_STATUS_STATUS_ERROR_RATE_LIMITED:
      return PERIAPSIS_STATUS_RATE_LIMITED;
    default:
      return PERIAPSIS_STATUS_UNAVAILABLE;
  }
}

static void set_opt_str(trail_host_option_string_t *dst, const char *s) {
  if (s) {
    dst->is_some = true;
    trail_host_string_set(&dst->val, s);
  } else {
    dst->is_some = false;
    dst->val.ptr = NULL;
    dst->val.len = 0;
  }
}

periapsis_status_status_t periapsis_status_notify(const periapsis_status_report_t *report) {
  if (!report) {
    return PERIAPSIS_STATUS_INVALID;
  }
  periapsis_component_status_report_t rep;
  trail_host_string_set(&rep.component, report->component ? report->component : "");
  trail_host_string_set(&rep.instance, report->instance ? report->instance : "");
  rep.state = (periapsis_component_status_state_t)report->state;
  set_opt_str(&rep.reason, report->reason);
  set_opt_str(&rep.message, report->message);

  periapsis_component_types_attribute_t *arr =
      build_attrs(report->attributes, report->attribute_count);
  rep.attributes.ptr = arr;
  rep.attributes.len = arr ? report->attribute_count : 0;

  rep.sequence.is_some = report->has_sequence;
  rep.sequence.val = report->has_sequence ? report->sequence : 0;

  periapsis_component_status_status_error_t err;
  bool ok = periapsis_component_status_notify(&rep, &err);
  free(arr);
  return ok ? PERIAPSIS_STATUS_OK : map_status_err(err);
}

// --- checkpoint ------------------------------------------------------------

bool periapsis_checkpoint_requested(void) {
  return periapsis_component_checkpoint_requested();
}

void periapsis_checkpoint_save(const uint8_t *state, size_t len) {
  trail_host_list_u8_t s;
  s.ptr = (uint8_t *)state; // borrowed; the host copies during the call
  s.len = len;
  periapsis_component_checkpoint_save(&s);
}

bool periapsis_checkpoint_load(uint8_t **state, size_t *len) {
  if (state) {
    *state = NULL;
  }
  if (len) {
    *len = 0;
  }
  trail_host_list_u8_t ret;
  bool some = periapsis_component_checkpoint_load(&ret);
  if (!some) {
    return false;
  }
  uint8_t *buf = NULL;
  if (ret.len) {
    buf = (uint8_t *)malloc(ret.len);
    if (buf) {
      memcpy(buf, ret.ptr, ret.len);
    }
  }
  if (state) {
    *state = buf;
  }
  if (len) {
    *len = buf ? ret.len : 0;
  }
  trail_host_list_u8_free(&ret);
  return true;
}
