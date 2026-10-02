/* INTERNAL READ-ONLY release tool; never launches a candidate, signs code,
 * requests a private key, changes an app, grants permissions or admits a helper.
 * No CLI path/identity/environment overrides. Request comes from private pipes
 * owned by the Node release adapter, NOT from a parent being authenticated.
 *
 * Public Apple source pin Security-61040.1.3:
 * https://github.com/apple-oss-distributions/Security/blob/ef677c3d667a44e1737c1b0245e9ed04d11c51c1/OSX/libsecurity_codesigning/lib/SecStaticCode.h
 * https://github.com/apple-oss-distributions/Security/blob/ef677c3d667a44e1737c1b0245e9ed04d11c51c1/OSX/libsecurity_codesigning/lib/SecStaticCode.cpp
 * UniversalFileOffset is parsed as C int: reject offsets > INT_MAX.
 * https://github.com/apple-oss-distributions/Security/blob/ef677c3d667a44e1737c1b0245e9ed04d11c51c1/OSX/libsecurity_codesigning/lib/SecCode.h
 * https://github.com/apple-oss-distributions/Security/blob/ef677c3d667a44e1737c1b0245e9ed04d11c51c1/OSX/libsecurity_codesigning/lib/CSCommon.h
 * C uses kSecCSNoNetworkAccess (NOT a guessed Swift imported spelling). Offline
 * validation explicitly does NOT prove online revocation or notarization status.
 *
 * Full CodeDirectory SHA256 is computed by the private branded JS parser, not
 * obtained through invented/private CF metadata. This tool independently checks
 * whole-file SHA256 against that capture, native slice geometry/type, and fresh
 * CF selected-CDHash/SHA256/team/main-executable before AND after reading bytes.
 * The response binds the ENTIRE request including full-CD/file/capture digests.
 * Native CF's 20-byte unique alone is not mislabeled a full-CD hash calculation.
 *
 * This is quiescent release verification, NOT an atomic adversarial snapshot,
 * runtime loaded-image proof, ASAR/dependency closure or production authority.
 * Real Mac SDK compilation and Developer-ID acceptance remain native conditions;
 * Linux fake-CF ABI tests are not claims that Apple accepted any synthetic code.
 */
#if !defined(__APPLE__) || !defined(__MACH__)
#error "BootstrapInventoryVerifier requires macOS Security"
#endif
#include <CoreFoundation/CoreFoundation.h>
#include <Security/SecStaticCode.h>
#include <Security/SecCode.h>
#include <Security/SecRequirement.h>
#include <Security/CSCommon.h>
#include <CommonCrypto/CommonDigest.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <fcntl.h>
#include <unistd.h>
#include <signal.h>
#include <limits.h>
#include <stdint.h>
#include <stdbool.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>

