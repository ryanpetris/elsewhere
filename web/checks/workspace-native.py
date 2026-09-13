# GTK native event, transient, and frame-callback fixture for workspace checks.
import gi, json, os, sys
from pathlib import Path
gi.require_version('Gtk', '3.0')
from gi.repository import Gtk, GLib, Gdk

prefix, title = sys.argv[1:3]
state = {'frames': 0, 'keys': [], 'buttons': [], 'events': [], 'dialogs': 0, 'child_events': 0}
window = Gtk.Window(title=title)
window.set_default_size(380, 260)
if '--layer' in sys.argv:
    gi.require_version('GtkLayerShell', '0.1')
    from gi.repository import GtkLayerShell
    GtkLayerShell.init_for_window(window)
    GtkLayerShell.set_layer(window, GtkLayerShell.Layer.OVERLAY)
    GtkLayerShell.set_keyboard_mode(window, GtkLayerShell.KeyboardMode.EXCLUSIVE)
area = Gtk.Label(label=title)
window.add(area)

def save():
    Path(prefix + '.tmp').write_text(json.dumps(state))
    os.replace(prefix + '.tmp', prefix + '.json')

def key(widget, event, pressed):
    key = int(event.hardware_keycode)
    if pressed and key not in state['keys']: state['keys'].append(key)
    if not pressed and key in state['keys']: state['keys'].remove(key)
    state['events'].append(['key', key, pressed])
    state['events'] = state['events'][-40:]
    save()
    return False

window.connect('key-press-event', lambda w, e: key(w, e, True))
window.connect('key-release-event', lambda w, e: key(w, e, False))
window.connect('destroy', Gtk.main_quit)
menu = Gtk.Menu()
menu.append(Gtk.MenuItem(label='Workspace menu'))
menu.show_all()
def menu_closed(widget):
    state['menu_closed'] = state.get('menu_closed', 0) + 1
    save()
menu.connect('deactivate', menu_closed)
def open_menu(widget, event):
    if event.button == 3:
        menu.popup_at_pointer(event)
        state['menu_opened'] = state.get('menu_opened', 0) + 1
        save()
        return True
    return False
window.add_events(Gdk.EventMask.BUTTON_PRESS_MASK)
window.connect('button-press-event', open_menu)


def tick(widget, clock):
    state['frames'] += 1
    widget.set_text(title + ' frame ' + str(state['frames']))
    save()
    return True
area.add_tick_callback(tick)

loose = None
tooltip = None
def child_event(widget, event):
    state["child_events"] += 1
    save()
    return False

def commands():
    global loose, tooltip
    path = Path(prefix + '.command')
    if path.exists():
        command = path.read_text().strip()
        path.unlink()
        if command == 'loose':
            loose = Gtk.Window(title=title + ' Loose')
            loose.set_default_size(180, 120)
            loose.add(Gtk.Label(label='Independent child'))
            loose.add_events(Gdk.EventMask.SCROLL_MASK | Gdk.EventMask.BUTTON_PRESS_MASK)
            loose.connect('scroll-event', child_event)
            loose.connect('button-press-event', child_event)
            loose.show_all()
        if command == 'adopt': loose.set_transient_for(window)
        if command == 'tooltip':
            tooltip = Gtk.Window(type=Gtk.WindowType.POPUP, title=title + ' Tooltip', transient_for=window)
            tooltip.add(Gtk.Label(label='Tooltip'))
            def tooltip_frame(widget, clock):
                state['tooltip_frame'] = True
                save()
                return False
            tooltip.add_tick_callback(tooltip_frame)
            tooltip.show_all()
        if command == 'close-tooltip': tooltip.destroy()
        if command == 'dialog':
            dialog = Gtk.Window(title=title + ' Dialog', transient_for=window)
            dialog.set_default_size(180, 120)
            dialog.add(Gtk.Label(label='Transient dialog'))
            dialog.show_all()
            state['dialogs'] += 1
        if command == 'close': window.destroy()
        save()
    return True
GLib.timeout_add(50, commands)
if '--delayed' in sys.argv:
    window.connect('realize', lambda widget: widget.get_window().freeze_updates())
    def resume_draw():
        if not Path(prefix + '.resume').exists(): return True
        window.get_window().thaw_updates()
        state['drawn'] = True
        save()
        return False
    GLib.timeout_add(50, resume_draw)
window.show_all()
if '--delayed' in sys.argv:
    Gdk.Display.get_default().flush()
    Path(prefix + '.waiting').write_text('ready')

save()
Gtk.main()
