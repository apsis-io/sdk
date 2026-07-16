//! Real loopback QUIC integration tests - real UDP sockets on 127.0.0.1,
//! real mTLS handshakes, real streams, only the handler is a trivial mock.
//! Mirrors sdk/c/magicseam/magicseam_quic_test.c (and sdk/go, sdk/ts's own
//! versions) exactly: same three tests, same generous timing bound - this
//! is what actually proves the wrapper (not just the underlying C library
//! in isolation) round-trips real calls, including through the Zig-side
//! handler trampoline.
const std = @import("std");
const magicseam = @import("magicseam");

// libc directly (mkdtemp/system/nanosleep/clock_gettime) rather than
// std.process.Child/std.time - this SDK is fundamentally a C-interop
// wrapper already, and matches the C test's own gen_test_certs/sleep_ms
// approach exactly instead of chasing zig std's still-moving Io/time APIs.
const libc = @cImport({
    @cInclude("stdlib.h");
    @cInclude("stdio.h");
    @cInclude("time.h");
});

fn sleepMs(ms: i64) void {
    var ts: libc.struct_timespec = .{
        .tv_sec = @intCast(@divTrunc(ms, 1000)),
        .tv_nsec = @intCast(@mod(ms, 1000) * 1_000_000),
    };
    _ = libc.nanosleep(&ts, null);
}

fn nowMs() u64 {
    var ts: libc.struct_timespec = undefined;
    _ = libc.clock_gettime(libc.CLOCK_MONOTONIC, &ts);
    return @as(u64, @intCast(ts.tv_sec)) * 1000 + @as(u64, @intCast(ts.tv_nsec)) / 1_000_000;
}

fn runShell(cmd: [:0]const u8) !void {
    const rc = libc.system(cmd.ptr);
    if (rc != 0) return error.CommandFailed;
}

const TestCerts = struct {
    cert: [:0]u8,
    key: [:0]u8,
    ca: [:0]u8,
};

/// Mints a throwaway CA + one leaf (CN/SAN = magicseam.sni) via the openssl
/// CLI - same approach as every other magic-seam SDK's own test harness.
/// Both client and server use the SAME leaf, matching this SDK's fixed-SAN
/// design.
fn genTestCerts(allocator: std.mem.Allocator) !TestCerts {
    var dir_buf: [64]u8 = undefined;
    @memcpy(dir_buf[0..30], "/tmp/magicseam-zig-test-XXXXXX");
    dir_buf[30] = 0;
    const dir_z: [*:0]u8 = @ptrCast(&dir_buf);
    if (libc.mkdtemp(dir_z) == null) return error.MkdtempFailed;
    const dir = std.mem.sliceTo(dir_z, 0);

    const ca_key = try std.fmt.allocPrintSentinel(allocator, "{s}/ca.key", .{dir}, 0);
    const ca_cert = try std.fmt.allocPrintSentinel(allocator, "{s}/ca.pem", .{dir}, 0);
    const leaf_key = try std.fmt.allocPrintSentinel(allocator, "{s}/leaf.key", .{dir}, 0);
    const leaf_csr = try std.fmt.allocPrintSentinel(allocator, "{s}/leaf.csr", .{dir}, 0);
    const leaf_cert = try std.fmt.allocPrintSentinel(allocator, "{s}/leaf.pem", .{dir}, 0);
    const ext_file = try std.fmt.allocPrintSentinel(allocator, "{s}/ext.cnf", .{dir}, 0);
    defer allocator.free(ca_key);
    defer allocator.free(leaf_csr);
    defer allocator.free(ext_file);
    // leaf_key/leaf_cert/ca_cert are returned in TestCerts - owned by the
    // caller from here, not freed locally.

    var cmd_buf: [4096]u8 = undefined;

    try runShell(try std.fmt.bufPrintZ(&cmd_buf,
        "openssl ecparam -name prime256v1 -genkey -noout -out {s} >/dev/null 2>&1", .{ca_key}));
    try runShell(try std.fmt.bufPrintZ(&cmd_buf,
        "openssl req -x509 -new -key {s} -days 1 -out {s} -subj \"/CN=test-trail-ca\" >/dev/null 2>&1",
        .{ ca_key, ca_cert }));
    try runShell(try std.fmt.bufPrintZ(&cmd_buf,
        "openssl ecparam -name prime256v1 -genkey -noout -out {s} >/dev/null 2>&1", .{leaf_key}));
    try runShell(try std.fmt.bufPrintZ(&cmd_buf,
        "openssl req -new -key {s} -out {s} -subj \"/CN={s}\" >/dev/null 2>&1",
        .{ leaf_key, leaf_csr, magicseam.sni }));

    {
        const f = libc.fopen(ext_file.ptr, "w") orelse return error.OpenExtFileFailed;
        defer _ = libc.fclose(f);
        _ = libc.fprintf(f, "subjectAltName=DNS:%s\n", magicseam.sni.ptr);
    }
    try runShell(try std.fmt.bufPrintZ(&cmd_buf,
        "openssl x509 -req -in {s} -CA {s} -CAkey {s} -CAcreateserial -days 1 -out {s} -extfile {s} >/dev/null 2>&1",
        .{ leaf_csr, ca_cert, ca_key, leaf_cert, ext_file }));

    return .{ .cert = leaf_cert, .key = leaf_key, .ca = ca_cert };
}

