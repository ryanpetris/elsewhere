// X11 requests and root-coordinate observations for the Docker placement check.
#include <X11/Xatom.h>
#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char **argv) {
    if (argc != 5) return 1;
    Display *d = XOpenDisplay(NULL);
    if (!d) return 2;
    int popup = !strcmp(argv[1], "popup"), extents = atoi(argv[2]);
    Window root = DefaultRootWindow(d);
    Window w = XCreateSimpleWindow(d, root, 400, 250, popup ? 120 : 400, popup ? 90 : 240, 0, 0, 0xe52a61);
    XStoreName(d, w, "x11-placement-check");
    if (popup) {
        XSetWindowAttributes a = { .override_redirect = True };
        XChangeWindowAttributes(d, w, CWOverrideRedirect, &a);
    }
    if (extents) {
        unsigned long frame[] = {9, 11, 13, 15};
        XChangeProperty(d, w, XInternAtom(d, "_GTK_FRAME_EXTENTS", False), XA_CARDINAL, 32, PropModeReplace, (unsigned char *)frame, 4);
    }
    if (!popup) {
        XSizeHints hints = {.flags = PMinSize | PMaxSize, .min_width = 300, .min_height = 180, .max_width = 500, .max_height = 400};
        XSetWMNormalHints(d, w, &hints);
    }
    XSelectInput(d, w, StructureNotifyMask | ButtonPressMask);
    XMapWindow(d, w);
    XFlush(d);
    int sequence = 0, events = 0, clicks = 0, click_x = 0, click_y = 0;
    char temporary[1024];
    snprintf(temporary, sizeof temporary, "%s.new", argv[4]);
    for (;;) {
        int next, a = 0, b = 0;
        char op[32];
        FILE *command = fopen(argv[3], "r");
        if (command) {
            if (fscanf(command, "%d %31s %d %d", &next, op, &a, &b) >= 2 && next != sequence) {
                sequence = next;
                if (!strcmp(op, "quit")) { fclose(command); break; }
                if (!strcmp(op, "raise")) XRaiseWindow(d, w);
                if (!strcmp(op, "size")) XResizeWindow(d, w, a, b);
                if (!strcmp(op, "move")) XMoveWindow(d, w, a, b);
                if (!strcmp(op, "extents")) {
                    unsigned long frame[] = {a ? 9 : 0, a ? 11 : 0, a ? 13 : 0, a ? 15 : 0};
                    XChangeProperty(d, w, XInternAtom(d, "_GTK_FRAME_EXTENTS", False), XA_CARDINAL, 32, PropModeReplace, (unsigned char *)frame, 4);
                }
                XWindowChanges changes = {.width = a, .height = a};
                if (!strcmp(op, "width")) XConfigureWindow(d, w, CWWidth, &changes);
                if (!strcmp(op, "height")) XConfigureWindow(d, w, CWHeight, &changes);
                if (!strcmp(op, "beginmove") || !strcmp(op, "beginresize")) {
                    XEvent e = {0};
                    e.xclient.type = ClientMessage;
                    e.xclient.window = w;
                    e.xclient.message_type = XInternAtom(d, "_NET_WM_MOVERESIZE", False);
                    e.xclient.format = 32;
                    e.xclient.data.l[0] = a; e.xclient.data.l[1] = b;
                    e.xclient.data.l[2] = !strcmp(op, "beginmove") ? 8 : 0;
                    e.xclient.data.l[3] = 1; e.xclient.data.l[4] = 1;
                    XSendEvent(d, root, False, SubstructureRedirectMask | SubstructureNotifyMask, &e);
                }
                XFlush(d);
            }
            fclose(command);
        }
        while (XPending(d)) {
            XEvent event;
            XNextEvent(d, &event);
            if (event.type == ConfigureNotify) events++;
            if (event.type == ButtonPress) { clicks++; click_x = event.xbutton.x; click_y = event.xbutton.y; }
        }
        XWindowAttributes attributes;
        int x, y;
        Window child;
        XGetWindowAttributes(d, w, &attributes);
        XTranslateCoordinates(d, w, root, 0, 0, &x, &y, &child);
        FILE *report = fopen(temporary, "w");
        if (!report) return 3;
        fprintf(report, "{\"sequence\":%d,\"events\":%d,\"x\":%d,\"y\":%d,\"w\":%d,\"h\":%d,\"clicks\":%d,\"click_x\":%d,\"click_y\":%d}\n", sequence, events, x, y, attributes.width, attributes.height, clicks, click_x, click_y);
        fclose(report);
        rename(temporary, argv[4]);
        usleep(20000);
    }
    XDestroyWindow(d, w);
    XCloseDisplay(d);
    unlink(argv[4]);
    return 0;
}
