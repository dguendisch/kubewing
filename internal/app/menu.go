package app

import "github.com/wailsapp/wails/v3/pkg/application"

// MenuItem is one command entry of the native menu (frontend: keys/appMenu.ts),
// or with Items a submenu of them (its Command unused).
type MenuItem struct {
	Label       string `json:"label"`
	Command     string `json:"command,omitempty"`
	Accelerator string `json:"accelerator,omitempty"`
	// DisplayOnly: the accelerator is only shown, the page handles the key
	// (a plain letter or a scoped chord must not fire window-wide).
	DisplayOnly bool        `json:"displayOnly,omitempty"`
	Items       []*MenuItem `json:"items,omitempty"`
}

// Menu is one top-level menu; a nil item is a separator.
type Menu struct {
	Title string      `json:"title"`
	Items []*MenuItem `json:"items"`
}

// MenuHost installs the native application menu; nil when there is none (headless).
type MenuHost interface {
	SetApplicationMenu(*application.Menu)
}

// CommandEvent carries a clicked menu item's command id back to the dispatcher.
const CommandEvent = "kw:command"

// UpdateCommand is the app menu's "Check for Updates…" (frontend: keys/keymap.ts).
const UpdateCommand = "update.check"

// AppMenuTitle is the title of the frontend's menu whose items go into the
// app menu (after "Check for Updates…": the Settings submenu) instead of a menu of
// their own (frontend: keys/appMenu.ts APP_MENU).
const AppMenuTitle = "kubewing"

// BaseMenu is the macOS menu before the frontend sends its own, and the frame
// around it after: app menu (with "Check for Updates…"), Edit (text fields need its ⌘C/⌘V/⌘A/⌘Z in
// WKWebView) and Window. Wails' default would add ⌘W "Close Window" (quitting
// the app with its sessions, since the last window closing terminates it) and
// ⌘R "Reload" (losing all UI state): kubewing binds ⌘W to "close tab" and
// suppresses reload.
func BaseMenu(commands []Menu, emit func(name string, data any)) *application.Menu {
	m := application.NewMenu()
	// the AppMenu role's items, with "Check for Updates…" after About (as macOS apps have it)
	app := m.AddSubmenu("kubewing")
	app.AddRole(application.About)
	app.Add("Check for Updates…").OnClick(func(*application.Context) { emit(CommandEvent, UpdateCommand) })
	app.AddSeparator()
	for _, c := range commands {
		if c.Title == AppMenuTitle {
			addItems(app, c.Items, emit)
			app.AddSeparator()
		}
	}
	app.AddRole(application.ServicesMenu)
	app.AddSeparator()
	app.AddRole(application.Hide)
	app.AddRole(application.HideOthers)
	app.AddRole(application.UnHide)
	app.AddSeparator()
	app.AddRole(application.Quit)
	m.AddRole(application.EditMenu)
	for _, c := range commands {
		if c.Title != AppMenuTitle {
			addItems(m.AddSubmenu(c.Title), c.Items, emit)
		}
	}
	window := m.AddSubmenu("Window")
	window.AddRole(application.Minimise)
	window.AddRole(application.Zoom)
	window.AddSeparator()
	window.AddRole(application.ToggleFullscreen)
	return m
}

func addItems(sub *application.Menu, items []*MenuItem, emit func(name string, data any)) {
	for _, it := range items {
		if it == nil {
			sub.AddSeparator()
			continue
		}
		if len(it.Items) > 0 {
			addItems(sub.AddSubmenu(it.Label), it.Items, emit)
			continue
		}
		item := sub.Add(it.Label)
		// only where GuardDisplayOnly can keep it from firing
		if it.Accelerator != "" && (!it.DisplayOnly || canGuardKeys) {
			item.SetAccelerator(it.Accelerator)
		}
		cmd := it.Command
		item.OnClick(func(*application.Context) { emit(CommandEvent, cmd) })
	}
}

// GuardDisplayOnly keeps the installed menu's display-only accelerators of
// commands from firing (call it after setting BaseMenu(commands, …)): macOS
// shows them where it shows key equivalents, but the key stays the page's.
func GuardDisplayOnly(commands []Menu) {
	var paths []string
	var walk func(prefix string, items []*MenuItem)
	walk = func(prefix string, items []*MenuItem) {
		for _, it := range items {
			switch {
			case it == nil:
			case len(it.Items) > 0:
				walk(prefix+menuPathSep+it.Label, it.Items)
			case it.DisplayOnly && it.Accelerator != "":
				paths = append(paths, prefix+menuPathSep+it.Label)
			}
		}
	}
	for _, c := range commands {
		walk(c.Title, c.Items)
	}
	if len(paths) > 0 {
		guardMenuKeys(paths)
	}
}

// menuPathSep joins the titles from a top-level menu down to an item (labels have no tabs).
const menuPathSep = "\t"
