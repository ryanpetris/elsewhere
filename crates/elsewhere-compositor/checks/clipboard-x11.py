"""X11 selection owner for the Docker clipboard bridge check."""
import sys
from pathlib import Path
import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
from gi.repository import Gdk, GLib, Gtk

window = Gtk.Window(title="Clipboard X11")
window.set_wmclass("clipboard-x11", "clipboard-x11")
clipboard = Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD)
previous = ""

def update():
    global previous
    command = Path(sys.argv[1]).read_text()
    if command and command != previous:
        previous = command
        mode = command.split()[1]
        if mode == "clear":
            clipboard.clear()
        else:
            clipboard.set_text(Path(sys.argv[2]).read_text(), -1)
    return True

window.connect("destroy", Gtk.main_quit)
GLib.timeout_add(20, update)
window.show_all()
Gtk.main()
