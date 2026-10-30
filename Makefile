UUID    := notchex@adityatakuli
PREFIX  := $(HOME)/.local/share/gnome-shell/extensions
DEST    := $(PREFIX)/$(UUID)
FILES   := metadata.json extension.js notch.js prefs.js stylesheet.css \
           modules schemas data
APPS    := $(HOME)/.local/share/applications

.PHONY: all compile-schemas install uninstall pack dist reload enable disable logs clean

all: compile-schemas

compile-schemas:
	glib-compile-schemas schemas/

install: compile-schemas
	mkdir -p "$(DEST)"
	cp -r $(FILES) "$(DEST)/"
	# a "Notchex Settings" app, so settings never need Extension Manager
	mkdir -p "$(APPS)"
	cp data/notchex-settings.desktop "$(APPS)/"

uninstall:
	rm -rf "$(DEST)"
	rm -f "$(APPS)/notchex-settings.desktop"

pack:
	rm -f $(UUID).shell-extension.zip schemas/gschemas.compiled
	gnome-extensions pack \
	    --extra-source=notch.js \
	    --extra-source=modules \
	    --extra-source=data \
	    --extra-source=README.md \
	    --extra-source=LICENSE \
	    --schema=schemas/org.gnome.shell.extensions.notchex.gschema.xml \
	    --force
	@echo "Built $(UUID).shell-extension.zip"

# Release zip for GitHub (what install.sh downloads). Same contents as
# `pack` but needs only zip + glib, so it also builds in CI.
dist:
	rm -f $(UUID).shell-extension.zip
	glib-compile-schemas --strict --dry-run schemas/
	zip -qr $(UUID).shell-extension.zip $(FILES) README.md LICENSE \
	    -x 'schemas/gschemas.compiled'
	@echo "Built $(UUID).shell-extension.zip"

enable:
	gnome-extensions enable $(UUID)

disable:
	gnome-extensions disable $(UUID)

reload: install
	@echo "Log out / log in (Wayland) or press Alt+F2 → r (X11) to reload GNOME Shell."

logs:
	journalctl -f -o cat /usr/bin/gnome-shell

clean:
	rm -f schemas/gschemas.compiled
	rm -f $(UUID).shell-extension.zip
