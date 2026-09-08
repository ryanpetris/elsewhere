"""GTK drag source/target for the Docker drag-and-drop check, on either backend."""
import json
import sys
from pathlib import Path
import gi

gi.require_version("Gtk", "3.0")
from gi.repository import Gdk, GLib, Gtk

name, root = sys.argv[1], Path(sys.argv[2])
window = Gtk.Window(title=name)
window.set_wmclass(name, name)
window.set_default_size(260, 180)
box = Gtk.EventBox()
box.add(Gtk.Label(label=name))
window.add(box)
box.add_events(Gdk.EventMask.TOUCH_MASK)
targets = [Gtk.TargetEntry.new("text/uri-list", 0, 0)]
box.drag_source_set(Gdk.ModifierType.BUTTON1_MASK, targets, Gdk.DragAction.COPY)
box.drag_dest_set(Gtk.DestDefaults.DROP, targets, Gdk.DragAction.COPY)


def record(kind, **data):
    with (root / (name + ".jsonl")).open("a") as log:
        log.write(json.dumps({"kind": kind, **data}) + "\n")


def motion(widget, context, x, y, time):
    record("motion", x=x, y=y)
    mode = (root / (name + ".mode")).read_text().strip()
    action = Gdk.DragAction.COPY if mode != "refuse" else Gdk.DragAction(0)
    if mode == "delay":
        GLib.timeout_add(250, lambda: (Gdk.drag_status(context, action, time), False)[1])
    else:
        Gdk.drag_status(context, action, time)
    return True


def received(widget, context, x, y, selection, info, time):
    data = bytes(selection.get_data() or b"").decode()
    record("received", data=data)
    Gtk.drag_finish(context, bool(data), False, time)


def supplied(widget, context, selection, info, time):
    selection.set(Gdk.Atom.intern("text/uri-list", False), 8, (root / "payload").read_bytes())


box.connect("drag-motion", motion)
box.connect("drag-data-get", supplied)
box.connect("drag-data-received", received)
box.connect("drag-begin", lambda *args: record("begin"))
box.connect("drag-end", lambda *args: record("end"))
def press(widget, event):
    record("press")
    mode = (root / (name + ".mode")).read_text().strip()
    if mode in ("move", "resize"):
        widget.drag_source_unset()
    if mode == "move":
        window.begin_move_drag(event.button, int(event.x_root), int(event.y_root), event.time)
        return True
    if mode == "resize":
        window.begin_resize_drag(Gdk.WindowEdge.SOUTH_EAST, event.button, int(event.x_root), int(event.y_root), event.time)
        return True
    if event.button == 3:
        menu = Gtk.Menu()
        menu.append(Gtk.MenuItem(label="Drag check menu"))
        menu.show_all()
        menu.popup_at_pointer(event)
        return True
    return False


def touched(widget, event):
    record("touch", event=event.type.value_nick)
    return True


box.connect("button-press-event", press)
box.connect("touch-event", touched)
window.connect("destroy", Gtk.main_quit)
window.show_all()
Gtk.main()
