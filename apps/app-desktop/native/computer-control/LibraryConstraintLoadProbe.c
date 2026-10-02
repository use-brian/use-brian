// Disposable opt-in library-load DIAGNOSTIC only. No production trust decision.
#if !defined(__APPLE__) || (!defined(__arm64__) && !defined(__x86_64__))
#error Real macOS SDK and native arm64/x86_64 required
#endif
#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <Security/SecTask.h>
#include <libproc.h>
#include <mach-o/loader.h>
#include <sys/stat.h>
#include <sys/resource.h>
#include <fcntl.h>
#include <dlfcn.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static uid_t owner;
static gid_t group;
static int directory_fd = -1;
static char directory[PROC_PIDPATHINFO_MAXSIZE];
static struct stat directory_stat;
struct artifact { int fd; struct stat st; char path[PROC_PIDPATHINFO_MAXSIZE]; };

static void deadline(int sig) { (void)sig; _exit(24); } // Never write to a blocked pipe.
static int emit(const char *result, int loaded, int matched, int code) {
    printf("{\"schema\":1,\"result\":\"%s\",\"loaded\":%s,\"functionMatched\":%s,\"productionAuthority\":false}\n",
           result, loaded ? "true" : "false", matched ? "true" : "false");
    return code;
}
static int credentials(void) {
    struct proc_bsdinfo b = {0};
    return owner != 0 && group != 0 && getuid() == owner && geteuid() == owner &&
        getgid() == group && getegid() == group &&
        proc_pidinfo(getpid(), PROC_PIDTBSDINFO, 0, &b, sizeof(b)) == (int)sizeof(b) &&
        b.pbi_pid == (uint32_t)getpid() && b.pbi_uid == owner && b.pbi_ruid == owner && b.pbi_svuid == owner &&
        b.pbi_gid == group && b.pbi_rgid == group && b.pbi_svgid == group;
}
static int same(const struct stat *a, const struct stat *b) {
    return a->st_dev == b->st_dev && a->st_ino == b->st_ino && a->st_size == b->st_size &&
        a->st_uid == b->st_uid && a->st_mode == b->st_mode && a->st_nlink == b->st_nlink &&
        a->st_mtimespec.tv_sec == b->st_mtimespec.tv_sec && a->st_mtimespec.tv_nsec == b->st_mtimespec.tv_nsec &&
        a->st_ctimespec.tv_sec == b->st_ctimespec.tv_sec && a->st_ctimespec.tv_nsec == b->st_ctimespec.tv_nsec;
}
static int directory_ok(void) {
    struct stat a, b;
    char canonical[PROC_PIDPATHINFO_MAXSIZE], fdpath[PROC_PIDPATHINFO_MAXSIZE];
    return credentials() && realpath(directory, canonical) && strcmp(canonical, directory) == 0 &&
        fcntl(directory_fd, F_GETPATH, fdpath) == 0 && strcmp(fdpath, directory) == 0 &&
        fstat(directory_fd, &a) == 0 && lstat(directory, &b) == 0 && S_ISDIR(b.st_mode) &&
        a.st_dev == directory_stat.st_dev && a.st_ino == directory_stat.st_ino &&
        b.st_dev == a.st_dev && b.st_ino == a.st_ino && b.st_uid == owner && a.st_uid == owner &&
        (a.st_mode & 07777) == 0700 && (b.st_mode & 07777) == 0700;
}
static int unchanged(const struct artifact *a) {
    struct stat fdstat, pathstat;
    return directory_ok() && fstat(a->fd, &fdstat) == 0 && lstat(a->path, &pathstat) == 0 &&
        same(&a->st, &fdstat) && same(&a->st, &pathstat);
}
static int directory_unchanged(const struct stat *before) {
    struct stat after;
    return directory_ok() && fstat(directory_fd, &after) == 0 && same(before, &after);
}
static int open_artifact(const char *fixed_name, mode_t mode, uint32_t filetype, struct artifact *a) {
    a->fd = -1;
    if (!directory_ok()) return 0;
    int n = snprintf(a->path, sizeof(a->path), "%s/%s", directory, fixed_name);
    if (n < 0 || (size_t)n >= sizeof(a->path)) return 0;
    a->fd = openat(directory_fd, fixed_name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
    if (a->fd < 0 || fstat(a->fd, &a->st) != 0 || !S_ISREG(a->st.st_mode) || a->st.st_uid != owner ||
        a->st.st_nlink != 1 || (a->st.st_mode & 07777) != mode || a->st.st_size < 32 || a->st.st_size > 8 * 1024 * 1024) return 0;
    struct mach_header_64 header;
    if (pread(a->fd, &header, sizeof(header), 0) != (ssize_t)sizeof(header) || header.magic != MH_MAGIC_64 || header.filetype != filetype) return 0;
#if defined(__arm64__)
    if (header.cputype != CPU_TYPE_ARM64 || header.cpusubtype != CPU_SUBTYPE_ARM64_ALL) return 0;
#else
    if (header.cputype != CPU_TYPE_X86_64 || header.cpusubtype != CPU_SUBTYPE_X86_64_ALL) return 0;
#endif
    return unchanged(a); // Thin files only: selected slice is exactly offset zero.
}
static int number_is(CFTypeRef value, int64_t expected) {
    int64_t number;
    return value && CFGetTypeID(value) == CFNumberGetTypeID() &&
        CFNumberGetValue(value, kCFNumberSInt64Type, &number) && number == expected;
}
static CFDataRef sha256_cdhash(const struct artifact *a, int runner) {
    CFDataRef result = NULL;
    int offset = 0;
    CFNumberRef zero = CFNumberCreate(NULL, kCFNumberIntType, &offset);
    const void *keys[] = {kSecCodeAttributeUniversalFileOffset}, *values[] = {zero};
    CFDictionaryRef attrs = zero ? CFDictionaryCreate(NULL, keys, values, 1, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks) : NULL;
    CFURLRef url = CFURLCreateFromFileSystemRepresentation(NULL, (const UInt8 *)a->path, strlen(a->path), false);
    SecStaticCodeRef code = NULL;
    CFDictionaryRef info = NULL;
    // Public metadata only, no CMS/chain authentication, certificates, keychain,
    // online flags or validity/trust evaluation. SHA256 cdhash is truncated to 20 bytes.
    if (unchanged(a) && attrs && url && SecStaticCodeCreateWithPathAndAttributes(url, kSecCSDefaultFlags, attrs, &code) == errSecSuccess &&
        SecCodeCopySigningInformation(code, kSecCSDefaultFlags, &info) == errSecSuccess && info) {
        CFTypeRef unique = CFDictionaryGetValue(info, kSecCodeInfoUnique);
        CFTypeRef hashes = CFDictionaryGetValue(info, kSecCodeInfoCdHashes);
        CFTypeRef algorithms = CFDictionaryGetValue(info, kSecCodeInfoDigestAlgorithms);
        if (number_is(CFDictionaryGetValue(info, kSecCodeInfoDigestAlgorithm), 2) &&
            number_is(CFDictionaryGetValue(info, kSecCodeInfoFlags), runner ? 0x10002 : 2) &&
            unique && CFGetTypeID(unique) == CFDataGetTypeID() && CFDataGetLength(unique) == 20 &&
            hashes && CFGetTypeID(hashes) == CFArrayGetTypeID() && CFArrayGetCount(hashes) == 1 &&
            algorithms && CFGetTypeID(algorithms) == CFArrayGetTypeID() && CFArrayGetCount(algorithms) == 1 &&
            number_is(CFArrayGetValueAtIndex(algorithms, 0), 2) && CFEqual(unique, CFArrayGetValueAtIndex(hashes, 0)) && unchanged(a))
            result = CFDataCreateCopy(NULL, unique);
    }
    if (info) CFRelease(info);
    if (code) CFRelease(code);
    if (url) CFRelease(url);
    if (attrs) CFRelease(attrs);
    if (zero) CFRelease(zero);
    return result;
}
static int disabled_legacy_validation(void) {
    SecTaskRef task = SecTaskCreateFromSelf(NULL);
    if (!task) return 0;
    CFTypeRef value = SecTaskCopyValueForEntitlement(task, CFSTR("com.apple.security.cs.disable-library-validation"), NULL);
    int ok = value && CFGetTypeID(value) == CFBooleanGetTypeID() && CFBooleanGetValue(value);
    if (value) CFRelease(value);
    CFRelease(task);
    return ok;
}
static int write_policy(CFDataRef allowed) {
    const void *items[] = {allowed};
    CFArrayRef list = CFArrayCreate(NULL, items, 1, &kCFTypeArrayCallBacks);
    const void *in_keys[] = {CFSTR("$in")}, *in_values[] = {list};
    CFDictionaryRef member = list ? CFDictionaryCreate(NULL, in_keys, in_values, 1, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks) : NULL;
    const void *keys[] = {CFSTR("cdhash")}, *values[] = {member};
    CFDictionaryRef policy = member ? CFDictionaryCreate(NULL, keys, values, 1, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks) : NULL;
    CFDataRef xml = policy ? CFPropertyListCreateData(NULL, policy, kCFPropertyListXMLFormat_v1_0, 0, NULL) : NULL;
    int ok = 0;
    if (xml && CFDataGetLength(xml) > 0 && CFDataGetLength(xml) < 4096 && directory_ok()) {
        int fd = openat(directory_fd, "allowed-policy.plist", O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
        if (fd >= 0) {
            struct stat a, b;
            ok = fstat(fd, &a) == 0 && S_ISREG(a.st_mode) && a.st_uid == owner && a.st_nlink == 1 &&
                write(fd, CFDataGetBytePtr(xml), (size_t)CFDataGetLength(xml)) == CFDataGetLength(xml) &&
                fchmod(fd, 0400) == 0 && fsync(fd) == 0 && fstat(fd, &a) == 0 &&
                fstatat(directory_fd, "allowed-policy.plist", &b, AT_SYMLINK_NOFOLLOW) == 0 && same(&a, &b) && directory_ok();
            if (close(fd) != 0) ok = 0;
        }
    }
    if (xml) CFRelease(xml);
    if (policy) CFRelease(policy);
    if (member) CFRelease(member);
    if (list) CFRelease(list);
    return ok;
}
int main(int argc, char **argv) {
    struct sigaction action = {0}; action.sa_handler = deadline; sigemptyset(&action.sa_mask);
    sigset_t unblock; sigemptyset(&unblock); sigaddset(&unblock, SIGALRM);
    if (sigaction(SIGALRM, &action, NULL) != 0 || sigprocmask(SIG_UNBLOCK, &unblock, NULL) != 0) _exit(24);
    alarm(5); // One invocation; includes setup, metadata, dlopen and blocked output.
    struct rlimit core = {0, 0};
    if (setrlimit(RLIMIT_CORE, &core) != 0) return emit("invalid", 0, 0, 2);
    if (argc != 2 || (strcmp(argv[1], "prepare-policy") && strcmp(argv[1], "load-allowed") && strcmp(argv[1], "load-disallowed")))
        return emit("invalid", 0, 0, 2);
    owner = getuid(); group = getgid(); umask(0077);
    if (!credentials()) return emit("invalid", 0, 0, 2);
    char self[PROC_PIDPATHINFO_MAXSIZE] = {0}, canonical[PROC_PIDPATHINFO_MAXSIZE];
    if (proc_pidpath(getpid(), self, sizeof(self)) <= 0 || !memchr(self, 0, sizeof(self)) || !realpath(self, canonical) || strcmp(self, canonical))
        return emit("invalid", 0, 0, 2);
    char *name = strrchr(self, '/');
    if (!name || (strcmp(name + 1, "baseline-runner") && strcmp(name + 1, "constrained-runner"))) return emit("invalid", 0, 0, 2);
    const char *runner_name = !strcmp(name + 1, "baseline-runner") ? "baseline-runner" : "constrained-runner";
    *name = 0;
    if (strlen(self) >= sizeof(directory)) return emit("invalid", 0, 0, 2);
    strcpy(directory, self);
    directory_fd = open(directory, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (directory_fd < 0 || fstat(directory_fd, &directory_stat) != 0 || !directory_ok()) return emit("invalid", 0, 0, 2);
    struct artifact runner = {.fd = -1}, allowed = {.fd = -1}, disallowed = {.fd = -1};
    if (!open_artifact(runner_name, 0500, MH_EXECUTE, &runner) || !open_artifact("allowed.dylib", 0400, MH_DYLIB, &allowed) ||
        !open_artifact("disallowed.dylib", 0400, MH_DYLIB, &disallowed) || !disabled_legacy_validation()) return emit("invalid", 0, 0, 2);
    CFDataRef own_hash = sha256_cdhash(&runner, 1), allow_hash = sha256_cdhash(&allowed, 0), deny_hash = sha256_cdhash(&disallowed, 0);
    if (!own_hash || !allow_hash || !deny_hash || CFEqual(allow_hash, deny_hash)) return emit("invalid", 0, 0, 2);
    if (!strcmp(argv[1], "prepare-policy")) {
        int ok = !strcmp(runner_name, "baseline-runner") && write_policy(allow_hash) &&
            unchanged(&runner) && unchanged(&allowed) && unchanged(&disallowed);
        return emit(ok ? "policy-created" : "invalid", 0, 0, ok ? 0 : 2);
    }
    CFRelease(own_hash); CFRelease(allow_hash); CFRelease(deny_hash);
    const struct artifact *target = !strcmp(argv[1], "load-allowed") ? &allowed : &disallowed;
    int expected = target == &allowed ? 211 : 307;
    if (!unchanged(&runner) || !unchanged(&allowed) || !unchanged(&disallowed)) return emit("invalid", 0, 0, 2);
    struct stat load_directory;
    if (fstat(directory_fd, &load_directory) != 0) return emit("invalid", 0, 0, 2);
    void *handle = dlopen(target->path, RTLD_NOW | RTLD_LOCAL);
    // No dlerror(): raw paths/hashes/rejection text must not reach stdout.
    if (!unchanged(&runner) || !unchanged(&allowed) || !unchanged(&disallowed)) return emit("invalid", 0, 0, 2);
    if (!directory_unchanged(&load_directory)) return emit("invalid", 0, 0, 2);
    if (!handle) return emit("dlopen-null", 0, 0, 0); // An observation, NOT proof of the rejection's cause.
    int (*function)(void) = (int (*)(void))dlsym(handle, "brian_library_load_value");
    if (!function || function() != expected) return emit("symbol-mismatch", 1, 0, 2);
    if (dlclose(handle) != 0 || !directory_unchanged(&load_directory) || !unchanged(&runner) || !unchanged(&allowed) || !unchanged(&disallowed)) return emit("invalid", 0, 0, 2);
    return emit("loaded", 1, 1, 0);
}
