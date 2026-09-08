// A real Wayland selection owner for the Docker clipboard check. Commands: sequence, mode.
#define _GNU_SOURCE
#include <wayland-client.h>
#include "xdg-shell-client-protocol.h"
#include <sys/mman.h>
#include <unistd.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static struct wl_display *display;
static struct wl_compositor *compositor;
static struct wl_shm *shm;
static struct wl_seat *seat;
static struct wl_keyboard *keyboard;
static struct wl_data_device_manager *manager;
static struct wl_data_device *device;
static struct xdg_wm_base *wm;
static struct wl_surface *surface;
static uint32_t input_serial;
static const char *payload;
static int stalled[32], stalled_count, running = 1;
struct source { struct wl_data_source *source; char mode[32]; };
static struct source *current;

static void send_payload(int fd) {
    FILE *file = fopen(payload, "rb");
    char bytes[8192]; size_t n;
    if (file) {
        while ((n = fread(bytes, 1, sizeof bytes, file)) > 0) {
            size_t offset = 0;
            while (offset < n) { ssize_t written = write(fd, bytes + offset, n - offset); if (written <= 0) goto done; offset += written; }
        }
done:   fclose(file);
    }
    close(fd);
}
static void source_target(void *data, struct wl_data_source *source, const char *mime) {}
static void source_send(void *data, struct wl_data_source *source, const char *mime, int32_t fd) {
    struct source *owner = data;
    if (!strcmp(owner->mode, "slow")) { if (stalled_count == 32) exit(2); stalled[stalled_count++] = fd; }
    else if (!strcmp(owner->mode, "empty")) close(fd);
    else send_payload(fd);
}
static void source_cancelled(void *data, struct wl_data_source *source) { if (current == data) current = NULL; wl_data_source_destroy(source); free(data); }
static const struct wl_data_source_listener source_listener = { .target = source_target, .send = source_send, .cancelled = source_cancelled };
static void offer_mime(void *data, struct wl_data_offer *offer, const char *mime) {}
static const struct wl_data_offer_listener offer_listener = { .offer = offer_mime };
static void data_offer(void *data, struct wl_data_device *device, struct wl_data_offer *offer) { wl_data_offer_add_listener(offer, &offer_listener, NULL); }
static void selection(void *data, struct wl_data_device *device, struct wl_data_offer *offer) { if (offer) wl_data_offer_destroy(offer); }
static const struct wl_data_device_listener device_listener = { .data_offer = data_offer, .selection = selection };
static void keymap(void *data, struct wl_keyboard *keyboard, uint32_t format, int32_t fd, uint32_t size) { close(fd); }
static void enter(void *data, struct wl_keyboard *keyboard, uint32_t serial, struct wl_surface *surface, struct wl_array *keys) { input_serial = serial; }
static void leave(void *data, struct wl_keyboard *keyboard, uint32_t serial, struct wl_surface *surface) {}
static void key(void *data, struct wl_keyboard *keyboard, uint32_t serial, uint32_t time, uint32_t key, uint32_t state) { input_serial = serial; }
static void modifiers(void *data, struct wl_keyboard *keyboard, uint32_t serial, uint32_t depressed, uint32_t latched, uint32_t locked, uint32_t group) {}
static const struct wl_keyboard_listener keyboard_listener = { .keymap = keymap, .enter = enter, .leave = leave, .key = key, .modifiers = modifiers };
static void capabilities(void *data, struct wl_seat *seat, uint32_t capabilities) {
    if ((capabilities & WL_SEAT_CAPABILITY_KEYBOARD) && !keyboard) { keyboard = wl_seat_get_keyboard(seat); wl_keyboard_add_listener(keyboard, &keyboard_listener, NULL); }
}
static const struct wl_seat_listener seat_listener = { .capabilities = capabilities };
static void ping(void *data, struct xdg_wm_base *base, uint32_t serial) { xdg_wm_base_pong(base, serial); }
static const struct xdg_wm_base_listener wm_listener = { .ping = ping };
static void configure(void *data, struct xdg_surface *shell, uint32_t serial) {
    xdg_surface_ack_configure(shell, serial);
    int fd = memfd_create("clipboard-source", 0);
    if (fd < 0 || ftruncate(fd, 64 * 64 * 4)) exit(2);
    uint32_t *pixels = mmap(NULL, 64 * 64 * 4, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (pixels == MAP_FAILED) exit(2);
    for (int i = 0; i < 64 * 64; i++) pixels[i] = 0xff202040;
    struct wl_shm_pool *pool = wl_shm_create_pool(shm, fd, 64 * 64 * 4);
    struct wl_buffer *buffer = wl_shm_pool_create_buffer(pool, 0, 64, 64, 64 * 4, WL_SHM_FORMAT_ARGB8888);
    wl_shm_pool_destroy(pool); munmap(pixels, 64 * 64 * 4); close(fd);
    wl_surface_attach(surface, buffer, 0, 0); wl_surface_damage(surface, 0, 0, 64, 64); wl_surface_commit(surface);
}
static const struct xdg_surface_listener shell_listener = { .configure = configure };
static void size(void *data, struct xdg_toplevel *top, int32_t w, int32_t h, struct wl_array *states) {}
static void close_window(void *data, struct xdg_toplevel *top) { running = 0; }
static const struct xdg_toplevel_listener top_listener = { .configure = size, .close = close_window };
static void global(void *data, struct wl_registry *registry, uint32_t id, const char *name, uint32_t version) {
    if (!strcmp(name, "wl_compositor")) compositor = wl_registry_bind(registry, id, &wl_compositor_interface, 1);
    if (!strcmp(name, "wl_shm")) shm = wl_registry_bind(registry, id, &wl_shm_interface, 1);
    if (!strcmp(name, "wl_seat")) { seat = wl_registry_bind(registry, id, &wl_seat_interface, 1); wl_seat_add_listener(seat, &seat_listener, NULL); }
    if (!strcmp(name, "wl_data_device_manager")) manager = wl_registry_bind(registry, id, &wl_data_device_manager_interface, 1);
    if (!strcmp(name, "xdg_wm_base")) wm = wl_registry_bind(registry, id, &xdg_wm_base_interface, 1);
}
static void removed(void *data, struct wl_registry *registry, uint32_t id) {}
static const struct wl_registry_listener registry_listener = { .global = global, .global_remove = removed };
int main(int argc, char **argv) {
    if (argc != 3 || !(display = wl_display_connect(NULL))) return 2;
    signal(SIGPIPE, SIG_IGN); payload = argv[2];
    struct wl_registry *registry = wl_display_get_registry(display);
    wl_registry_add_listener(registry, &registry_listener, NULL); wl_display_roundtrip(display);
    if (!compositor || !shm || !seat || !manager || !wm) return 2;
    device = wl_data_device_manager_get_data_device(manager, seat); wl_data_device_add_listener(device, &device_listener, NULL);
    xdg_wm_base_add_listener(wm, &wm_listener, NULL);
    surface = wl_compositor_create_surface(compositor);
    struct xdg_surface *shell = xdg_wm_base_get_xdg_surface(wm, surface); xdg_surface_add_listener(shell, &shell_listener, NULL);
    struct xdg_toplevel *top = xdg_surface_get_toplevel(shell); xdg_toplevel_add_listener(top, &top_listener, NULL);
    xdg_toplevel_set_app_id(top, "clipboard-source"); xdg_toplevel_set_title(top, "Clipboard source"); wl_surface_commit(surface);
    unsigned previous = 0;
    while (running) {
        wl_display_dispatch_pending(display); wl_display_flush(display);
        struct pollfd fd = { .fd = wl_display_get_fd(display), .events = POLLIN };
        if (poll(&fd, 1, 20) > 0 && wl_display_dispatch(display) < 0) break;
        FILE *file = fopen(argv[1], "r"); unsigned sequence = 0; char mode[32] = "";
        if (file) { fscanf(file, "%u %31s", &sequence, mode); fclose(file); }
        if (!input_serial || !sequence || sequence == previous) continue;
        previous = sequence;
        if (!strcmp(mode, "flush")) { while (stalled_count) send_payload(stalled[--stalled_count]); continue; }
        if (!strcmp(mode, "clear")) { wl_data_device_set_selection(device, NULL, input_serial); continue; }
        if (!strcmp(mode, "destroy")) { if (current) source_cancelled(current, current->source); continue; }
        struct source *owner = calloc(1, sizeof *owner); strcpy(owner->mode, mode);
        owner->source = wl_data_device_manager_create_data_source(manager);
        wl_data_source_add_listener(owner->source, &source_listener, owner);
        const char *mime = !strcmp(mode, "unsupported") ? "application/clipboard-check" : !strcmp(mode, "png") ? "image/png" : !strcmp(mode, "files") ? "text/uri-list" : "text/plain;charset=utf-8";
        if (strcmp(mode, "nomime")) wl_data_source_offer(owner->source, mime);
        wl_data_device_set_selection(device, owner->source, input_serial);
        current = owner;
    }
    while (stalled_count) close(stalled[--stalled_count]);
    wl_display_disconnect(display);
    return 0;
}
