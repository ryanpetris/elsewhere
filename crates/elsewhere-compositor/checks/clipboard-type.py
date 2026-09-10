"""Native multiline input and clipboard owner for the Docker typing check."""
import sys
from pathlib import Path
import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
from gi.repository import Gdk, Gtk

root = Path(sys.argv[1])
window = Gtk.Window(title="clipboard-type")
window.set_default_size(600, 400)
view = Gtk.TextView()
view.set_accepts_tab(True)
window.add(view)
buffer = view.get_buffer()

def changed(*args):
    temporary = root / "typed.tmp"
    temporary.write_text(buffer.get_text(buffer.get_start_iter(), buffer.get_end_iter(), True))
    temporary.replace(root / "typed")

buffer.connect("changed", changed)
def copy_seed(widget, event):
    if event.keyval in (Gdk.KEY_c, Gdk.KEY_C) and event.state & Gdk.ModifierType.CONTROL_MASK:
        Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD).set_text((root / "seed").read_text(), -1)
        return True
    return False

window.connect("key-press-event", copy_seed)
window.connect("destroy", Gtk.main_quit)
changed()
window.show_all()
view.grab_focus()
Gtk.main()
