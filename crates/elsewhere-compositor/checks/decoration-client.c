// Wayland decoration negotiation, geometry and pointer observations for the Docker check.
#define _GNU_SOURCE
#include <wayland-client.h>
#include <sys/mman.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include "xdg-shell-client.h"
#include "xdg-decoration-client.h"
#include "kde-decoration-client.h"

static struct wl_display *display;
static struct wl_compositor *compositor;
static struct wl_shm *shm;
static struct wl_surface *surface;
static struct xdg_wm_base *shell;
static struct xdg_surface *shell_surface;
static struct xdg_toplevel *toplevel;
static struct zxdg_decoration_manager_v1 *xdg_manager;
static struct zxdg_toplevel_decoration_v1 *xdg_decoration;
static struct org_kde_kwin_server_decoration_manager *kde_manager;
static struct org_kde_kwin_server_decoration *kde_decoration;
static int width = 320, height = 180, running = 1, sequence, configures, xdg_mode, kde_mode, default_mode, clicks;
static int pointer_x, pointer_y, click_x, click_y;
struct pixels { void *map; size_t size; };

static void released(void *data, struct wl_buffer *buffer) {
    struct pixels *p = data;
    munmap(p->map, p->size); free(p); wl_buffer_destroy(buffer);
}
static const struct wl_buffer_listener buffer_listener = { .release = released };
static void paint(void) {
    char name[] = "/tmp/elsewhere-decoration-pixels-XXXXXX";
    int fd = mkstemp(name); unlink(name);
    size_t bytes = (size_t)width * height * 4;
    if (fd < 0 || ftruncate(fd, bytes)) exit(2);
    struct pixels *p = calloc(1, sizeof *p);
    p->size = bytes; p->map = mmap(NULL, bytes, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (p->map == MAP_FAILED) exit(2);
    for (size_t i = 0; i < bytes / 4; i++) ((uint32_t *)p->map)[i] = 0xffe52a61;
    struct wl_shm_pool *pool = wl_shm_create_pool(shm, fd, bytes);
    struct wl_buffer *buffer = wl_shm_pool_create_buffer(pool, 0, width, height, width * 4, WL_SHM_FORMAT_XRGB8888);
    wl_buffer_add_listener(buffer, &buffer_listener, p);
    wl_shm_pool_destroy(pool); close(fd);
    wl_surface_attach(surface, buffer, 0, 0);
    wl_surface_damage(surface, 0, 0, width, height);
    wl_surface_commit(surface);
}
static void configured(void *data, struct xdg_surface *s, uint32_t serial) {
    (void)data; xdg_surface_ack_configure(s, serial); configures++; paint();
}
static const struct xdg_surface_listener surface_listener = { .configure = configured };
static void sized(void *data, struct xdg_toplevel *t, int32_t w, int32_t h, struct wl_array *states) {
    (void)data; (void)t; (void)states;
    if (w > 0) width = w;
    if (h > 0) height = h;
}
static void closed(void *data, struct xdg_toplevel *t) { (void)data; (void)t; running = 0; }
static const struct xdg_toplevel_listener toplevel_listener = { .configure = sized, .close = closed };
static void ping(void *data, struct xdg_wm_base *s, uint32_t serial) { (void)data; xdg_wm_base_pong(s, serial); }
static const struct xdg_wm_base_listener shell_listener = { .ping = ping };
static void xdg_configured(void *data, struct zxdg_toplevel_decoration_v1 *d, uint32_t mode) { (void)data; (void)d; xdg_mode = mode; }
static const struct zxdg_toplevel_decoration_v1_listener xdg_listener = { .configure = xdg_configured };
static void kde_configured(void *data, struct org_kde_kwin_server_decoration *d, uint32_t mode) { (void)data; (void)d; kde_mode = mode; }
static const struct org_kde_kwin_server_decoration_listener kde_listener = { .mode = kde_configured };
static void kde_default(void *data, struct org_kde_kwin_server_decoration_manager *m, uint32_t mode) { (void)data; (void)m; default_mode = mode; }
static const struct org_kde_kwin_server_decoration_manager_listener kde_manager_listener = { .default_mode = kde_default };
static void make_xdg(void) {
    xdg_decoration = zxdg_decoration_manager_v1_get_toplevel_decoration(xdg_manager, toplevel);
    zxdg_toplevel_decoration_v1_add_listener(xdg_decoration, &xdg_listener, NULL);
}
static void make_kde(void) {
    kde_decoration = org_kde_kwin_server_decoration_manager_create(kde_manager, surface);
    org_kde_kwin_server_decoration_add_listener(kde_decoration, &kde_listener, NULL);
}
static void entered(void *d, struct wl_pointer *p, uint32_t serial, struct wl_surface *s, wl_fixed_t x, wl_fixed_t y) {
    (void)d; (void)p; (void)serial; (void)s; pointer_x = wl_fixed_to_int(x); pointer_y = wl_fixed_to_int(y);
}
static void left(void *d, struct wl_pointer *p, uint32_t serial, struct wl_surface *s) { (void)d; (void)p; (void)serial; (void)s; }
static void moved(void *d, struct wl_pointer *p, uint32_t time, wl_fixed_t x, wl_fixed_t y) {
    (void)d; (void)p; (void)time; pointer_x = wl_fixed_to_int(x); pointer_y = wl_fixed_to_int(y);
}
static void button(void *d, struct wl_pointer *p, uint32_t serial, uint32_t time, uint32_t code, uint32_t state) {
    (void)d; (void)p; (void)serial; (void)time; (void)code;
    if (state == WL_POINTER_BUTTON_STATE_PRESSED) { clicks++; click_x = pointer_x; click_y = pointer_y; }
}
static void axis(void *d, struct wl_pointer *p, uint32_t time, uint32_t axis, wl_fixed_t value) { (void)d; (void)p; (void)time; (void)axis; (void)value; }
static const struct wl_pointer_listener pointer_listener = { .enter = entered, .leave = left, .motion = moved, .button = button, .axis = axis };
static void capabilities(void *d, struct wl_seat *seat, uint32_t caps) {
    (void)d;
    if (caps & WL_SEAT_CAPABILITY_POINTER) wl_pointer_add_listener(wl_seat_get_pointer(seat), &pointer_listener, NULL);
}
static const struct wl_seat_listener seat_listener = { .capabilities = capabilities };
static void global(void *d, struct wl_registry *r, uint32_t id, const char *name, uint32_t version) {
    (void)d; (void)version;
    if (!strcmp(name, "wl_compositor")) compositor = wl_registry_bind(r, id, &wl_compositor_interface, 4);
    if (!strcmp(name, "wl_shm")) shm = wl_registry_bind(r, id, &wl_shm_interface, 1);
    if (!strcmp(name, "xdg_wm_base")) { shell = wl_registry_bind(r, id, &xdg_wm_base_interface, 1); xdg_wm_base_add_listener(shell, &shell_listener, NULL); }
    if (!strcmp(name, "zxdg_decoration_manager_v1")) xdg_manager = wl_registry_bind(r, id, &zxdg_decoration_manager_v1_interface, 1);
    if (!strcmp(name, "org_kde_kwin_server_decoration_manager")) { kde_manager = wl_registry_bind(r, id, &org_kde_kwin_server_decoration_manager_interface, 1); org_kde_kwin_server_decoration_manager_add_listener(kde_manager, &kde_manager_listener, NULL); }
    // Version 1 has the five pointer events handled above.
    if (!strcmp(name, "wl_seat")) wl_seat_add_listener(wl_registry_bind(r, id, &wl_seat_interface, 1), &seat_listener, NULL);
}
static void removed(void *d, struct wl_registry *r, uint32_t id) { (void)d; (void)r; (void)id; }
static const struct wl_registry_listener registry_listener = { .global = global, .global_remove = removed };

int main(int argc, char **argv) {
    if (argc != 4) return 1;
    display = wl_display_connect(NULL);
    if (!display) return 2;
    wl_registry_add_listener(wl_display_get_registry(display), &registry_listener, NULL);
    if (wl_display_roundtrip(display) < 0 || !compositor || !shm || !shell || !xdg_manager || !kde_manager) return 2;
    surface = wl_compositor_create_surface(compositor);
    shell_surface = xdg_wm_base_get_xdg_surface(shell, surface);
    xdg_surface_add_listener(shell_surface, &surface_listener, NULL);
    toplevel = xdg_surface_get_toplevel(shell_surface);
    xdg_toplevel_add_listener(toplevel, &toplevel_listener, NULL);
    xdg_toplevel_set_title(toplevel, "decoration-check");
    if (!strcmp(argv[1], "xdg")) make_xdg();
    if (!strcmp(argv[1], "kde")) make_kde();
    wl_surface_commit(surface);
    char temporary[1024]; snprintf(temporary, sizeof temporary, "%s.new", argv[3]);
    while (running) {
        FILE *command = fopen(argv[2], "r");
        if (command) {
            int next; char op[32];
            if (fscanf(command, "%d %31s", &next, op) == 2 && next != sequence) {
                sequence = next;
                if (!strcmp(op, "quit")) running = 0;
                else if (!strcmp(op, "xdg_create")) make_xdg();
                else if (!strcmp(op, "kde_create")) make_kde();
                else if (!strcmp(op, "xdg_server")) zxdg_toplevel_decoration_v1_set_mode(xdg_decoration, 2);
                else if (!strcmp(op, "xdg_client")) zxdg_toplevel_decoration_v1_set_mode(xdg_decoration, 1);
                else if (!strcmp(op, "xdg_unset")) zxdg_toplevel_decoration_v1_unset_mode(xdg_decoration);
                else if (!strcmp(op, "xdg_destroy")) { zxdg_toplevel_decoration_v1_destroy(xdg_decoration); xdg_decoration = NULL; xdg_mode = 0; }
                else if (!strcmp(op, "kde_server")) org_kde_kwin_server_decoration_request_mode(kde_decoration, 2);
                else if (!strcmp(op, "kde_client")) org_kde_kwin_server_decoration_request_mode(kde_decoration, 1);
                else if (!strcmp(op, "kde_none")) org_kde_kwin_server_decoration_request_mode(kde_decoration, 0);
                else if (!strcmp(op, "kde_release")) { org_kde_kwin_server_decoration_release(kde_decoration); kde_decoration = NULL; kde_mode = 0; }
                else if (!strcmp(op, "fullscreen")) xdg_toplevel_set_fullscreen(toplevel, NULL);
                else if (!strcmp(op, "unfullscreen")) xdg_toplevel_unset_fullscreen(toplevel);
                else if (!strcmp(op, "maximize")) xdg_toplevel_set_maximized(toplevel);
                else if (!strcmp(op, "unmaximize")) xdg_toplevel_unset_maximized(toplevel);
                else return 3;
                wl_surface_commit(surface);
            }
            fclose(command);
        }
        if (wl_display_roundtrip(display) < 0) return 4;
        FILE *report = fopen(temporary, "w");
        if (!report) return 3;
        fprintf(report, "{\"sequence\":%d,\"configures\":%d,\"w\":%d,\"h\":%d,\"xdg_mode\":%d,\"kde_mode\":%d,\"default_mode\":%d,\"clicks\":%d,\"click_x\":%d,\"click_y\":%d}\n",
            sequence, configures, width, height, xdg_mode, kde_mode, default_mode, clicks, click_x, click_y);
        fclose(report); rename(temporary, argv[3]); usleep(20000);
    }
    wl_display_disconnect(display); unlink(argv[3]);
    return 0;
}
