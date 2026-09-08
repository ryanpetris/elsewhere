#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

// Inject only writes to the fixture's explicitly selected loopback device.
ssize_t write(int fd, const void *data, size_t size) {
    static unsigned calls, successful;
    ssize_t (*real_write)(int, const void *, size_t) = dlsym(RTLD_NEXT, "write");
    char path[64], target[512];
    snprintf(path, sizeof(path), "/proc/self/fd/%d", fd);
    ssize_t length = readlink(path, target, sizeof(target) - 1);
    const char *device = getenv("ELSEWHERE_WEBCAM_TEST_DEVICE");
    if (length < 0 || !device) return real_write(fd, data, size);
    target[length] = 0;
    if (strcmp(target, device)) return real_write(fd, data, size);
    calls++;
    const char *failure = getenv("ELSEWHERE_WEBCAM_TEST_FAILURE");
    const char *arm = getenv("ELSEWHERE_WEBCAM_TEST_ARM");
    if (failure && successful >= 20 && (!arm || !access(arm, F_OK))) {
        errno = !strcmp(failure, "ENODEV") ? ENODEV : EIO;
        return -1;
    }
    if (!failure && calls % 3 != 0) { errno = EAGAIN; return -1; }
    ssize_t result = real_write(fd, data, size);
    if (result == (ssize_t)size) successful++;
    return result;
}
