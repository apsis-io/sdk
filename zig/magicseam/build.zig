const std = @import("std");

// Zig magic-seam SDK (ADR-0028/0043): wraps c/magicseam's own QUIC
// implementation rather than re-porting ngtcp2 handling a third time (Go/TS
// re-implement the wire protocol natively; C owns the one ngtcp2 binding,
// Zig links straight into it via @cImport - see magicseam.zig's own doc
// comment). The five C sources compiled below are c/magicseam's actual
// implementation, not a copy - this directory has no independent protocol
// logic of its own.
const c_sdk_dir = "../../c/magicseam";
const c_srcs = [_][]const u8{
    "frame.c",
    "tls.c",
    "io.c",
    "client.c",
    "server.c",
};
const c_flags = [_][]const u8{
    "-std=c11",
    "-D_POSIX_C_SOURCE=200809L",
    // Matches c/magicseam/Makefile's own plain build (no UBSan there
    // either). Zig's C frontend instruments Debug builds with UBSan by
    // default; without this the final system-cc link (see the .use_lld
    // comment below) fails with undefined __ubsan_handle_* references,
    // since that step never links zig's own ubsan runtime.
    "-fno-sanitize=undefined",
};

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const c_lib = b.addLibrary(.{
        .name = "magicseam_quic",
        .linkage = .static,
        .root_module = b.createModule(.{
            .target = target,
            .optimize = optimize,
            .link_libc = true,
        }),
    });
    c_lib.root_module.addIncludePath(b.path(c_sdk_dir));
    for (c_srcs) |src| {
        c_lib.root_module.addCSourceFile(.{
            .file = b.path(b.pathJoin(&.{ c_sdk_dir, src })),
            .flags = &c_flags,
        });
    }
    linkQuicDeps(c_lib.root_module);

    const mod = b.addModule("magicseam", .{
        .root_source_file = b.path("magicseam.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    mod.addIncludePath(b.path(c_sdk_dir));
    mod.linkLibrary(c_lib);

    // Zig's own self-hosted ELF linker (used by addRunArtifact's normal
    // build-exe/build-test path, LLD or not - .use_lld=false just switches
    // between them) can't yet relocate the .sframe sections this host's
    // GCC 16 crt objects carry ("fatal linker error: unhandled relocation
    // type R_X86_64_PC64" in crt1.o). `zig cc`/system cc link the exact
    // same objects fine (a distinct code path from zig build-exe's own
    // linker). Workaround: compile the test to a plain .o (emit_object,
    // never linked by zig) and link+run it via the system `cc` instead.
    const tests = b.addTest(.{
        .root_module = b.createModule(.{
            .root_source_file = b.path("magicseam_test.zig"),
            .target = target,
            .optimize = optimize,
            .link_libc = true,
        }),
        .emit_object = true,
    });
    tests.root_module.addImport("magicseam", mod);
    tests.root_module.addIncludePath(b.path(c_sdk_dir));
    tests.root_module.linkLibrary(c_lib);

    // Unlike a raw `zig test-obj` CLI invocation (which embeds a complete
    // freestanding _start), build.zig's own emit_object test compiles down
    // to a plain exported `main` - system cc's normal crt (Scrt1.o -> main)
    // picks it up with no extra flags needed.
    const link_test_bin = b.addSystemCommand(&.{"cc"});
    link_test_bin.addArtifactArg(tests);
    link_test_bin.addArtifactArg(c_lib);
    link_test_bin.addArg("-o");
    const test_bin = link_test_bin.addOutputFileArg("magicseam_test");
    link_test_bin.addArgs(&.{ "-lngtcp2_crypto_ossl", "-lngtcp2", "-lssl", "-lcrypto", "-lpthread", "-lc" });

    const run_tests = std.Build.Step.Run.create(b, "run magicseam zig SDK tests");
    run_tests.addFileArg(test_bin);

    const test_step = b.step("test", "Run the magic-seam Zig SDK's own test suite");
    test_step.dependOn(&run_tests.step);
}

// Same system libraries c/magicseam/Makefile links (found via
// pkg-config there; hardcoded here since Zig's build system has no
// pkg-config integration and these names are stable ABI facts, not a build
// configuration that varies per-machine).
fn linkQuicDeps(m: *std.Build.Module) void {
    m.linkSystemLibrary("ngtcp2_crypto_ossl", .{});
    m.linkSystemLibrary("ngtcp2", .{});
    m.linkSystemLibrary("ssl", .{});
    m.linkSystemLibrary("crypto", .{});
}
