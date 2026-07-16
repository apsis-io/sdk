# sdk/c/periapsis - C (WASM guest) SDK for the Periapsis host capabilities.
#
# Builds a static archive (libperiapsis.a) a guest links, and an example guest
# component. Requires a wasi-sdk with wasm32-wasip3 support; point WASI_SDK at
# it if it isn't in the default location.

WASI_SDK ?= $(HOME)/.local/share/wasi-sdk-p3
CC       := $(WASI_SDK)/bin/wasm32-wasip3-clang
# System llvm-ar handles wasm objects; the wasi-sdk ships only the clang driver.
# (:= so it wins over Make's built-in AR=ar; override with `make AR=...`.)
AR       := llvm-ar
CFLAGS   := -O2 -Wall -Wextra -std=c11

OBJS     := periapsis.o generated/trail_host.o
TYPE_OBJ := generated/trail_host_component_type.o

.PHONY: all example bindgen clean
all: libperiapsis.a

# The component-type object carries the WIT type section and must ride along in
# the final component link; trail_host.o force-references it, so pulling it into
# the archive is enough.
libperiapsis.a: $(OBJS) $(TYPE_OBJ)
	$(AR) rcs $@ $(OBJS) $(TYPE_OBJ)

periapsis.o: periapsis.c periapsis.h generated/trail_host.h
	$(CC) $(CFLAGS) -c periapsis.c -o $@

generated/trail_host.o: generated/trail_host.c generated/trail_host.h
	$(CC) $(CFLAGS) -c generated/trail_host.c -o $@

example: example/c-sdk-example.wasm
example/c-sdk-example.wasm: example/main.c libperiapsis.a
	$(CC) $(CFLAGS) example/main.c libperiapsis.a -o $@

# Refresh the generated bindings from wit/ (needs wit-bindgen on PATH).
bindgen:
	./bindgen.sh

clean:
	rm -f $(OBJS) libperiapsis.a example/c-sdk-example.wasm
