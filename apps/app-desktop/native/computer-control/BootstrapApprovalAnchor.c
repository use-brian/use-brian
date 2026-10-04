#include "BootstrapApprovalAnchor.h"
#include <string.h>

/* XNU xnu-10002.1.13 / 1031c584a5e37aff177559b9f69dbd3c8c3fd30a,
 * EXTERNAL_HEADERS/mach-o/loader.h: SG_READ_ONLY, S_ATTR_NO_DEAD_STRIP.
 * __DATA_CONST is made read-only after fixups, NOT authenticated by its name.
 * Native Mac SDK compile/link and actual section layout still need acceptance.
 * Volatile reads are intentional: pre-sign patching is unknown to the optimizer.
 * No runtime setter, environment override, path lookup or parent-supplied input.
 */
#if !defined(__APPLE__) || !defined(__MACH__)
#error "BootstrapApprovalAnchor requires Darwin; no production fallback"
#endif

/* ANCHOR_DEFINITION_BEGIN: separate injected test translation units ONLY may
 * replace this definition. No production test macro or alternate runtime source. */
__attribute__((used, aligned(16), section("__DATA_CONST,__br_bootstrap,regular,no_dead_strip")))
static const volatile uint8_t brian_bootstrap_anchor[BRIAN_BOOTSTRAP_APPROVAL_SIZE] = {
    0x42, 0x52, 0x49, 0x41, 0x4e, 0x5f, 0x42, 0x4f,
    0x4f, 0x54, 0x53, 0x54, 0x52, 0x41, 0x50, 0x5f,
    0x41, 0x4e, 0x43, 0x48, 0x4f, 0x52, 0x5f, 0x56,
    0x31, 0x8c, 0xa1, 0xd3, 0xf9, 0xb7, 0x60, 0x42,
    [33] = 1, [38] = 5, [39] = 0x60, [46] = 20, [47] = 32,
    [48] = '4', [49] = '3', [50] = '.', [51] = '2', [52] = '.', [53] = '0'
};
/* ANCHOR_DEFINITION_END */
_Static_assert(sizeof(brian_bootstrap_anchor) == 1376, "anchor ABI");

/* Encoded AND volatile: optimization must not emit a second whole marker
 * constant, which would violate the packager's artifact-wide uniqueness check. */
static const volatile uint8_t marker_xor[32] = {
    0xe7, 0xf7, 0xec, 0xe4, 0xeb, 0xfa, 0xe7, 0xea,
    0xea, 0xf1, 0xf6, 0xf1, 0xf7, 0xe4, 0xf5, 0xfa,
    0xe4, 0xeb, 0xe6, 0xed, 0xea, 0xf7, 0xfa, 0xf3,
    0x94, 0x29, 0x04, 0x76, 0x5c, 0x12, 0xc5, 0xe7
};
static uint32_t be32(const uint8_t *p) {
    return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) |
           ((uint32_t)p[2] << 8) | p[3];
}
static int zero(const uint8_t *p, size_t n) {
    for (size_t i = 0; i < n; ++i) if (p[i] != 0) return 0;
    return 1;
}
static brian_bootstrap_anchor_result validate(const uint8_t *b) {
    for (size_t i = 0; i < 32; ++i)
        if (b[i] != (uint8_t)(marker_xor[i] ^ 0xa5u)) return BRIAN_BOOTSTRAP_ANCHOR_MALFORMED;
    if (b[32] != 0 || b[33] != 1 || b[34] > 1 || b[35] != 0 ||
        be32(b + 36) != BRIAN_BOOTSTRAP_APPROVAL_SIZE || b[46] != 20 || b[47] != 32 ||
        memcmp(b + 48, "43.2.0\0", 8) != 0 || !zero(b + 56, 8))
        return BRIAN_BOOTSTRAP_ANCHOR_MALFORMED;
    const uint32_t count = ((uint32_t)b[44] << 8) | b[45];
    if (!b[34]) {
        if (be32(b + 40) || count || !zero(b + 64, BRIAN_BOOTSTRAP_APPROVAL_SIZE - 64))
            return BRIAN_BOOTSTRAP_ANCHOR_MALFORMED;
        return BRIAN_BOOTSTRAP_ANCHOR_EMPTY;
    }
    if (count == 0 || count > BRIAN_BOOTSTRAP_APPROVAL_MAX_HASHES ||
        be32(b + 40) != 96 + count * 20 || zero(b + 64, 32) ||
        !zero(b + 96 + count * 20, BRIAN_BOOTSTRAP_APPROVAL_SIZE - 96 - count * 20))
        return BRIAN_BOOTSTRAP_ANCHOR_MALFORMED;
    for (uint32_t i = 0; i < count; ++i) {
        const uint8_t *hash = b + 96 + i * 20;
        if (zero(hash, 20) || (i && memcmp(hash - 20, hash, 20) >= 0))
            return BRIAN_BOOTSTRAP_ANCHOR_MALFORMED;
    }
    return BRIAN_BOOTSTRAP_ANCHOR_UNAUTHENTICATED_DATA;
}
brian_bootstrap_anchor_result brian_bootstrap_approval_copy(
    uint8_t *output, size_t capacity, size_t *written) {
    if (written) *written = 0;
    if (!output || capacity != BRIAN_BOOTSTRAP_APPROVAL_SIZE)
        return BRIAN_BOOTSTRAP_ANCHOR_INVALID_ARGUMENT;
    if (!written) {
        memset(output, 0, BRIAN_BOOTSTRAP_APPROVAL_SIZE);
        return BRIAN_BOOTSTRAP_ANCHOR_INVALID_ARGUMENT;
    }
    /* Caller owns a separate writable buffer, as specified in the header. */
    for (size_t i = 0; i < BRIAN_BOOTSTRAP_APPROVAL_SIZE; ++i)
        output[i] = brian_bootstrap_anchor[i];
    const brian_bootstrap_anchor_result result = validate(output);
    if (result != BRIAN_BOOTSTRAP_ANCHOR_UNAUTHENTICATED_DATA) {
        memset(output, 0, BRIAN_BOOTSTRAP_APPROVAL_SIZE);
        return result;
    }
    *written = BRIAN_BOOTSTRAP_APPROVAL_SIZE;
    return result; /* DATA, NEVER authority */
}