#define MAX_REQUEST (1024u * 1024u)
#define MAX_FILE (512ull * 1024ull * 1024ull)
#define MAX_ENTRIES 256u
#define MAX_REL 2048u
#define MAX_DEPTH 48u
#define RESPONSE_SIZE 88u
#define REFUSED 74
static const uint8_t req_magic[8] = {'B','R','I','N','V','R','E','Q'};
static const uint8_t res_magic[8] = {'B','R','I','N','V','R','E','S'};
static uint16_t be16(const uint8_t *b) { return (uint16_t)(((uint16_t)b[0] << 8) | b[1]); }
static uint32_t be32(const uint8_t *b) { return ((uint32_t)b[0] << 24) | ((uint32_t)b[1] << 16) | ((uint32_t)b[2] << 8) | b[3]; }
static uint64_t be64(const uint8_t *b) { return ((uint64_t)be32(b) << 32) | be32(b + 4); }
static uint32_t le32(const uint8_t *b) { return (uint32_t)b[0] | ((uint32_t)b[1] << 8) | ((uint32_t)b[2] << 16) | ((uint32_t)b[3] << 24); }
static void put16(uint8_t *b, unsigned v) { b[0] = (uint8_t)(v >> 8); b[1] = (uint8_t)v; }
static int zero(const uint8_t *b, size_t n) { for (size_t i = 0; i < n; i++) if (b[i]) return 0; return 1; }
static int exact_read(int fd, void *buffer, size_t n) {
    uint8_t *b = buffer; size_t at = 0;
    while (at < n) { ssize_t got = read(fd, b + at, n - at); if (got <= 0) return 0; at += (size_t)got; }
    return 1;
}
static int exact_pread(int fd, void *buffer, size_t n, uint64_t offset) {
    uint8_t *b = buffer; size_t at = 0;
    while (at < n) { ssize_t got = pread(fd, b + at, n - at, (off_t)(offset + at)); if (got <= 0) return 0; at += (size_t)got; }
    return 1;
}
static int exact_write(int fd, const void *buffer, size_t n) {
    const uint8_t *b = buffer; size_t at = 0;
    while (at < n) { ssize_t got = write(fd, b + at, n - at); if (got <= 0) return 0; at += (size_t)got; }
    return 1;
}
static int text(char *out, size_t capacity, const uint8_t *b, size_t n) {
    if (!n || n >= capacity || memchr(b, 0, n)) return 0;
    memcpy(out, b, n); out[n] = 0; return 1;
}
static int relative_path(const char *s) {
    size_t n = strlen(s), component = 0, depth = 1;
    if (!n || n > MAX_REL || s[0] == '/' || s[0] == ' ') return 0;
    for (size_t i = 0; i <= n; i++) {
        char c = s[i];
        if (c == '/' || !c) {
            size_t len = i - component;
            if (!len || len > 255 || s[component] == ' ' || s[i-1] == ' ' ||
                (len == 1 && s[component] == '.') || (len == 2 && s[component] == '.' && s[component+1] == '.')) return 0;
            component = i + 1; if (c && ++depth > MAX_DEPTH) return 0;
        } else if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || strchr("._ @()+-", c))) return 0;
    }
    return 1;
}
typedef struct { uint8_t arch; uint64_t offset, size; uint8_t short_hash[20], full_hash[32]; } Slice;
typedef struct {
    char leaf[MAX_REL+1], target[MAX_REL+1], version[256];
    uint8_t kind, count; uint64_t size; uint8_t file_hash[32]; Slice slices[2];
} Entry;
static const char *last_occurrence(const char *s, const char *needle) {
    const char *last = NULL, *at = s;
    while ((at = strstr(at, needle))) { last = at; at++; } return last;
}
/* Independently derive the ONLY allowed Security target, never fallback from a
 * bundle to the raw file if bundle verification fails. Current-version symlinks
 * cannot choose the slice/version; CF main-executable must canonicalize to leaf. */
