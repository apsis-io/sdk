//! Zig magic-seam SDK (ADR-0028/0043): an idiomatic Zig wrapper over
//! sdk/c/magicseam's own QUIC implementation (mutual TLS against the
//! cluster's self-managed trail CA, one persistent connection, a version
//! handshake on the first bidirectional stream, then every call opens its
//! own stream). This module owns no protocol logic of its own - see
//! build.zig's own doc comment for why Zig links straight into the C
//! library instead of re-porting ngtcp2 handling a third time (Go/TS
//! re-implement the wire protocol natively; C is the one ngtcp2 binding).
const std = @import("std");

const c = @cImport({
    @cInclude("magicseam_quic.h");
});

/// The fixed CommonName/DNS-SAN every trail-CA-signed QUIC leaf carries -
/// mirrors sdk/c/magicseam/magicseam_quic.h's MAGICSEAM_QUIC_SNI exactly.
pub const sni: [:0]const u8 = c.MAGICSEAM_QUIC_SNI;

/// Mirrors magicseam_status's non-OK values (magicseam_quic.h) - the wire's
/// own error tags (Rejected/TooLarge/Unavailable) plus transport-level
/// failure classes local to this SDK.
pub const Error = error{
    Arg,
    Tls,
    Dial,
    Io,
    Protocol,
    Version,
    Rejected,
    TooLarge,
    Unavailable,
};

fn checkStatus(status: c.magicseam_status) Error!void {
    return switch (status) {
        c.MAGICSEAM_OK => {},
        c.MAGICSEAM_ERR_ARG => Error.Arg,
        c.MAGICSEAM_ERR_TLS => Error.Tls,
        c.MAGICSEAM_ERR_DIAL => Error.Dial,
        c.MAGICSEAM_ERR_IO => Error.Io,
        c.MAGICSEAM_ERR_PROTOCOL => Error.Protocol,
        c.MAGICSEAM_ERR_VERSION => Error.Version,
        c.MAGICSEAM_ERR_REJECTED => Error.Rejected,
        c.MAGICSEAM_ERR_TOOLARGE => Error.TooLarge,
        else => Error.Unavailable, // MAGICSEAM_ERR_UNAVAIL or any unknown tag
    };
}

/// -------- client --------
pub const Client = struct {
    ptr: *c.magicseam_quic_client,

    /// Connects to addr ("tcp:<host:port>") and performs the mTLS handshake
    /// plus the magic-seam version handshake. required_version is this
    /// consumer's own required version (empty = none). Blocks until the
    /// handshake completes or fails. served_buf, if non-empty, receives the
    /// provider's self-reported version (NUL-terminated, truncated if it
    /// doesn't fit) - this SDK does not itself enforce semver
    /// compatibility, matching every other magic-seam SDK's "gating is the
    /// caller's job" convention.
    pub fn dial(
        addr: [:0]const u8,
        cert_path: [:0]const u8,
        key_path: [:0]const u8,
        ca_path: [:0]const u8,
        required_version: [:0]const u8,
        served_buf: []u8,
    ) Error!Client {
        var out: ?*c.magicseam_quic_client = null;
        const status = c.magicseam_quic_dial(
            addr.ptr,
            cert_path.ptr,
            key_path.ptr,
            ca_path.ptr,
            required_version.ptr,
            &out,
            served_buf.ptr,
            served_buf.len,
        );
        try checkStatus(status);
        return .{ .ptr = out.? };
    }

    /// Opens a NEW bidirectional stream for this one request - concurrent
    /// calls on the same client never serialize behind each other. Blocks
    /// until the response arrives or the call fails. The returned slice is
    /// allocated with `allocator` (a copy of the C SDK's own malloc'd
    /// response buffer, freed internally before returning) - the caller
    /// frees it the normal Zig way, never via the C SDK's own
    /// magicseam_free. Error.Rejected/Error.TooLarge carry no payload.
    /// Thread-safe: any number of threads may call concurrently on one
    /// client.
    pub fn call(self: Client, allocator: std.mem.Allocator, req: []const u8) Error![]u8 {
        var resp: [*c]u8 = null;
        var resp_len: usize = 0;
        const status = c.magicseam_quic_call(self.ptr, req.ptr, req.len, &resp, &resp_len);
        try checkStatus(status);
        defer c.magicseam_free(resp);
        const out = allocator.alloc(u8, resp_len) catch return Error.Unavailable;
        if (resp_len > 0) @memcpy(out, resp[0..resp_len]);
        return out;
    }

    /// Ends the connection and joins its I/O thread. Any call blocked in
    /// `call` concurrently is left to fail with Error.Io - callers that
    /// need a graceful drain should stop issuing new calls first.
    pub fn close(self: Client) void {
        c.magicseam_quic_close(self.ptr);
    }
};