/* Separate pre-sign-only record, never a bootstrap library pin.
 * VISUAL_DEFINITION_BEGIN: injected test translation units only. */
__attribute__((used, aligned(16), section("__DATA_CONST,__br_visual,regular,no_dead_strip")))
static const volatile uint8_t brian_visual_fixture_pin[80] = {
    0x42, 0x52, 0x49, 0x41, 0x4e, 0x5f, 0x56, 0x49, 0x53, 0x55, 0x41, 0x4c, 0x5f, 0x46, 0x49, 0x58, 0x54, 0x55, 0x52, 0x45, 0x5f, 0x50, 0x49, 0x4e, 0x5f, 0x56, 0x31, 0x8c, 0xa1, 0xd3, 0xf9, 0xb7,
    [33] = 1, [35] = 20, [39] = 80
};
/* VISUAL_DEFINITION_END */
static const volatile uint8_t visual_marker_xor[32] = {
    0xe7, 0xf7, 0xec, 0xe4, 0xeb, 0xfa, 0xf3, 0xec, 0xf6, 0xf0, 0xe4, 0xe9, 0xfa, 0xe3, 0xec, 0xfd, 0xf1, 0xf0, 0xf7, 0xe0, 0xfa, 0xf5, 0xec, 0xeb, 0xfa, 0xf3, 0x94, 0x29, 0x04, 0x76, 0x5c, 0x12
};
int brian_visual_fixture_hashes_copy(uint8_t *output, size_t capacity) {
    if (!output || capacity != 40) return 0;
    memset(output, 0, 40);
    uint8_t b[80];
    for (size_t i = 0; i < sizeof(b); ++i) b[i] = brian_visual_fixture_pin[i];
    for (size_t i = 0; i < 32; ++i)
        if (b[i] != (uint8_t)(visual_marker_xor[i] ^ 0xa5u)) return 0;
    const unsigned count = b[34];
    if (b[32] || b[33] != 1 || count < 1 || count > 2 || b[35] != 20 ||
        be32(b + 36) != 80 || !zero(b + 40 + count * 20, 40 - count * 20)) return 0;
    for (unsigned i = 0; i < count; ++i)
        if (zero(b + 40 + i * 20, 20) ||
            (i && memcmp(b + 40, b + 60, 20) >= 0)) return 0;
    memcpy(output, b + 40, count * 20);
    return (int)count;
}
