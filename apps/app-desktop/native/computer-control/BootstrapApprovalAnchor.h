#ifndef BRIAN_BOOTSTRAP_APPROVAL_ANCHOR_H
#define BRIAN_BOOTSTRAP_APPROVAL_ANCHOR_H
#include <stddef.h>
#include <stdint.h>

/* DATA ONLY, not an authorization API. No parent path/team/environment input.
 * Future admission must authenticate the helper's OWN mapped pages, kernel
 * signing identity/exec generation and valid Apple-issued signature before using
 * this record as expected bootstrap data. Team trust comes from that signature,
 * NEVER from this record. Copy success cannot establish any of those conditions.
 * No helper admission/build/signing integration exists in this change.
 *
 * v1 canonical wire layout, integers big-endian (no C struct ABI/padding):
 *   0..31 fixed marker; 32..33 version=1; 34 used (compiled default=0);
 *   35 reserved=0; 36..39 total size=1376; 40..43 used length (96+20*count);
 *   44..45 count=1..64; 46 CDHash width=20; 47 digest width=32;
 *   48..55 exact ASCII "43.2.0\0\0"; 56..63 reserved=0;
 *   64..95 nonzero ASAR integrity-dictionary SHA256 digest;
 *   96..1375 up to 64 nonzero, strictly ascending, unique 20-byte CDHashes;
 *   unused inventory bytes MUST be zero.
 * Empty: used=0, used length/count/digest/inventory all zero; fixed ABI fields
 * remain present. Empty and any malformed record refuse the copy operation.
 *
 * Required future signing order (no circular main-executable CDHash pin):
 * finalize/sign all nested libraries first; obtain the COMPLETE approved
 * non-Apple library CDHash inventory across approved architectures and the
 * pinned Electron 43.2.0 ASAR dictionary digest from trusted build inputs;
 * stamp the empty helper anchor BEFORE final helper signing; then sign helper
 * and outer app. Never take these expectations from the parent under inspection.
 * Main/helper final signing is later and is deliberately NOT in the inventory.
 */
#define BRIAN_BOOTSTRAP_APPROVAL_SIZE 1376u
#define BRIAN_BOOTSTRAP_APPROVAL_MAX_HASHES 64u

typedef enum {
    BRIAN_BOOTSTRAP_ANCHOR_UNAUTHENTICATED_DATA = 1,
    BRIAN_BOOTSTRAP_ANCHOR_INVALID_ARGUMENT = 10,
    BRIAN_BOOTSTRAP_ANCHOR_EMPTY = 11,
    BRIAN_BOOTSTRAP_ANCHOR_MALFORMED = 12
} brian_bootstrap_anchor_result;

/* Reads this module's fixed in-memory symbol, never an on-disk executable.
 * Caller supplies exactly SIZE writable bytes, disjoint from this module, and
 * a separate size_t. On failure written=0 and a valid SIZE buffer is cleared.
 * Invalid capacities are not dereferenced/cleared. No partial evidence returned.
 * Non-Darwin production compilation is explicitly unsupported, not a fallback.
 */
brian_bootstrap_anchor_result brian_bootstrap_approval_copy(
    uint8_t *output, size_t capacity, size_t *written);
#endif
