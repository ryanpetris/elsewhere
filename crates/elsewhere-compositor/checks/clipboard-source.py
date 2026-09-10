"""Native text clipboard owner for the Docker synchronization check."""
import sys
from pathlib import Path
import gi

gi.require_version("Gtk", "3.0")
from gi.repository import Gdk, Gtk

root = Path(sys.argv[1])
window = Gtk.Window(title="clipboard-source")
window.set_default_size(300, 160)
window.add(Gtk.Label(label="Ctrl+C copies the fixture text"))
clipboard = Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD)


def key(widget, event):
    if event.keyval in (Gdk.KEY_c, Gdk.KEY_C) and event.state & Gdk.ModifierType.CONTROL_MASK:
        clipboard.set_text((root / "native-copy").read_text(), -1)
        return True
    return False


window.connect("key-press-event", key)
window.connect("destroy", Gtk.main_quit)
window.show_all()
Gtk.main()
