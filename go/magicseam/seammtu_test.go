// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

package magicseam

import "testing"

// ⛔ THE GUARD FOR A HANDSHAKE THAT COULD NOT LEAVE THE HOST.
//
// quic-go defaults InitialPacketSize to 1280 and sets DF. On the aphelion0
// tailnet (mtu 1280) that is 1308 bytes on the wire, so the kernel refused every
// Initial with EMSGSIZE and the dial failed as "timeout: no recent network
// activity" - an error that names the PEER for a packet that never reached the
// network. trail's Rust side uses quinn, which defaults to 1200, so the same
// seam worked from Rust and not from Go against the identical address.
//
// These assert the ARITHMETIC rather than the constant. A future change that
// raises seamInitialPacketSize to something a 1280-MTU path cannot carry goes red
// here with the numbers, instead of somewhere across a tunnel as a timeout.

const (
	// ipv4UDPHeaderBytes is what the kernel adds to a QUIC datagram before it is
	// measured against the path MTU: 20 bytes of IPv4 plus 8 of UDP.
	ipv4UDPHeaderBytes = 28

	// narrowestSeamPathMTU is the tightest link the seam is required to cross -
	// the aphelion0 tailnet, where the off-cluster consumer lives. Measured on
	// engix99: /sys/class/net/aphelion0/mtu reads 1280.
	narrowestSeamPathMTU = 1280

	// quicMinInitialPacketSize is quic-go's documented lower limit ("values below
	// 1200 are invalid") and the RFC 9000 §14.1 floor every conformant path must
	// carry. Going under it does not buy compatibility, it is simply rejected.
	quicMinInitialPacketSize = 1200
)

// The Initial packet plus headers must FIT the narrowest path, on both the client
// and the server config - seamQUICConfig feeds quic.ListenEarly as well as the
// two dial paths, so a provider's handshake response is governed by the same
// number as a consumer's Initial.
func TestSeamQUICConfig_InitialPacketFitsTheNarrowestSeamPath(t *testing.T) {
	for _, allow0RTT := range []bool{false, true} {
		cfg := seamQUICConfig(allow0RTT)

		if cfg.InitialPacketSize == 0 {
			t.Fatalf("allow0RTT=%v: InitialPacketSize is unset, so quic-go uses its 1280 default. "+
				"With %d bytes of IP+UDP header that is %d on the wire against a %d-byte path: the "+
				"kernel refuses the Initial locally (EMSGSIZE) and the dial reports a peer timeout",
				allow0RTT, ipv4UDPHeaderBytes, 1280+ipv4UDPHeaderBytes, narrowestSeamPathMTU)
		}

		onWire := int(cfg.InitialPacketSize) + ipv4UDPHeaderBytes
		if onWire > narrowestSeamPathMTU {
			t.Errorf("allow0RTT=%v: InitialPacketSize=%d + %d header = %d on the wire, which does "+
				"not fit the %d-byte aphelion0 path. Every Initial is refused with EMSGSIZE before "+
				"it is sent, and the failure surfaces as a peer timeout",
				allow0RTT, cfg.InitialPacketSize, ipv4UDPHeaderBytes, onWire, narrowestSeamPathMTU)
		}
		if cfg.InitialPacketSize < quicMinInitialPacketSize {
			t.Errorf("allow0RTT=%v: InitialPacketSize=%d is below the QUIC floor of %d; quic-go "+
				"rejects it outright, so this trades a tunnel failure for a total one",
				allow0RTT, cfg.InitialPacketSize, quicMinInitialPacketSize)
		}
	}
}

// The two arms must agree. allow0RTT is a SERVER-side early-data switch and has
// nothing to do with path size - if it ever starts changing the packet size, one
// direction of the seam is being sized differently from the other and only the
// unlucky path shows it.
func TestSeamQUICConfig_PacketSizeDoesNotDependOnEarlyData(t *testing.T) {
	client := seamQUICConfig(false).InitialPacketSize
	server := seamQUICConfig(true).InitialPacketSize

	if client != server {
		t.Errorf("client InitialPacketSize=%d but server=%d: allow0RTT is an early-data switch and "+
			"must not size packets, or a provider answers with an Initial its consumer's path "+
			"cannot carry", client, server)
	}
}
