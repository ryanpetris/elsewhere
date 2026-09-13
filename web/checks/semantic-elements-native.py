"""Native fixtures for semantic-elements.mjs, run inside the Docker rig."""
import json
import sys
from pathlib import Path

kind, result_path = sys.argv[1:3]
state = {"clicks": 0, "checked": False, "text": ""}
def record(**values):
    state.update(values)
    pending = Path(result_path).with_suffix(".tmp")
    pending.write_text(json.dumps(state))
    pending.replace(result_path)

if kind == "gtk":
    import gi
    gi.require_version("Gtk", "3.0")
    from gi.repository import Gtk, Gdk, GLib
    win = Gtk.Window(title="Semantic gtk")
    box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
    win.add(box)
    def button(label, callback):
        widget = Gtk.Button(label=label)
        widget.connect("clicked", callback)
        box.pack_start(widget, False, False, 0)
        return widget
    commit = button("Commit", lambda _: record(clicks=state["clicks"] + 1))
    check = Gtk.CheckButton(label="Subscribed")
    check.connect("toggled", lambda w: record(checked=w.get_active()))
    box.pack_start(check, False, False, 0)
    sticky = Gtk.ToggleButton(label="Sticky")
    sticky.connect("toggled", lambda w: record(sticky=w.get_active()))
    box.pack_start(sticky, False, False, 0)
    entry = Gtk.Entry()
    entry.get_accessible().set_name("Message")
    entry.connect("changed", lambda w: record(text=w.get_text()))
    box.pack_start(entry, False, False, 0)
    secret = Gtk.Entry()
    secret.set_visibility(False)
    secret.get_accessible().set_name("Secret")
    secret.connect("changed", lambda w: record(secret=w.get_text()))
    box.pack_start(secret, False, False, 0)
    disabled = button("Disabled", lambda _: record(disabled_clicked=True))
    disabled.set_sensitive(False)
    button("Duplicate", lambda _: record(wrong=True))
    button("Duplicate", lambda _: record(wrong=True))
    later = button("Later", lambda _: record(later=True))
    later.set_sensitive(False)
    button("Schedule", lambda _: GLib.timeout_add(350, lambda: later.set_sensitive(True)))
    def replace(_):
        commit.destroy()
        button("Commit", lambda _: record(clicks=state["clicks"] + 1)).show()
    button("Replace commit", replace)
    def large(_):
        fixed = Gtk.Fixed()
        box.pack_start(fixed, False, False, 0)
        for i in range(510):
            fixed.put(Gtk.Button(label="Large tree item " + str(i)), 0, 0)
        box.reorder_child(fixed, 0)
        fixed.show_all()
    button("Large tree", large)
    menu = Gtk.Menu()
    item = Gtk.MenuItem(label="Popup commit")
    item.connect("activate", lambda _: record(popup=True))
    menu.append(item)
    menu.show_all()
    button("Open menu", lambda widget: menu.popup_at_widget(widget, Gdk.Gravity.SOUTH_WEST, Gdk.Gravity.NORTH_WEST, None))
    twins = []
    def twin(_):
        other = Gtk.Window(title="Semantic gtk")
        other.add(Gtk.Button(label="Commit"))
        other.show_all()
        twins.append(other)
    button("Twin window", twin)
    win.connect("destroy", Gtk.main_quit)
    win.show_all()
    record()
    Gtk.main()
else:
    from PyQt6.QtWidgets import QApplication, QWidget, QVBoxLayout, QPushButton, QCheckBox, QLineEdit
    from PyQt6.QtCore import QTimer
    app = QApplication([])
    win = QWidget()
    win.setWindowTitle("Semantic qt")
    box = QVBoxLayout(win)
    def button(label, callback):
        widget = QPushButton(label)
        widget.clicked.connect(callback)
        box.addWidget(widget)
        return widget
    button("Commit", lambda: record(clicks=state["clicks"] + 1))
    check = QCheckBox("Subscribed")
    check.toggled.connect(lambda value: record(checked=value))
    box.addWidget(check)
    sticky = QPushButton("Sticky")
    sticky.setCheckable(True)
    sticky.toggled.connect(lambda value: record(sticky=value))
    box.addWidget(sticky)
    entry = QLineEdit()
    entry.setAccessibleName("Message")
    entry.textChanged.connect(lambda value: record(text=value))
    box.addWidget(entry)
    secret = QLineEdit()
    secret.setEchoMode(QLineEdit.EchoMode.Password)
    secret.setAccessibleName("Secret")
    secret.textChanged.connect(lambda value: record(secret=value))
    box.addWidget(secret)
    button("Disabled", lambda: record(disabled_clicked=True)).setEnabled(False)
    button("Duplicate", lambda: record(wrong=True))
    button("Duplicate", lambda: record(wrong=True))
    later = button("Later", lambda: record(later=True))
    later.setEnabled(False)
    button("Schedule", lambda: QTimer.singleShot(350, lambda: later.setEnabled(True)))
    win.show()
    record()
    app.exec()