static int correct_target(const Entry *e) {
    char target[MAX_REL+1], version[256] = {0}; unsigned kind = 0;
    strcpy(target, e->leaf);
    const char *fw = last_occurrence(e->leaf, ".framework/");
    if (fw) {
        const char *start = fw;
        while (start > e->leaf && start[-1] != '/') start--;
        const char *rest = fw + strlen(".framework/");
        const char *binary = rest; size_t vn = 0;
        if (strncmp(rest, "Versions/", 9) == 0) {
            const char *slash = strchr(rest + 9, '/');
            if (slash) { vn = (size_t)(slash - rest - 9); binary = slash + 1; }
        }
        if (!strchr(binary, '/') && (size_t)(fw - start) == strlen(binary) && memcmp(start, binary, strlen(binary)) == 0) {
            if (vn >= sizeof(version)) return 0;
            if (vn) memcpy(version, rest + 9, vn);
            size_t tn = (size_t)(fw - e->leaf) + strlen(".framework");
            memcpy(target, e->leaf, tn); target[tn] = 0; kind = 1;
        }
    }
    if (!kind) {
        const char *bundle = last_occurrence(e->leaf, ".bundle/Contents/MacOS/");
        if (bundle && bundle[strlen(".bundle/Contents/MacOS/")] && !strchr(bundle + strlen(".bundle/Contents/MacOS/"), '/')) {
            size_t tn = (size_t)(bundle - e->leaf) + strlen(".bundle");
            memcpy(target, e->leaf, tn); target[tn] = 0; kind = 2;
        }
    }
    return kind == e->kind && strcmp(target, e->target) == 0 && strcmp(version, e->version) == 0;
}
static int parse_entries(const uint8_t *request, size_t total, char root[4097], char team[11], Entry *entries, unsigned *n, unsigned *slice_count) {
    if (total < 96 || memcmp(request, req_magic, 8) || be16(request+8) != 1 || be16(request+10) != 96 ||
        be32(request+12) != total || request[19] || request[18] < 1 || request[18] > 3) return 0;
    *n = be16(request+16); *slice_count = 0;
    if (!*n || *n > MAX_ENTRIES || zero(request+32, 32)) return 0;
    for (size_t i = 0; i < 10; i++) if (!((request[22+i] >= 'A' && request[22+i] <= 'Z') || (request[22+i] >= '0' && request[22+i] <= '9'))) return 0;
    memcpy(team, request+22, 10); team[10] = 0;
    size_t rn = be16(request+20), at = 96;
    if (rn > total-at || !text(root, 4097, request+at, rn) || root[0] != '/') return 0;
    const char *base = strrchr(root, '/'); if (!base || strcmp(base+1, "Use Brian.app")) return 0;
    at += rn; uint64_t file_bytes = 0; uint8_t unique[64][32]; unsigned unique_count = 0;
    for (unsigned i = 0; i < *n; i++) {
        if (total-at < 52) return 0;
        const uint8_t *b = request+at; size_t length = be32(b), ln = be16(b+4), tn = be16(b+6), vn = be16(b+8);
        Entry *e = &entries[i]; e->count = b[10]; e->kind = b[11]; e->size = be64(b+12);
        if (length > total-at || e->count != (request[18] == 3 ? 2 : 1) || e->kind > 2 || vn > 255 ||
            e->size < 32 || e->size > MAX_FILE || length != 52 + ln + tn + vn + 72u * e->count) return 0;
        file_bytes += e->size; if (file_bytes > 2ull * 1024ull * 1024ull * 1024ull) return 0;
        memcpy(e->file_hash, b+20, 32); size_t p = 52;
        if (!text(e->leaf, sizeof(e->leaf), b+p, ln) || !relative_path(e->leaf)) return 0;
        p += ln;
        if (!text(e->target, sizeof(e->target), b+p, tn) || !relative_path(e->target)) return 0;
        p += tn;
        e->version[0] = 0;
        if (vn && (!text(e->version, sizeof(e->version), b+p, vn) || !relative_path(e->version) || strchr(e->version, '/'))) return 0;
        p += vn;
        if (!correct_target(e) || (i && strcmp(entries[i-1].leaf, e->leaf) >= 0)) return 0;
        unsigned mask = 0, previous = 0;
        for (unsigned j = 0; j < e->count; j++, p += 72) {
            Slice *s = &e->slices[j]; s->arch = b[p]; s->offset = be64(b+p+4); s->size = be64(b+p+12);
            if (s->arch < 1 || s->arch > 2 || s->arch <= previous || !zero(b+p+1, 3) || s->offset > INT_MAX ||
                s->offset > e->size || s->size < 32 || s->size > e->size - s->offset) return 0;
            previous = s->arch; mask |= s->arch; memcpy(s->short_hash, b+p+20, 20); memcpy(s->full_hash, b+p+40, 32);
            if (memcmp(s->short_hash, s->full_hash, 20) || zero(s->short_hash, 20)) return 0;
            unsigned u = 0;
            for (; u < unique_count; u++) if (!memcmp(unique[u], s->short_hash, 20)) {
                if (memcmp(unique[u], s->full_hash, 32)) return 0;
                break;
            }
            if (u == unique_count) {
                if (unique_count == 64) return 0;
                memcpy(unique[unique_count++], s->full_hash, 32);
            }
        }
        if (mask != request[18]) return 0;
        if (e->count == 2 && e->slices[0].offset < e->slices[1].offset + e->slices[1].size &&
            e->slices[1].offset < e->slices[0].offset + e->slices[0].size) return 0;
        *slice_count += e->count; at += length;
    }
    return at == total;
}
static int same_stat(const struct stat *a, const struct stat *b) {
    return a->st_dev == b->st_dev && a->st_ino == b->st_ino && a->st_mode == b->st_mode && a->st_nlink == b->st_nlink &&
        a->st_uid == b->st_uid && a->st_gid == b->st_gid && a->st_size == b->st_size &&
        a->st_mtimespec.tv_sec == b->st_mtimespec.tv_sec && a->st_mtimespec.tv_nsec == b->st_mtimespec.tv_nsec &&
        a->st_ctimespec.tv_sec == b->st_ctimespec.tv_sec && a->st_ctimespec.tv_nsec == b->st_ctimespec.tv_nsec;
}
typedef struct { int fd[MAX_DEPTH+1]; struct stat st[MAX_DEPTH+1]; char name[MAX_DEPTH][256]; size_t n; } Chain;
static void close_chain(Chain *c) { while (c->n) close(c->fd[--c->n]); }
static int open_chain(int rootfd, const char *relative, Chain *c) {
    memset(c, 0, sizeof(*c)); c->fd[0] = dup(rootfd); if (c->fd[0] < 0) return 0; c->n = 1;
    if (fstat(c->fd[0], &c->st[0])) return 0;
    char path[MAX_REL+1]; strcpy(path, relative); char *save = NULL, *part = strtok_r(path, "/", &save);
    while (part) {
        char *next = strtok_r(NULL, "/", &save);
        if (c->n > MAX_DEPTH) return 0;
        strcpy(c->name[c->n-1], part);
        int fd = openat(c->fd[c->n-1], part, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC | (next ? O_DIRECTORY : 0));
        if (fd < 0) return 0;
        c->fd[c->n] = fd; c->n++;
        if (fstat(fd, &c->st[c->n-1]) || (next ? !S_ISDIR(c->st[c->n-1].st_mode) :
            (!S_ISREG(c->st[c->n-1].st_mode) || c->st[c->n-1].st_nlink != 1))) return 0;
        part = next;
    }
    return c->n > 1;
}
static int stable_chain(const char *root, const char *leaf, const Chain *c) {
    struct stat s; char canonical[PATH_MAX];
    if (!realpath(root, canonical) || strcmp(root, canonical) || lstat(root, &s) || !same_stat(&s, &c->st[0]) ||
        !realpath(leaf, canonical) || strcmp(leaf, canonical)) return 0;
    for (size_t i = 0; i < c->n; i++) {
        if (fstat(c->fd[i], &s) || !same_stat(&s, &c->st[i])) return 0;
        if (i && (fstatat(c->fd[i-1], c->name[i-1], &s, AT_SYMLINK_NOFOLLOW) || !same_stat(&s, &c->st[i]))) return 0;
    }
    return 1;
}
static int macho_slices(int fd, const Entry *e) {
    uint8_t head[72]; if (!exact_pread(fd, head, 32, 0)) return 0;
    uint32_t magic = be32(head); int wide = magic == 0xcafebabf;
    if (magic == 0xcafebabe || wide) {
        unsigned n = be32(head+4), stride = wide ? 32u : 20u, mask = 0;
        if (n != e->count || !exact_pread(fd, head, 8 + n * stride, 0)) return 0;
        for (unsigned i = 0; i < n; i++) {
            const uint8_t *a = head + 8 + i * stride;
            unsigned arch = be32(a) == 0x0100000c && be32(a+4) == 0 ? 1u : be32(a) == 0x01000007 && be32(a+4) == 3 ? 2u : 0u;
            uint64_t off = wide ? be64(a+8) : be32(a+8), size = wide ? be64(a+16) : be32(a+12);
            uint32_t align = be32(a+(wide ? 24 : 16));
            if (!arch || (mask & arch) || align > 30 || off < 8 + n * stride || off % (1ull << align) || (wide && be32(a+28))) return 0;
            mask |= arch; const Slice *s = NULL;
            for (unsigned j = 0; j < e->count; j++) if (e->slices[j].arch == arch) s = &e->slices[j];
            if (!s || s->offset != off || s->size != size) return 0;
        }
    } else if (e->count != 1 || e->slices[0].offset != 0 || e->slices[0].size != e->size) return 0;
    for (unsigned i = 0; i < e->count; i++) {
        const Slice *s = &e->slices[i];
        if (!exact_pread(fd, head, 32, s->offset) || le32(head) != 0xfeedfacf ||
            le32(head+4) != (s->arch == 1 ? 0x0100000c : 0x01000007) || le32(head+8) != (s->arch == 1 ? 0 : 3) ||
            (le32(head+12) != 6 && le32(head+12) != 8)) return 0;
    }
    return 1;
}
static int hash_file(int fd, uint64_t size, const uint8_t expected[32]) {
    CC_SHA256_CTX ctx; uint8_t bytes[65536], result[32];
    if (!CC_SHA256_Init(&ctx)) return 0;
    for (uint64_t off = 0; off < size;) {
        size_t n = size-off < sizeof(bytes) ? (size_t)(size-off) : sizeof(bytes);
        if (!exact_pread(fd, bytes, n, off) || !CC_SHA256_Update(&ctx, bytes, (CC_LONG)n)) return 0;
        off += n;
    }
    if (pread(fd, bytes, 1, (off_t)size) != 0 || !CC_SHA256_Final(result, &ctx)) return 0;
    return memcmp(result, expected, 32) == 0;
}
static int number_two(CFTypeRef value) {
    int32_t n = 0;
    return value && CFGetTypeID(value) == CFNumberGetTypeID() && !CFNumberIsFloatType((CFNumberRef)value) &&
        CFNumberGetValue((CFNumberRef)value, kCFNumberSInt32Type, &n) && n == 2;
}
static int hash_twenty(CFTypeRef value, const uint8_t expected[20]) {
    return value && CFGetTypeID(value) == CFDataGetTypeID() && CFDataGetLength((CFDataRef)value) == 20 &&
        memcmp(CFDataGetBytePtr((CFDataRef)value), expected, 20) == 0;
}
static int metadata(CFDictionaryRef info, const Slice *slice, const char *team, const char *leaf) {
    if (!info || CFGetTypeID(info) != CFDictionaryGetTypeID()) return 0;
    if (!number_two(CFDictionaryGetValue(info, kSecCodeInfoDigestAlgorithm)) ||
        !hash_twenty(CFDictionaryGetValue(info, kSecCodeInfoUnique), slice->short_hash)) return 0;
    CFTypeRef algorithms = CFDictionaryGetValue(info, kSecCodeInfoDigestAlgorithms), hashes = CFDictionaryGetValue(info, kSecCodeInfoCdHashes);
    if (!algorithms || CFGetTypeID(algorithms) != CFArrayGetTypeID() || CFArrayGetCount((CFArrayRef)algorithms) != 1 ||
        !number_two(CFArrayGetValueAtIndex((CFArrayRef)algorithms, 0)) || !hashes || CFGetTypeID(hashes) != CFArrayGetTypeID() ||
        CFArrayGetCount((CFArrayRef)hashes) != 1 || !hash_twenty(CFArrayGetValueAtIndex((CFArrayRef)hashes, 0), slice->short_hash)) return 0;
    CFTypeRef t = CFDictionaryGetValue(info, kSecCodeInfoTeamIdentifier), url = CFDictionaryGetValue(info, kSecCodeInfoMainExecutable);
    char actual_team[11], actual_path[PATH_MAX], canonical[PATH_MAX];
    if (!t || CFGetTypeID(t) != CFStringGetTypeID() || !CFStringGetCString((CFStringRef)t, actual_team, sizeof(actual_team), kCFStringEncodingASCII) ||
        strcmp(team, actual_team) || !url || CFGetTypeID(url) != CFURLGetTypeID() ||
        !CFURLGetFileSystemRepresentation((CFURLRef)url, true, (UInt8 *)actual_path, sizeof(actual_path)) ||
        !realpath(actual_path, canonical) || strcmp(canonical, leaf)) return 0;
    return 1;
}
static int check_signature(const char *target, const char *leaf, const Entry *e, const Slice *slice, const char *team, SecRequirementRef requirement) {
    int okay = 0, offset = (int)slice->offset;
    CFURLRef url = NULL; CFNumberRef number = NULL; CFStringRef version = NULL;
    CFMutableDictionaryRef attributes = NULL; SecStaticCodeRef code = NULL; CFDictionaryRef info = NULL;
    url = CFURLCreateFromFileSystemRepresentation(NULL, (const UInt8 *)target, (CFIndex)strlen(target), e->kind != 0);
    number = CFNumberCreate(NULL, kCFNumberIntType, &offset);
    attributes = CFDictionaryCreateMutable(NULL, 0, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    if (!url || !number || !attributes) goto out;
    CFDictionarySetValue(attributes, kSecCodeAttributeUniversalFileOffset, number);
    if (e->version[0]) {
        version = CFStringCreateWithCString(NULL, e->version, kCFStringEncodingASCII); if (!version) goto out;
        CFDictionarySetValue(attributes, kSecCodeAttributeBundleVersion, version);
    }
    if (SecStaticCodeCreateWithPathAndAttributes(url, kSecCSDefaultFlags, attributes, &code) != errSecSuccess || !code) goto out;
    /* Do NOT require hardened-runtime flags on dylibs. Strict validation includes
     * code pages/resources; no skip flags, dynamic SecCode or network allowance. */
    const SecCSFlags flags = kSecCSStrictValidate | kSecCSCheckAllArchitectures | kSecCSNoNetworkAccess;
    if (SecStaticCodeCheckValidity(code, flags, requirement) != errSecSuccess ||
        SecCodeCopySigningInformation(code, kSecCSSigningInformation, &info) != errSecSuccess ||
        !metadata(info, slice, team, leaf)) goto out;
    okay = 1;
out:
    if (info) CFRelease(info);
    if (code) CFRelease(code);
    if (version) CFRelease(version);
    if (attributes) CFRelease(attributes);
    if (number) CFRelease(number);
    if (url) CFRelease(url);
    return okay;
}
static int verify_entry(int rootfd, const char *root, const Entry *e, const char *team, SecRequirementRef requirement) {
    Chain chain; char leaf[PATH_MAX], target[PATH_MAX]; int okay = 0;
    int n = snprintf(leaf, sizeof(leaf), "%s/%s", root, e->leaf), m = snprintf(target, sizeof(target), "%s/%s", root, e->target);
    if (n < 0 || m < 0 || (size_t)n >= sizeof(leaf) || (size_t)m >= sizeof(target)) return 0;
    if (!open_chain(rootfd, e->leaf, &chain)) { close_chain(&chain); return 0; }
    int fd = chain.fd[chain.n-1];
    if (chain.st[chain.n-1].st_size < 0 || (uint64_t)chain.st[chain.n-1].st_size != e->size ||
        !stable_chain(root, leaf, &chain) || !macho_slices(fd, e)) goto out;
    for (unsigned i = 0; i < e->count; i++) if (!check_signature(target, leaf, e, &e->slices[i], team, requirement) || !stable_chain(root, leaf, &chain)) goto out;
    if (!hash_file(fd, e->size, e->file_hash) || !stable_chain(root, leaf, &chain)) goto out;
    /* NEW SecStaticCode objects, not cached metadata, after the full file read. */
    for (unsigned i = 0; i < e->count; i++) if (!check_signature(target, leaf, e, &e->slices[i], team, requirement) || !stable_chain(root, leaf, &chain)) goto out;
    okay = 1;
out:
    close_chain(&chain); return okay;
}
static void timeout_handler(int signal_number) { (void)signal_number; _exit(REFUSED); }
int main(int argc, char **argv) {
    (void)argv; struct stat in, out, err;
    if (argc != 1 || getuid() == 0 || getuid() != geteuid() || getgid() != getegid() || fstat(STDIN_FILENO, &in) || fstat(STDOUT_FILENO, &out) || fstat(STDERR_FILENO, &err) ||
        (!S_ISFIFO(in.st_mode) && !S_ISSOCK(in.st_mode)) || (!S_ISFIFO(out.st_mode) && !S_ISSOCK(out.st_mode)) ||
        (!S_ISFIFO(err.st_mode) && !S_ISSOCK(err.st_mode))) return REFUSED;
    signal(SIGPIPE, SIG_IGN); signal(SIGALRM, timeout_handler); alarm(110);
    uint8_t first[16], extra, *request = NULL; Entry *entries = NULL;
    SecRequirementRef requirement = NULL; CFStringRef requirement_string = NULL; int rootfd = -1, result = REFUSED;
    if (!exact_read(STDIN_FILENO, first, sizeof(first)) || memcmp(first, req_magic, 8)) goto done;
    size_t total = be32(first+12); if (total < 96 || total > MAX_REQUEST) goto done;
    request = calloc(1, total); entries = calloc(MAX_ENTRIES, sizeof(*entries)); if (!request || !entries) goto done;
    memcpy(request, first, sizeof(first));
    if (!exact_read(STDIN_FILENO, request+sizeof(first), total-sizeof(first)) || read(STDIN_FILENO, &extra, 1) != 0) goto done;
    char root[4097], team[11], canonical[PATH_MAX], requirement_text[512]; unsigned n = 0, slices = 0;
    if (!parse_entries(request, total, root, team, entries, &n, &slices) || !realpath(root, canonical) || strcmp(root, canonical)) goto done;
    rootfd = open(root, O_RDONLY | O_NOFOLLOW | O_DIRECTORY | O_CLOEXEC); if (rootfd < 0) goto done;
    int len = snprintf(requirement_text, sizeof(requirement_text),
        "anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = \"%s\"", team);
    if (len < 0 || (size_t)len >= sizeof(requirement_text)) goto done;
    requirement_string = CFStringCreateWithCString(NULL, requirement_text, kCFStringEncodingASCII); if (!requirement_string) goto done;
    if (SecRequirementCreateWithString(requirement_string, kSecCSDefaultFlags, &requirement) != errSecSuccess || !requirement) goto done;
    for (unsigned i = 0; i < n; i++) if (!verify_entry(rootfd, root, &entries[i], team, requirement)) goto done;
    uint8_t response[RESPONSE_SIZE] = {0}; memcpy(response, res_magic, 8); put16(response+8, 1); put16(response+10, RESPONSE_SIZE);
    put16(response+16, n); put16(response+18, slices);
    if (!CC_SHA256(request, (CC_LONG)total, response+24)) goto done;
    memcpy(response+56, request+32, 32);
    if (!exact_write(STDOUT_FILENO, response, sizeof(response))) goto done;
    result = 0;
done:
    if (rootfd >= 0) close(rootfd);
    if (requirement) CFRelease(requirement);
    if (requirement_string) CFRelease(requirement_string);
    free(entries); free(request); return result; /* no raw CF errors/paths/hashes logged */
}
