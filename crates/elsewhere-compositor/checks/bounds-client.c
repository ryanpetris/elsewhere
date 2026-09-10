// Docker Wayland bounds fixture. Decoration requests arrive through a text file.
#define _GNU_SOURCE
#include <wayland-client.h>
#include "xdg-shell-client-protocol.h"
#include "xdg-decoration-client-protocol.h"
#include "server-decoration-client-protocol.h"
#include <sys/mman.h>
#include <unistd.h>
#include <poll.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static struct wl_display *display;
static struct wl_compositor *compositor;
static struct wl_shm *shm;
static struct xdg_wm_base *wm;
static struct zxdg_decoration_manager_v1 *manager;
static struct org_kde_kwin_server_decoration_manager *kde_manager;
static struct wl_surface *surface;
static struct xdg_toplevel *top;
static int width = 400, height = 300, bounds_w, bounds_h, mode, running = 1;

static void configure(void *data, struct xdg_surface *shell, uint32_t serial) {
    xdg_surface_ack_configure(shell, serial);
    printf("%d %d %d\n", bounds_w, bounds_h, mode); fflush(stdout);
    int fd = memfd_create("bounds-pixels", 0);
    if (fd < 0 || ftruncate(fd, width * height * 4)) exit(2);
    uint32_t *pixels = mmap(NULL, width * height * 4, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (pixels == MAP_FAILED) exit(2);
    for (int n = 0; n < width * height; n++) pixels[n] = 0xff204080;
    struct wl_shm_pool *pool = wl_shm_create_pool(shm, fd, width * height * 4);
    struct wl_buffer *buffer = wl_shm_pool_create_buffer(pool, 0, width, height, width * 4, WL_SHM_FORMAT_ARGB8888);
    wl_shm_pool_destroy(pool); munmap(pixels, width * height * 4); close(fd);
    wl_surface_attach(surface, buffer, 0, 0);
    wl_surface_damage(surface, 0, 0, width, height);
    wl_surface_commit(surface);
    // The bounded check keeps its buffers until display disconnect.
}
static const struct xdg_surface_listener shell_listener = { .configure = configure };
static void size(void *data, struct xdg_toplevel *t, int32_t w, int32_t h, struct wl_array *states) {
    if (w > 0) width = w;
    if (h > 0) height = h;
}
static void bounds(void *data, struct xdg_toplevel *t, int32_t w, int32_t h) { bounds_w = w; bounds_h = h; }
static void close_window(void *data, struct xdg_toplevel *t) { running = 0; }
static const struct xdg_toplevel_listener top_listener = { .configure = size, .close = close_window, .configure_bounds = bounds };
static void decoration_mode(void *data, struct zxdg_toplevel_decoration_v1 *d, uint32_t value) { mode = value; }
static const struct zxdg_toplevel_decoration_v1_listener decor_listener = { .configure = decoration_mode };
static void kde_mode(void *data, struct org_kde_kwin_server_decoration *d, uint32_t value) { mode = value == ORG_KDE_KWIN_SERVER_DECORATION_MODE_SERVER ? 2 : 1; }
static const struct org_kde_kwin_server_decoration_listener kde_listener = { .mode = kde_mode };
static void kde_default(void *data, struct org_kde_kwin_server_decoration_manager *m, uint32_t value) {}
static const struct org_kde_kwin_server_decoration_manager_listener kde_manager_listener = { .default_mode = kde_default };
static void ping(void *data, struct xdg_wm_base *base, uint32_t serial) { xdg_wm_base_pong(base, serial); }
static const struct xdg_wm_base_listener wm_listener = { .ping = ping };
static void global(void *data, struct wl_registry *r, uint32_t id, const char *name, uint32_t version) {
    if (!strcmp(name, "wl_compositor")) compositor = wl_registry_bind(r, id, &wl_compositor_interface, 1);
    if (!strcmp(name, "wl_shm")) shm = wl_registry_bind(r, id, &wl_shm_interface, 1);
    if (!strcmp(name, "xdg_wm_base") && version >= 4) wm = wl_registry_bind(r, id, &xdg_wm_base_interface, 4);
    if (!strcmp(name, "zxdg_decoration_manager_v1")) manager = wl_registry_bind(r, id, &zxdg_decoration_manager_v1_interface, 1);
    if (!strcmp(name, "org_kde_kwin_server_decoration_manager")) {
        kde_manager = wl_registry_bind(r, id, &org_kde_kwin_server_decoration_manager_interface, 1);
        org_kde_kwin_server_decoration_manager_add_listener(kde_manager, &kde_manager_listener, NULL);
    }
}
static void remove_global(void *data, struct wl_registry *r, uint32_t id) {}
static const struct wl_registry_listener registry_listener = { .global = global, .global_remove = remove_global };
int main(int argc, char **argv) {
    if (argc != 3 || !(display = wl_display_connect(NULL))) return 2;
    struct wl_registry *registry = wl_display_get_registry(display);
    wl_registry_add_listener(registry, &registry_listener, NULL);
    wl_display_roundtrip(display);
    if (!compositor || !shm || !wm || !manager || !kde_manager) return 2;
    xdg_wm_base_add_listener(wm, &wm_listener, NULL);
    surface = wl_compositor_create_surface(compositor);
    struct xdg_surface *shell = xdg_wm_base_get_xdg_surface(wm, surface);
    xdg_surface_add_listener(shell, &shell_listener, NULL);
    top = xdg_surface_get_toplevel(shell);
    xdg_toplevel_add_listener(top, &top_listener, NULL);
    xdg_toplevel_set_title(top, "bounds-fixture");
    struct zxdg_toplevel_decoration_v1 *decor = zxdg_decoration_manager_v1_get_toplevel_decoration(manager, top);
    zxdg_toplevel_decoration_v1_add_listener(decor, &decor_listener, NULL);
    if (!strcmp(argv[2], "client")) zxdg_toplevel_decoration_v1_set_mode(decor, ZXDG_TOPLEVEL_DECORATION_V1_MODE_CLIENT_SIDE);
    wl_surface_commit(surface);
    struct org_kde_kwin_server_decoration *kde = NULL;
    char previous[32] = "";
    while (running) {
        wl_display_dispatch_pending(display); wl_display_flush(display);
        struct pollfd fd = { .fd = wl_display_get_fd(display), .events = POLLIN };
        if (poll(&fd, 1, 20) > 0 && wl_display_dispatch(display) < 0) return 2;
        FILE *file = fopen(argv[1], "r"); char command[32] = "";
        if (file) { fgets(command, sizeof command, file); fclose(file); }
        if (!command[0] || !strcmp(previous, command)) continue;
        strcpy(previous, command);
        if (!strcmp(command, "client")) zxdg_toplevel_decoration_v1_set_mode(decor, ZXDG_TOPLEVEL_DECORATION_V1_MODE_CLIENT_SIDE);
        if (!strcmp(command, "server")) zxdg_toplevel_decoration_v1_set_mode(decor, ZXDG_TOPLEVEL_DECORATION_V1_MODE_SERVER_SIDE);
        if (!strcmp(command, "kde-client")) {
            kde = org_kde_kwin_server_decoration_manager_create(kde_manager, surface);
            org_kde_kwin_server_decoration_add_listener(kde, &kde_listener, NULL);
            org_kde_kwin_server_decoration_request_mode(kde, ORG_KDE_KWIN_SERVER_DECORATION_MODE_CLIENT);
        }
        if (!strcmp(command, "kde-release") && kde) { org_kde_kwin_server_decoration_release(kde); kde = NULL; mode = 2; }
        wl_surface_commit(surface);
    }
    wl_display_disconnect(display);
}
