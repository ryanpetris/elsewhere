// Read-only glibc allocator sampling for viewer-lifecycle.mjs --allocator.
#define _GNU_SOURCE
#include <malloc.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
#include <unistd.h>
#include <fcntl.h>
static int output;
static void *observe(void *unused) {
    (void)unused;
    for (;;) {
        struct mallinfo2 m = mallinfo2();
        struct timespec now; clock_gettime(CLOCK_REALTIME, &now);
        char text[512];
        int size = snprintf(text, sizeof(text), "{\"time\":%ld.%03ld,\"arena\":%zu,\"allocated\":%zu,\"free\":%zu,\"mmap\":%zu,\"mmap_count\":%zu}\n", now.tv_sec, now.tv_nsec / 1000000, m.arena, m.uordblks, m.fordblks, m.hblkhd, m.hblks);
        if (size > 0) write(output, text, (size_t)size);
        sleep(1);
    }
    return NULL;
}
__attribute__((constructor)) static void start(void) {
    const char *path = getenv("ELSEWHERE_ALLOC_LOG");
    if (!path) return;
    output = open(path, O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC, 0600);
    unsetenv("ELSEWHERE_ALLOC_LOG");
    if (output < 0) return;
    pthread_t thread;
    if (pthread_create(&thread, NULL, observe, NULL) == 0) pthread_detach(thread);
}
