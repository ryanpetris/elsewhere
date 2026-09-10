"""GTK clipboard consumer and key observer for the Docker compound paste check."""
import hashlib
import json
import sys
import time
from pathlib import Path
from urllib.parse import unquote, urlparse
import gi

gi.require_version("Gtk", "3.0")
from gi.repository import Gdk, Gtk

name, root = sys.argv[1], Path(sys.argv[2])
window = Gtk.Window(title=name)
window.set_wmclass(name, name)
window.set_default_size(300, 160)
window.add(Gtk.Label(label="Paste an image or files"))
clipboard = Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD)


def record(kind, **data):
    with (root / (name + ".jsonl")).open("a") as log:
        log.write(json.dumps({"kind": kind, "at": time.time() * 1000, **data}) + "\n")


def received(clipboard, selection, _):
    data = bytes(selection.get_data() or b"")
    result = {"mime": selection.get_target().name(), "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}
    if result["mime"] == "text/uri-list":
        result["files"] = [{"name": Path(unquote(urlparse(uri).path)).name,
                            "text": Path(unquote(urlparse(uri).path)).read_text()}
                           for uri in data.decode().splitlines() if uri and not uri.startswith("#")]
    record("received", **result)


def key(widget, event):
    pressed = event.type == Gdk.EventType.KEY_PRESS
    record("key", pressed=pressed, key=Gdk.keyval_name(event.keyval), code=event.hardware_keycode, modifiers=int(event.state))
    paste = pressed and ((event.keyval in (Gdk.KEY_v, Gdk.KEY_V) and event.state & Gdk.ModifierType.CONTROL_MASK)
                         or (event.keyval == Gdk.KEY_Insert and event.state & Gdk.ModifierType.SHIFT_MASK))
    if paste:
        record("paste")
        mime = (root / "mime").read_text().strip()
        clipboard.request_contents(Gdk.Atom.intern(mime, False), received, None)
    return True


window.connect("key-press-event", key)
window.connect("key-release-event", key)
window.connect("destroy", Gtk.main_quit)
window.show_all()
Gtk.main()
