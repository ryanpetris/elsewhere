# GTK session defaults

The complete window-manager preferences schema and its generated enum definitions
come from gsettings-desktop-schemas 48.0, as distributed in Debian's 48.0-1 package.
The upstream schema is `schemas/org.gnome.desktop.wm.preferences.gschema.xml.in`;
`headers/gdesktop-enums.h` supplies the generated enums. NOTICE and LICENSE record
their source and license. The Elsewhere override sets the titlebar button layout.

`build.rs` compiles these resources with `glib-compile-schemas`. The binary embeds
the result and writes it to a private session data directory. Launched clients
receive that directory before the existing `XDG_DATA_DIRS`, with the standard
system directories used when the variable is unset or empty. Other application
schemas remain available through the GSettings schema search path. The bundled
`org.gnome.desktop.wm.preferences` schema also supplies defaults for its other keys;
distribution overrides for that same schema in later data directories do not apply.

User GSettings values and `GSETTINGS_SCHEMA_DIR` retain their precedence.
`XDG_DATA_HOME` and configuration directories remain unchanged. The session does not write global settings.
