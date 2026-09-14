// A panel client checks activation commit boundaries against the live compositor.
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wayland-client.h>
#include "ext-workspace-v1-client-protocol.h"

static struct ext_workspace_manager_v1 *manager;
struct workspace { struct ext_workspace_handle_v1 *handle; unsigned number; unsigned active; unsigned caps; };
static struct workspace workspaces[8];
static struct ext_workspace_group_handle_v1 *workspace_group;
static unsigned removed_count;
static unsigned count, done_count;
static void ws_id(void *data, struct ext_workspace_handle_v1 *ws, const char *id) { (void)data; (void)ws; (void)id; }
static void ws_name(void *data, struct ext_workspace_handle_v1 *ws, const char *name) { (void)ws; ((struct workspace *)data)->number = atoi(name); }
static void ws_coordinates(void *data, struct ext_workspace_handle_v1 *ws, struct wl_array *coords) { (void)data; (void)ws; assert(coords->size == 4); }
static void ws_state(void *data, struct ext_workspace_handle_v1 *ws, uint32_t state) { (void)ws; ((struct workspace *)data)->active = !!(state & EXT_WORKSPACE_HANDLE_V1_STATE_ACTIVE); }
static void ws_caps(void *data, struct ext_workspace_handle_v1 *ws, uint32_t caps) { (void)ws; ((struct workspace *)data)->caps = caps; }
static void ws_removed(void *data, struct ext_workspace_handle_v1 *ws) { (void)ws; ((struct workspace *)data)->active = 0; removed_count++; }
static const struct ext_workspace_handle_v1_listener ws_listener = { ws_id, ws_name, ws_coordinates, ws_state, ws_caps, ws_removed };
static void group_caps(void *data, struct ext_workspace_group_handle_v1 *group, uint32_t caps) { (void)data; (void)group; assert(caps == EXT_WORKSPACE_GROUP_HANDLE_V1_GROUP_CAPABILITIES_CREATE_WORKSPACE); }
static void group_output(void *data, struct ext_workspace_group_handle_v1 *group, struct wl_output *output) { (void)data; (void)group; (void)output; }
static void group_workspace(void *data, struct ext_workspace_group_handle_v1 *group, struct ext_workspace_handle_v1 *ws) { (void)data; (void)group; (void)ws; }
static void group_removed(void *data, struct ext_workspace_group_handle_v1 *group) { (void)data; (void)group; abort(); }
static const struct ext_workspace_group_handle_v1_listener group_listener = { group_caps, group_output, group_output, group_workspace, group_workspace, group_removed };
static void new_group(void *data, struct ext_workspace_manager_v1 *m, struct ext_workspace_group_handle_v1 *group) { (void)data; (void)m; workspace_group = group; ext_workspace_group_handle_v1_add_listener(group, &group_listener, NULL); }
static void new_workspace(void *data, struct ext_workspace_manager_v1 *m, struct ext_workspace_handle_v1 *ws) { (void)data; (void)m; assert(count < 8); workspaces[count].handle = ws; ext_workspace_handle_v1_add_listener(ws, &ws_listener, &workspaces[count]); count++; }
static void done(void *data, struct ext_workspace_manager_v1 *m) { (void)data; (void)m; done_count++; }
static void finished(void *data, struct ext_workspace_manager_v1 *m) { (void)data; (void)m; }
static const struct ext_workspace_manager_v1_listener manager_listener = { new_group, new_workspace, done, finished };
static void global(void *data, struct wl_registry *registry, uint32_t name, const char *interface, uint32_t version) {
    (void)data; (void)version;
    if (!strcmp(interface, "ext_workspace_manager_v1")) {
        manager = wl_registry_bind(registry, name, &ext_workspace_manager_v1_interface, 1);
        ext_workspace_manager_v1_add_listener(manager, &manager_listener, NULL);
    }
}
static void removed(void *data, struct wl_registry *registry, uint32_t name) { (void)data; (void)registry; (void)name; }
static const struct wl_registry_listener registry_listener = { global, removed };
static unsigned active(void) { unsigned result = 0; for (unsigned i = 0; i < count; i++) if (workspaces[i].active) { assert(!result); result = workspaces[i].number; } return result; }
int main(int argc, char **argv) {
    assert(argc == 2); unsigned target = atoi(argv[1]); assert(target >= 1 && target <= 4);
    struct wl_display *display = wl_display_connect(NULL); assert(display);
    struct wl_registry *registry = wl_display_get_registry(display);
    wl_registry_add_listener(registry, &registry_listener, NULL);
    assert(wl_display_roundtrip(display) >= 0); assert(manager);
    assert(wl_display_roundtrip(display) >= 0); assert(count == 4 && done_count);
    unsigned before = active(); assert(before);
    struct workspace *target_ws = NULL;
    for (unsigned i = 0; i < count; i++) { assert(workspaces[i].caps == (EXT_WORKSPACE_HANDLE_V1_WORKSPACE_CAPABILITIES_ACTIVATE | EXT_WORKSPACE_HANDLE_V1_WORKSPACE_CAPABILITIES_REMOVE)); if (workspaces[i].number == target) target_ws = &workspaces[i]; }
    assert(target_ws);
    ext_workspace_handle_v1_activate(target_ws->handle);
    assert(wl_display_roundtrip(display) >= 0); assert(active() == before);
    ext_workspace_manager_v1_commit(manager);
    assert(wl_display_roundtrip(display) >= 0); assert(active() == target);
    ext_workspace_group_handle_v1_create_workspace(workspace_group, "5");
    assert(wl_display_roundtrip(display) >= 0); assert(count == 4);
    ext_workspace_manager_v1_commit(manager);
    assert(wl_display_roundtrip(display) >= 0); assert(count == 5);
    ext_workspace_handle_v1_remove(workspaces[4].handle);
    assert(wl_display_roundtrip(display) >= 0); assert(removed_count == 0);
    ext_workspace_manager_v1_commit(manager);
    assert(wl_display_roundtrip(display) >= 0); assert(removed_count == 1);
    printf("{\"before\":%u,\"active\":%u,\"count\":%u,\"commit_boundary\":true}\n", before, active(), count - removed_count);
    wl_display_disconnect(display);
}
