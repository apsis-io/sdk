# Copyright (C) 2025-2026 Malformed C. All rights reserved.
# SPDX-License-Identifier: BUSL-1.1
#
# Plain cc+pkg-config build - NOT cmd/meteor/Makefile's static-musl `zig cc`
# pattern (meteor has zero library deps; this SDK needs system ngtcp2/OpenSSL,
# so it's a normal dynamically-linked build). `make analyze` mirrors meteor's
# gcc -fanalyzer lint precedent.

CC ?= cc
PKG_CONFIG ?= pkg-config
PKGS := libngtcp2 libngtcp2_crypto_ossl openssl

CFLAGS ?= -std=c11 -Wall -Wextra -O2 -g
CFLAGS += -D_POSIX_C_SOURCE=200809L
CFLAGS += $(shell $(PKG_CONFIG) --cflags $(PKGS))
LDLIBS := $(shell $(PKG_CONFIG) --libs $(PKGS)) -lpthread

SRCS := frame.c tls.c io.c client.c server.c
OBJS := $(SRCS:.c=.o)
HDRS := magicseam_quic.h frame.h tls_internal.h io_internal.h

.PHONY: all test analyze clean

all: libmagicseam_quic.a

libmagicseam_quic.a: $(OBJS)
	ar rcs $@ $(OBJS)

%.o: %.c $(HDRS)
	$(CC) $(CFLAGS) -c $< -o $@

magicseam_quic_test: magicseam_quic_test.c libmagicseam_quic.a $(HDRS)
	$(CC) $(CFLAGS) $< libmagicseam_quic.a -o $@ $(LDLIBS)

test: magicseam_quic_test
	./magicseam_quic_test

analyze:
	$(CC) $(CFLAGS) -fanalyzer -fsyntax-only $(SRCS) magicseam_quic_test.c

clean:
	rm -f $(OBJS) libmagicseam_quic.a magicseam_quic_test
