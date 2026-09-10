# Docker GTK fixture, run with GDK_BACKEND=wayland or x11.
import sys
import gi

gi.require_version('Gtk', '3.0')
from gi.repository import Gtk, Gdk

window = Gtk.Window(title=sys.argv[1])
window.set_default_size(*map(int, sys.argv[4:6]))
limits = Gdk.Geometry()
limits.min_width, limits.min_height = map(int, sys.argv[2:4])
flags = Gdk.WindowHints.MIN_SIZE
if len(sys.argv) == 8:
    limits.max_width, limits.max_height = map(int, sys.argv[6:8])
    flags |= Gdk.WindowHints.MAX_SIZE
window.set_geometry_hints(None, limits, flags)
window.add(Gtk.DrawingArea())
window.connect('destroy', Gtk.main_quit)
window.show_all()
Gtk.main()
