// Self-only primitive-availability probe. Never an admission/authority check.
#if !defined(__APPLE__) || (!defined(__arm64__) && !defined(__x86_64__))
#error This probe requires a real macOS SDK and arm64 or x86_64.
#endif
#include "ProcessIdentity.h"
#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <libproc.h>
#include <mach-o/loader.h>
#include <mach-o/fat.h>
#include <libkern/OSByteOrder.h>
#include <fcntl.h>
#include <limits.h>
#include <signal.h>
#include <stdio.h>
#include <stdbool.h>
#include <string.h>
#include <unistd.h>

static void expired(int signal_number) {
    (void)signal_number;
    // Do not write here: even a fixed diagnostic can block on a full stdout pipe.
    // Exit status 24 is the deadline report, including blocked output.
    _exit(24);
}

static int report(int code, int data, int match, int untrusted) {
    // Only fixed booleans/status codes. No OS error strings or identity material.
    printf("{\"code\":%d,\"kernel_data\":%s,\"static_match\":%s,\"untrusted_status\":%s,\"production_authority\":false}\n",
           code, data ? "true" : "false", match ? "true" : "false", untrusted ? "true" : "false");
    return code;
}

static int has_data(brian_kernel_snapshot_result result) {
    return result == BRIAN_KERNEL_UNVERIFIED_DATA || result == BRIAN_KERNEL_UNTRUSTED_DATA;
}

static int same_data(const brian_kernel_signing_data *a, const brian_kernel_signing_data *b) {
    return a->pid == b->pid && a->user == b->user && a->unique_id == b->unique_id &&
        a->parent_unique_id == b->parent_unique_id && a->exec_idversion == b->exec_idversion &&
        a->signing_status == b->signing_status && a->slice_offset == b->slice_offset &&
        memcmp(a->executable_uuid, b->executable_uuid, 16) == 0 && memcmp(a->main_cdhash, b->main_cdhash, 20) == 0;
}

// Bound the ordinary self executable to 64 MiB and select ONLY the kernel's
// actual slice. The public Security offset attribute uses an int in the pinned
// implementation, so offsets above INT_MAX are deliberately unsupported.
static int actual_slice(int fd, off_t file_size, int64_t selected) {
    if (file_size < (off_t)sizeof(struct mach_header_64) || file_size > 64 * 1024 * 1024 ||
        selected < 0 || selected > INT_MAX || selected > file_size - (off_t)sizeof(struct mach_header_64)) return 0;
    struct mach_header_64 header;
    if (pread(fd, &header, sizeof(header), selected) != (ssize_t)sizeof(header) ||
        header.magic != MH_MAGIC_64 || header.filetype != MH_EXECUTE) return 0;
#if defined(__arm64__)
    if (header.cputype != CPU_TYPE_ARM64) return 0;
#else
    if (header.cputype != CPU_TYPE_X86_64) return 0;
#endif
    struct fat_header fat;
    if (pread(fd, &fat, sizeof(fat), 0) != (ssize_t)sizeof(fat)) return 0;
    uint32_t magic = OSSwapBigToHostInt32(fat.magic);
    if (selected == 0) return magic != FAT_MAGIC && magic != FAT_MAGIC_64;
    if (magic != FAT_MAGIC && magic != FAT_MAGIC_64) return 0;
    uint32_t count = OSSwapBigToHostInt32(fat.nfat_arch);
    if (count < 1 || count > 2) return 0;
    uint64_t offsets[2] = {0}, sizes[2] = {0};
    uint32_t cpus[2] = {0};
    unsigned int matched = 0;
    size_t stride = magic == FAT_MAGIC ? sizeof(struct fat_arch) : sizeof(struct fat_arch_64);
    for (uint32_t i = 0; i < count; ++i) {
        uint32_t cpu, subtype, alignment;
        if (magic == FAT_MAGIC) {
            struct fat_arch arch;
            if (pread(fd, &arch, sizeof(arch), (off_t)(sizeof(fat) + i * stride)) != (ssize_t)sizeof(arch)) return 0;
            cpu = OSSwapBigToHostInt32(arch.cputype); subtype = OSSwapBigToHostInt32(arch.cpusubtype);
            offsets[i] = OSSwapBigToHostInt32(arch.offset); sizes[i] = OSSwapBigToHostInt32(arch.size);
            alignment = OSSwapBigToHostInt32(arch.align);
        } else {
            struct fat_arch_64 arch;
            if (pread(fd, &arch, sizeof(arch), (off_t)(sizeof(fat) + i * stride)) != (ssize_t)sizeof(arch) || arch.reserved != 0) return 0;
            cpu = OSSwapBigToHostInt32(arch.cputype); subtype = OSSwapBigToHostInt32(arch.cpusubtype);
            offsets[i] = OSSwapBigToHostInt64(arch.offset); sizes[i] = OSSwapBigToHostInt64(arch.size);
            alignment = OSSwapBigToHostInt32(arch.align);
        }
        cpus[i] = cpu;
        if ((cpu != CPU_TYPE_ARM64 && cpu != CPU_TYPE_X86_64) || (i && cpu == cpus[0]) ||
            offsets[i] < sizeof(fat) + count * stride || offsets[i] > (uint64_t)file_size ||
            sizes[i] < sizeof(header) || sizes[i] > (uint64_t)file_size - offsets[i] ||
            alignment > 30 || offsets[i] % (1ULL << alignment) != 0) return 0;
        if (offsets[i] == (uint64_t)selected) {
            if (cpu != (uint32_t)header.cputype || subtype != (uint32_t)header.cpusubtype) return 0;
            ++matched;
        }
    }
    if (count == 2 && offsets[0] < offsets[1] + sizes[1] && offsets[1] < offsets[0] + sizes[0]) return 0;
    return matched == 1;
}