fn echoHandler(user_data: ?*anyopaque, req: []const u8) anyerror![]const u8 {
    _ = user_data;
    return req;
}

test "real loopback mTLS round trip" {
    const gpa = std.testing.allocator;
    const certs = try genTestCerts(gpa);
    defer gpa.free(certs.cert);
    defer gpa.free(certs.key);
    defer gpa.free(certs.ca);

    const srv = try magicseam.Server.serve(
        gpa,
        "tcp:127.0.0.1:19830",
        certs.cert,
        certs.key,
        certs.ca,
        "0.1.0",
        echoHandler,
        null,
    );
    defer srv.close();
    sleepMs(150);

    var served_buf: [64]u8 = undefined;
    const client = try magicseam.Client.dial(
        "tcp:127.0.0.1:19830",
        certs.cert,
        certs.key,
        certs.ca,
        "0.1.0",
        &served_buf,
    );
    defer client.close();
    const served = std.mem.sliceTo(&served_buf, 0);
    try std.testing.expectEqualStrings("0.1.0", served);

    const msg = "hello quic zig";
    const resp = try client.call(gpa, msg);
    defer gpa.free(resp);
    try std.testing.expectEqualStrings(msg, resp);
}

fn slowEchoHandler(user_data: ?*anyopaque, req: []const u8) anyerror![]const u8 {
    _ = user_data;
    sleepMs(200);
    return req;
}

const CallThreadArg = struct {
    client: magicseam.Client,
    allocator: std.mem.Allocator,
    byte: u8,
    ok: bool = false,
};

fn callThreadMain(arg: *CallThreadArg) void {
    const resp = arg.client.call(arg.allocator, &[_]u8{arg.byte}) catch return;
    defer arg.allocator.free(resp);
    arg.ok = true;
}

test "concurrent calls do not serialize" {
    const gpa = std.testing.allocator;
    const certs = try genTestCerts(gpa);
    defer gpa.free(certs.cert);
    defer gpa.free(certs.key);
    defer gpa.free(certs.ca);

    const srv = try magicseam.Server.serve(
        gpa,
        "tcp:127.0.0.1:19831",
        certs.cert,
        certs.key,
        certs.ca,
        "",
        slowEchoHandler,
        null,
    );
    defer srv.close();
    sleepMs(150);

    var served_buf: [1]u8 = undefined;
    const client = try magicseam.Client.dial(
        "tcp:127.0.0.1:19831",
        certs.cert,
        certs.key,
        certs.ca,
        "",
        served_buf[0..0],
    );
    defer client.close();

    var a1: CallThreadArg = .{ .client = client, .allocator = gpa, .byte = 1 };
    var a2: CallThreadArg = .{ .client = client, .allocator = gpa, .byte = 2 };
    const start = nowMs();
    const t1 = try std.Thread.spawn(.{}, callThreadMain, .{&a1});
    const t2 = try std.Thread.spawn(.{}, callThreadMain, .{&a2});
    t1.join();
    t2.join();
    const elapsed = nowMs() - start;

    try std.testing.expect(a1.ok);
    try std.testing.expect(a2.ok);
    // Two 200ms handler calls that ran concurrently finish in ~200ms;
    // serialized, they'd take ~400ms. Generous bound to absorb loopback
    // jitter - same bound every other magic-seam SDK's own test uses.
    try std.testing.expect(elapsed < 350);
}

fn faultyHandler(user_data: ?*anyopaque, req: []const u8) anyerror![]const u8 {
    _ = user_data;
    if (std.mem.eql(u8, req, "reject")) return magicseam.Error.Rejected;
    if (std.mem.eql(u8, req, "toolarge")) return magicseam.Error.TooLarge;
    return magicseam.Error.Unavailable;
}

test "rejected/too-large/other error tags round-trip" {
    const gpa = std.testing.allocator;
    const certs = try genTestCerts(gpa);
    defer gpa.free(certs.cert);
    defer gpa.free(certs.key);
    defer gpa.free(certs.ca);

    const srv = try magicseam.Server.serve(
        gpa,
        "tcp:127.0.0.1:19832",
        certs.cert,
        certs.key,
        certs.ca,
        "",
        faultyHandler,
        null,
    );
    defer srv.close();
    sleepMs(150);

    var served_buf: [1]u8 = undefined;
    const client = try magicseam.Client.dial(
        "tcp:127.0.0.1:19832",
        certs.cert,
        certs.key,
        certs.ca,
        "",
        served_buf[0..0],
    );
    defer client.close();

    try std.testing.expectError(magicseam.Error.Rejected, client.call(gpa, "reject"));
    try std.testing.expectError(magicseam.Error.TooLarge, client.call(gpa, "toolarge"));
    try std.testing.expectError(magicseam.Error.Unavailable, client.call(gpa, "other"));
}
