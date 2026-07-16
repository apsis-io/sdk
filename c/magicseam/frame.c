/* Copyright (C) 2025-2026 Malformed C. All rights reserved.
 * SPDX-License-Identifier: BUSL-1.1
 */
#include "frame.h"
#include "magicseam_quic.h"

#include <string.h>

size_t magicseam_frame_encode(uint8_t *dest, const uint8_t *body, size_t len) {
  dest[0] = (uint8_t)(len & 0xff);
  dest[1] = (uint8_t)((len >> 8) & 0xff);
  dest[2] = (uint8_t)((len >> 16) & 0xff);
  dest[3] = (uint8_t)((len >> 24) & 0xff);
  if (len > 0 && body != NULL) {
    memcpy(dest + 4, body, len);
  }
  return len + 4;
}

size_t magicseam_frame_decode_len(const uint8_t *src) {
  uint32_t n = (uint32_t)src[0] | ((uint32_t)src[1] << 8) |
               ((uint32_t)src[2] << 16) | ((uint32_t)src[3] << 24);
  if (n > MAGICSEAM_MAX_FRAME) {
    return (size_t)-1;
  }
  return (size_t)n;
}

int magicseam_status_to_tag(int status) {
  switch (status) {
    case MAGICSEAM_ERR_REJECTED:
      return MAGICSEAM_TAG_REJECTED;
    case MAGICSEAM_ERR_TOOLARGE:
      return MAGICSEAM_TAG_TOOLARGE;
    default:
      return MAGICSEAM_TAG_UNAVAILABLE;
  }
}