static int static_match(const char *path, const brian_kernel_signing_data *data) {
    CFURLRef url = CFURLCreateFromFileSystemRepresentation(kCFAllocatorDefault, (const UInt8 *)path, (CFIndex)strlen(path), false);
    int offset = (int)data->slice_offset; // actual_slice already bounded this.
    CFNumberRef number = CFNumberCreate(kCFAllocatorDefault, kCFNumberIntType, &offset);
    const void *keys[] = {kSecCodeAttributeUniversalFileOffset}, *values[] = {number};
    CFDictionaryRef attributes = number ? CFDictionaryCreate(kCFAllocatorDefault, keys, values, 1,
        &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks) : NULL;
    SecStaticCodeRef code = NULL;
    CFDictionaryRef information = NULL;
    int result = 20;
    // Metadata extraction only: no CheckValidity, trust evaluation, online flags,
    // certificates, keychain lookups, dynamic guests or CMS validation.
    if (url && attributes && SecStaticCodeCreateWithPathAndAttributes(url, kSecCSDefaultFlags, attributes, &code) == errSecSuccess &&
        SecCodeCopySigningInformation(code, kSecCSDefaultFlags, &information) == errSecSuccess && information &&
        CFGetTypeID(information) == CFDictionaryGetTypeID()) {
        CFTypeRef hashes = CFDictionaryGetValue(information, kSecCodeInfoCdHashes);
        CFTypeRef unique = CFDictionaryGetValue(information, kSecCodeInfoUnique);
        if (hashes && CFGetTypeID(hashes) == CFArrayGetTypeID() && CFArrayGetCount(hashes) > 0 && CFArrayGetCount(hashes) <= 8 &&
            unique && CFGetTypeID(unique) == CFDataGetTypeID() && CFDataGetLength(unique) == 20) {
            int matched = 0, includes_unique = 0, valid = 1;
            for (CFIndex i = 0; i < CFArrayGetCount(hashes); ++i) {
                CFTypeRef hash = CFArrayGetValueAtIndex(hashes, i);
                if (!hash || CFGetTypeID(hash) != CFDataGetTypeID() || CFDataGetLength(hash) != 20) { valid = 0; break; }
                if (memcmp(CFDataGetBytePtr(hash), data->main_cdhash, 20) == 0) matched = 1;
                if (CFEqual(hash, unique)) includes_unique = 1;
            }
            // Alternatives are digest algorithms for THIS slice, not the other
            // universal architecture. Never search an all-architectures union.
            result = valid && includes_unique ? (matched ? 0 : 22) : 20;
        }
    }
    if (information) CFRelease(information);
    if (code) CFRelease(code);
    if (attributes) CFRelease(attributes);
    if (number) CFRelease(number);
    if (url) CFRelease(url);
    return result;
}

int main(int argc, char **argv) {
    (void)argv;
    struct sigaction action = {0};
    action.sa_handler = expired;
    sigemptyset(&action.sa_mask);
    if (sigaction(SIGALRM, &action, NULL) != 0) _exit(24);
    sigset_t unblock;
    sigemptyset(&unblock);
    sigaddset(&unblock, SIGALRM);
    if (sigprocmask(SIG_UNBLOCK, &unblock, NULL) != 0) _exit(24);
    alarm(3); // Process-wide watchdog; never retries or spawns another process.
    if (argc != 1) return report(64, 0, 0, 0);
    brian_kernel_signing_data before, after;
    brian_kernel_snapshot_result first = brian_kernel_signing_snapshot(getpid(), getuid(), &before);
    if (!has_data(first)) return report(first, 0, 0, 0);
    int untrusted = first == BRIAN_KERNEL_UNTRUSTED_DATA;
    char path[PROC_PIDPATHINFO_MAXSIZE] = {0}, confirmed[PROC_PIDPATHINFO_MAXSIZE] = {0};
    if (proc_pidpath(getpid(), path, sizeof(path)) <= 0 || path[0] != '/' || !memchr(path, 0, sizeof(path))) return report(21, 1, 0, untrusted);
    int fd = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    struct stat initial, final, current;
    if (fd < 0) return report(21, 1, 0, untrusted);
    if (fstat(fd, &initial) != 0 || !S_ISREG(initial.st_mode) || !actual_slice(fd, initial.st_size, before.slice_offset)) {
        close(fd); return report(21, 1, 0, untrusted);
    }
    int result = static_match(path, &before);
    if (fstat(fd, &final) != 0 || lstat(path, &current) != 0 || current.st_dev != initial.st_dev || current.st_ino != initial.st_ino ||
        current.st_size != initial.st_size || final.st_size != initial.st_size ||
        memcmp(&initial.st_mtimespec, &final.st_mtimespec, sizeof(initial.st_mtimespec)) != 0 ||
        memcmp(&initial.st_ctimespec, &final.st_ctimespec, sizeof(initial.st_ctimespec)) != 0) result = 23;
    close(fd);
    brian_kernel_snapshot_result last = brian_kernel_signing_snapshot(getpid(), getuid(), &after);
    if (!has_data(last) || first != last || !same_data(&before, &after) ||
        proc_pidpath(getpid(), confirmed, sizeof(confirmed)) <= 0 || !memchr(confirmed, 0, sizeof(confirmed)) || strcmp(path, confirmed) != 0) result = 23;
    // Stable fstat/path checks are just diagnostics, not an atomic file snapshot
    // or a solution to restored-on-disk/in-place-write attacks.
    return report(result, 1, result == 0, untrusted);
}