/// -------- server --------

/// A magic-seam request handler: request in, response out (allocated with
/// whatever allocator the handler likes - the trampoline below copies it
/// into a malloc'd buffer for the C SDK, then frees the handler's own
/// slice, so the handler's allocator lifetime never has to outlive the
/// call). Return Error.Rejected/Error.TooLarge/Error.Unavailable for the
/// wire's matching tags; any OTHER error also maps to Error.Unavailable,
/// the wire's transport-neutral fail-closed default. May run concurrently
/// with other in-flight calls, on any thread - must be reentrant.
pub const HandlerFn = *const fn (user_data: ?*anyopaque, req: []const u8) anyerror![]const u8;

const HandlerCtx = struct {
    handler: HandlerFn,
    user_data: ?*anyopaque,
};

fn trampoline(
    user_data: ?*anyopaque,
    req: [*c]const u8,
    req_len: usize,
    resp: [*c][*c]u8,
    resp_len: [*c]usize,
) callconv(.c) c.magicseam_status {
    const ctx: *HandlerCtx = @ptrCast(@alignCast(user_data.?));
    const req_slice = if (req_len > 0) req[0..req_len] else &[_]u8{};
    const result = ctx.handler(ctx.user_data, req_slice) catch |err| return switch (err) {
        Error.Rejected => c.MAGICSEAM_ERR_REJECTED,
        Error.TooLarge => c.MAGICSEAM_ERR_TOOLARGE,
        else => c.MAGICSEAM_ERR_UNAVAIL,
    };
    const buf: ?*anyopaque = if (result.len > 0) std.c.malloc(result.len) else null;
    if (result.len > 0 and buf == null) return c.MAGICSEAM_ERR_UNAVAIL;
    if (result.len > 0) {
        const dst: [*]u8 = @ptrCast(buf.?);
        @memcpy(dst[0..result.len], result);
    }
    resp.* = @ptrCast(buf);
    resp_len.* = result.len;
    return c.MAGICSEAM_OK;
}

pub const Server = struct {
    ptr: *c.magicseam_quic_server,
    ctx: *HandlerCtx,
    allocator: std.mem.Allocator,

    /// Binds addr ("tcp:<host:port>", e.g. "tcp:0.0.0.0:9400") and serves
    /// handler forever on its own threads (non-blocking: returns once the
    /// listener is bound and its I/O thread is running). version is this
    /// provider's own self-declared seam version (purely informational -
    /// the connecting consumer's own gate is what actually enforces
    /// compatibility against it), reported at every handshake.
    pub fn serve(
        allocator: std.mem.Allocator,
        addr: [:0]const u8,
        cert_path: [:0]const u8,
        key_path: [:0]const u8,
        ca_path: [:0]const u8,
        version: [:0]const u8,
        handler: HandlerFn,
        user_data: ?*anyopaque,
    ) Error!Server {
        const ctx = allocator.create(HandlerCtx) catch return Error.Unavailable;
        errdefer allocator.destroy(ctx);
        ctx.* = .{ .handler = handler, .user_data = user_data };

        var out: ?*c.magicseam_quic_server = null;
        const status = c.magicseam_quic_serve(
            addr.ptr,
            cert_path.ptr,
            key_path.ptr,
            ca_path.ptr,
            version.ptr,
            trampoline,
            ctx,
            &out,
        );
        try checkStatus(status);
        return .{ .ptr = out.?, .ctx = ctx, .allocator = allocator };
    }

    /// Stops accepting new connections, closes every live one, and joins
    /// every thread the server owns.
    pub fn close(self: Server) void {
        c.magicseam_quic_server_close(self.ptr);
        self.allocator.destroy(self.ctx);
    }
};
