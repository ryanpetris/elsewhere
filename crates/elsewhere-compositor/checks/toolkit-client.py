#!/usr/bin/env python3
"""GTK/Qt windows and native widget observations for Docker checks."""
import json
import os
from pathlib import Path
import sys

kind, title, mode, output = sys.argv[1:]
report = Path(output)

def write(data):
    temporary = report.with_suffix(".new")
    temporary.write_text(json.dumps(data))
    temporary.replace(report)

if kind.startswith("gtk"):
    import gi
    version = "3.0" if kind == "gtk3" else "4.0"
    gi.require_version("Gtk", version)
    gi.require_version("Gdk", version)
    from gi.repository import Gio, GLib, Gtk

    def inspect():
        buttons = []
        def walk(widget):
            if version == "3.0":
                classes = widget.get_style_context().list_classes()
                children = []
                if isinstance(widget, Gtk.Container):
                    widget.forall(lambda child: children.append(child))
                coordinates = widget.translate_coordinates(window, 0, 0)
                rect = [*coordinates, widget.get_allocated_width(), widget.get_allocated_height()] if coordinates else None
            else:
                classes = widget.get_css_classes()
                children, child = [], widget.get_first_child()
                while child:
                    children.append(child)
                    child = child.get_next_sibling()
                success, bounds = widget.compute_bounds(window)
                rect = [bounds.get_x(), bounds.get_y(), bounds.get_width(), bounds.get_height()] if success else None
            if isinstance(widget, Gtk.Button):
                buttons.append({"css": list(classes), "visible": widget.get_visible(), "mapped": widget.get_mapped(), "sensitive": widget.get_sensitive(), "rect": rect})
            for child in children:
                walk(child)
        walk(header)
        settings = Gio.Settings.new("org.gnome.desktop.wm.preferences")
        schema = Gio.SettingsSchemaSource.get_default().lookup("org.elsewhere.SchemaCheck", True)
        custom = Gio.Settings.new("org.elsewhere.SchemaCheck").get_string("value") if schema else None
        schema_dir_source = Gio.SettingsSchemaSource.get_default().lookup("org.elsewhere.SchemaDirectoryCheck", True)
        schema_dir_value = Gio.Settings.new("org.elsewhere.SchemaDirectoryCheck").get_string("value") if schema_dir_source else None
        write({"maximized": window.is_maximized(), "width": window.get_allocated_width(), "height": window.get_allocated_height(), "schema_dir_value": schema_dir_value, "layout": Gtk.Settings.get_default().get_property("gtk-decoration-layout"), "buttons": buttons,
            "text": entry.get_text(), "wm_keys": settings.props.settings_schema.list_keys(), "wm_layout": settings.get_string("button-layout"), "modifier": settings.get_string("mouse-button-modifier"), "custom": custom,
            "config_home": os.environ.get("XDG_CONFIG_HOME"), "schema_dir": os.environ.get("GSETTINGS_SCHEMA_DIR"), "data_dirs": os.environ.get("XDG_DATA_DIRS")})
        return True

    def setup(app=None):
        global window, header, entry, parent
        if mode == "dialog":
            parent = Gtk.Window(title=title + " parent") if version == "3.0" else Gtk.ApplicationWindow(application=app, title=title + " parent")
            parent.set_default_size(200, 100)
            parent.show_all() if version == "3.0" else parent.present()
            window = Gtk.Dialog(title=title, transient_for=parent, modal=True)
            window.connect("response", lambda dialog, response: dialog.destroy())
        else:
            window = Gtk.Window(title=title) if version == "3.0" else Gtk.ApplicationWindow(application=app, title=title)
        window.set_default_size(450, 220)
        window.set_resizable(mode != "fixed")
        header = Gtk.HeaderBar()
        entry = Gtk.Entry()
        if version == "3.0":
            header.set_show_close_button(True)
            header.set_title(title)
            (window.get_content_area() if mode == "dialog" else window).add(entry)
            window.connect("destroy", Gtk.main_quit)
        else:
            header.set_show_title_buttons(True)
            if mode == "dialog":
                window.get_content_area().append(entry)
            else:
                window.set_child(entry)
        window.set_titlebar(header)
        window.show_all() if version == "3.0" else window.present()
        entry.grab_focus()
        if mode == "fullscreen":
            window.fullscreen()
        GLib.timeout_add(100, inspect)

    if version == "3.0":
        setup()
        Gtk.main()
    else:
        app = Gtk.Application(application_id=None)
        app.connect("activate", setup)
        app.run([])
else:
    if kind == "qt5":
        from PyQt5.QtWidgets import QApplication, QMainWindow, QLineEdit
        from PyQt5.QtCore import QTimer
    else:
        from PyQt6.QtWidgets import QApplication, QMainWindow, QLineEdit
        from PyQt6.QtCore import QTimer
    app = QApplication([])
    window = QMainWindow()
    window.setWindowTitle(title)
    window.resize(450, 220)
    entry = QLineEdit()
    window.setCentralWidget(entry)
    window.show()
    entry.setFocus()
    timer = QTimer()
    timer.timeout.connect(lambda: write({"text": entry.text(), "maximized": window.isMaximized(), "width": window.width(), "height": window.height()}))
    timer.start(100)
    app.exec()
report.unlink(missing_ok=True)
