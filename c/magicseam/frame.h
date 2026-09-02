/* Copyright (C) 2025-2026 Malformed C. All rights reserved.
 * SPDX-License-Identifier: BUSL-1.1
 *
 * Wire framing shared by client.c and server.c - a plain in-memory codec
 * (no I/O of its own; io.c owns the actual stream reads/writes and calls
 * into this only to encode/decode the bytes it already has). Mirrors
 * go/magicseam/magicseam.go's writeFrame/readFrame/tagFor exactly.
 */
#ifndef MAGICSEAM_FRAME_H
#define MAGICSEAM_FRAME_H

#include <stddef.h>
#include <stdint.h>

/* MAGICSEAM_MAX_FRAME bounds a single frame so a hostile/garbled peer
 * can't make this process allocate unbounded - matches
 * remote_quic.rs/magicseam.go's own MAX_FRAME (64 MiB). */
#define MAGICSEAM_MAX_FRAME (64u << 20)

/* Wire result tags - see trail's QUIC transport's module doc
 * comment for the authoritative protocol description. */
#define MAGICSEAM_TAG_OK 0
#define MAGICSEAM_TAG_UNAVAILABLE 1
#define MAGICSEAM_TAG_REJECTED 2
#define MAGICSEAM_TAG_TOOLARGE 3

/* magicseam_frame_encode writes a 4-byte little-endian length prefix
 * followed by len bytes of body into dest (which must have at least
 * len + 4 bytes of capacity). Returns the total bytes written (len + 4).
 * len must already be <= MAGICSEAM_MAX_FRAME - this function does not
 * itself re-check (the caller is always this SDK's own outbound data,
 * never attacker-controlled length). */
size_t magicseam_frame_encode(uint8_t *dest, const uint8_t *body, size_t len);

/* magicseam_frame_decode_len reads a 4-byte little-endian length prefix
 * from src (which must have at least 4 bytes available) and returns it
 * as a plain size_t. Returns (size_t)-1 if the decoded length exceeds
 * MAGICSEAM_MAX_FRAME - the caller must treat that as a protocol
 * violation (MAGICSEAM_ERR_PROTOCOL), not read that many body bytes. */
size_t magicseam_frame_decode_len(const uint8_t *src);

/* magicseam_status_to_tag maps an application handler's returned status
 * to its wire result tag: MAGICSEAM_ERR_REJECTED/_TOOLARGE map to their
 * own distinct tags; MAGICSEAM_OK is never passed here (the caller only
 * calls this on a non-OK handler return); anything else (including
 * MAGICSEAM_ERR_UNAVAIL and any other error the handler returned) maps to
 * MAGICSEAM_TAG_UNAVAILABLE, the transport-neutral fail-closed default -
 * matching magicseam.go's tagFor exactly. */
int magicseam_status_to_tag(int status);

#endif /* !defined(MAGICSEAM_FRAME_H) */
