// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

package magicseam

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"testing"
)

// ***THE WIRE PROTOCOL IS DECLARED TWICE, IN TWO LANGUAGES, AND NOTHING CHECKED
// THEY AGREE.***
//
// Written reviewing the converse seam at trail-main's request. The constants
// happened to match; what was missing is anything that FAILS when they stop.
//
// # WHY THIS ONE IS WORTH A CROSS-LANGUAGE TEST WHEN MOST ARE NOT
//
// ***THE FAILURE MODE IS SILENCE.*** radiant-main lost an hour to exactly this
// class tonight: advertising a capability whose opcode was not written, so the
// peer read a frame's length prefix as an opcode and both ends blocked forever.
// Their own words - *"a misparse has no error path: both ends are still reading,
// nothing errors, and the loudest available protocol bug presents as silence."*
//
// A renumbered opcode is the same shape. Go writes 5, Rust reads 5 as something
// else, and the symptom is a Perseid that never completes a pass - with no error
// anywhere and a driver that looks merely slow.
//
// # WHY A SOURCE READ RATHER THAN A ROUND TRIP
//
// The honest answer is that a round trip is better and needs a trail binary,
// which this package cannot assume. A source read is the weaker instrument that
// runs everywhere, and its known weakness is that it checks a LITERAL rather
// than a BEHAVIOUR - so it catches a renumber and would not catch a Rust reader
// that ignores the byte entirely.
//
// ***IT FAILS RATHER THAN SKIPS WHEN IT CANNOT READ THE FILE.*** A skip here
// would make a moved or renamed streamwire.rs look exactly like agreement, which
// is the "instrument broken is a third outcome" rule and the whole reason this
// file is not `t.Skip`-guarded.
func TestWireConstantsAgreeWithTrail(t *testing.T) {
	src := rustStreamWire(t)

	for _, c := range []struct {
		name string
		rust string
		got  byte
	}{
		{"opcode", "OP_CONVERSE", opConverse},
		{"ask tag", "CONV_ASK", convAsk},
		{"done tag", "CONV_DONE", convDone},
	} {
		want := rustByteConst(t, src, c.rust)
		if want != c.got {
			t.Errorf("%s DIVERGED: Go has %d, cmd/trail/src/streamwire.rs %s = %d. "+
				"A renumbered opcode does not error - both ends block and a pass "+
				"never completes, which reads as a slow driver rather than a bug",
				c.name, c.got, c.rust, want)
		}
	}
}

// The capability token is a STRING and drifts differently - a typo on either
// side means the peer never advertises, Converse refuses up front, and that at
// least fails loudly. Pinned anyway because the loud failure is "this seam does
// not work at all", which is expensive to diagnose from the consumer end.
func TestWireCapabilityTokenAgreesWithTrail(t *testing.T) {
	src := rustStreamWire(t)
	re := regexp.MustCompile(`CAP_CONVERSE:\s*&str\s*=\s*"([^"]+)"`)
	m := re.FindSubmatch(src)
	if m == nil {
		t.Fatal("CAP_CONVERSE not found in streamwire.rs - the constant was renamed " +
			"or removed, and this test cannot tell that from agreement")
	}
	if string(m[1]) != CapConverse {
		t.Errorf("capability token DIVERGED: Go %q, Rust %q - the peer never "+
			"advertises and every Converse is refused before it starts",
			CapConverse, string(m[1]))
	}
}

// rustStreamWire reads trail's wire definitions. FATAL on any failure: an
// unreadable file must not read as agreement.
func rustStreamWire(t *testing.T) []byte {
	t.Helper()
	// Relative to sdk/go/magicseam. Written out rather than searched so a MOVED
	// file fails here instead of being silently not-found somewhere else.
	path := filepath.Join("..", "..", "..", "cmd", "trail", "src", "streamwire.rs")
	src, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("cannot read %s, so the two sides are UNCHECKED rather than in "+
			"agreement: %v", path, err)
	}

	return src
}

func rustByteConst(t *testing.T, src []byte, name string) byte {
	t.Helper()
	re := regexp.MustCompile(fmt.Sprintf(`%s:\s*u8\s*=\s*(\d+)`, regexp.QuoteMeta(name)))
	m := re.FindSubmatch(src)
	if m == nil {
		t.Fatalf("%s not found in streamwire.rs - renamed or removed, which this "+
			"test cannot distinguish from agreement", name)
	}
	var v int
	if _, err := fmt.Sscanf(string(m[1]), "%d", &v); err != nil || v < 0 || v > 255 {
		t.Fatalf("%s = %q, not a byte", name, m[1])
	}

	return byte(v)
}
