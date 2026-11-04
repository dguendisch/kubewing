package main

import (
	"embed"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/user"
	"path/filepath"
	"strings"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/dguendisch/kubewing/internal/app"
	"github.com/dguendisch/kubewing/internal/bridge"
	"github.com/dguendisch/kubewing/internal/catalog"
	"github.com/dguendisch/kubewing/internal/config"
	"github.com/dguendisch/kubewing/internal/gardener"
	"github.com/dguendisch/kubewing/internal/source"
	"github.com/dguendisch/kubewing/internal/tape"
)

//go:embed all:frontend/dist
var assets embed.FS

// Dock icon at runtime, so the plain `make build` binary shows it too (no .app bundle needed).
//
//go:embed build/appicon.png
var appIcon []byte

type wailsEmitter struct{ app *application.App }

func (e *wailsEmitter) Emit(name string, data any) { e.app.Event.Emit(name, data) }

func main() {
	headless := flag.String("headless", "", "serve the bridge over WebSocket on this address instead of opening a window (e.g. 127.0.0.1:7777)")
	tapes := flag.String("tapes", "", "headless only: replay scenario tapes from this directory instead of using kubeconfig")
	speed := flag.Float64("speed", 1, "headless only: tape replay speed factor")
	catalogFile := flag.String("catalog", "", "with -tapes: fake resource types/namespaces for completion (e.g. testdata/catalog.yaml)")
	configDir := flag.String("config", "", "config directory (default: $KUBEWING_HOME or ~/.kubewing; headless: none)")
	stateDir := flag.String("state", "", "where history.yaml (recent debug images) is written (default: the config directory; headless: none, kept in memory)")
	newProcess := flag.Bool("new-process", false, "start a kubewing of its own; default: open a new tab in the one already running on this config directory, if any")
	gardenHome := flag.String("garden", "", "gardenctl's directory with gardenctl-v2.yaml (default: $GCTL_HOME, else ~/.garden); headless: none unless given, and session targets from its sessions/")
	wait := flag.Bool("wait", false, "from a terminal: stay in the foreground, logging there (default: launch.wait in config.yaml, else detach and log to kubewing.log in the state directory)")
	version := flag.Bool("version", false, "print the version and exit")
	flag.Parse()
	if *version {
		fmt.Println(app.Version)
		return
	}
	// from the Dock or Finder: the login shell's PATH (exec plugins) and variables, before anything reads them
	if *headless == "" {
		if err := app.LoginEnv(); err != nil {
			log.Printf("keeping launchd's environment: %v", err)
		}
	}

	var opener interface {
		source.Opener
		source.Lister
		source.Actor
	} = source.NewClusterOpener()
	if *tapes != "" {
		o, err := loadTapes(*tapes, *speed)
		if err != nil {
			log.Fatal(err)
		}
		if *catalogFile != "" {
			if o.Catalog, err = tape.LoadCatalog(*catalogFile); err != nil {
				log.Fatal(err)
			}
		}
		opener = o
	}
	opts := bridge.Options{Catalog: catalog.New(opener, catalog.Options{}), ConfigDir: *configDir, Actor: opener}
	if opts.ConfigDir == "" && *headless == "" {
		opts.ConfigDir = config.Dir()
	}
	if *stateDir == "" && *headless == "" {
		*stateDir = opts.ConfigDir
	}
	// handing over to the kubewing running on this config directory: in this terminal, nothing to detach for
	handOver := *headless == "" && !*newProcess && app.Running(opts.ConfigDir)
	if *headless == "" && !handOver && app.FromTerminal() && !waitFlag(*wait, opts.ConfigDir) {
		var logFile string
		if *stateDir != "" {
			logFile = filepath.Join(*stateDir, app.LogFile)
		}
		// a later launch hands over and exits in the detached one just the same
		if err := app.Detach(logFile); err != nil {
			log.Printf("staying in the foreground: %v", err)
		} else {
			return
		}
	}
	opts.History = config.OpenHistory(*stateDir)
	opts.Columns = config.OpenColumns(*stateDir)
	opts.Clusters = config.OpenClusters(*stateDir)
	if *headless == "" || *gardenHome != "" {
		paths := gardener.DefaultPaths()
		if *gardenHome != "" {
			paths.Config = filepath.Join(*gardenHome, "gardenctl-v2.yaml")
		}
		if *headless != "" {
			// tests: never the sessions of the user's terminals, the given directory's
			paths.Sessions = filepath.Join(*gardenHome, "sessions")
		}
		lookup, _ := opener.(gardener.Lookup)
		opts.Gardener = &bridge.Gardener{Paths: paths, Lookup: lookup}
	}
	// ops pods are named after the user, as ops-toolbelt's $(whoami); tapes: a fixed one (e2e)
	if *tapes != "" {
		opts.User = "e2e"
	} else if u, err := user.Current(); err == nil {
		opts.User = u.Username
	}
	if *headless != "" {
		runHeadless(*headless, opener, opts, *tapes != "")
		return
	}

	emit := &wailsEmitter{}
	svc := bridge.New(source.NewRegistry(opener), emit, opts)
	api := app.New(svc)
	var win *application.WebviewWindow
	var single *application.SingleInstanceOptions
	if !*newProcess {
		// a later launch lands here; until the window exists there is nothing to open a tab in
		var err error
		single, err = app.SingleInstance(opts.ConfigDir, func(l app.Launch) {
			if win != nil {
				emit.Emit(app.LaunchEvent, l)
				app.BringToFront(emit.app, win)
			}
		})
		if err != nil {
			log.Printf("starting a kubewing of its own: %v", err)
		} else if handOver {
			// Wails exits in application.New without a word; -wait included, which looks like it was ignored
			fmt.Fprintf(os.Stderr, "kubewing already runs on %s: opened a new tab in it (-new-process starts one of its own)\n", opts.ConfigDir)
		}
	}
	a := application.New(application.Options{
		Name:        "kubewing",
		Description: "keyboard-driven Kubernetes UI\n\nversion " + app.Version, // the app menu's About
		Icon:        appIcon,
		Services:    []application.Service{application.NewService(api)},
		Assets:      application.AssetOptions{Handler: application.AssetFileServerFS(assets)},
		Mac:         application.MacOptions{ApplicationShouldTerminateAfterLastWindowClosed: true},
		OnShutdown:  svc.Shutdown, // exec sessions and port-forwards end with the app
		// a launch with a kubewing already running on this config directory exits in here
		SingleInstance: single,
	})
	emit.app = a
	// before the frontend sends its menus (and should it never): no ⌘W "Close Window", no ⌘R "Reload"
	a.Menu.Set(app.BaseMenu(nil, emit.Emit))
	api.MenuFn = func(m []app.Menu) { a.Menu.Set(app.BaseMenu(m, emit.Emit)) }
	// reopens in the size it was last closed in (history.yaml)
	win = app.NewMainWindow(a, opts.History, application.WebviewWindowOptions{
		Title:  "kubewing",
		Width:  1400,
		Height: 860,
		Mac: application.MacWindow{
			// no InvisibleTitleBarHeight: AppKit would drag the window from anywhere in that strip, tabs included,
			// before the page sees the click; the tab bar's empty part drags it instead (--wails-draggable)
			// no toolbar: keeps the traffic lights inside the 28px tab strip (Inset adds one and makes the bar taller)
			TitleBar: application.MacTitleBarHidden,
		},
		BackgroundColour: application.NewRGB(30, 30, 30), // theme.css --color-bg
		URL:              "/",
	})
	if err := a.Run(); err != nil {
		log.Fatal(err)
	}
}

// waitFlag: -wait if given (also -wait=false), else launch.wait in config.yaml.
func waitFlag(wait bool, configDir string) bool {
	set := false
	flag.Visit(func(f *flag.Flag) { set = set || f.Name == "wait" })
	if set {
		return wait
	}
	return config.Load(configDir).Config.Launch.Wait
}

func runHeadless(addr string, opener source.Opener, opts bridge.Options, fromTapes bool) {
	hub := bridge.NewHub()
	api := app.New(bridge.New(source.NewRegistry(opener), hub, opts))
	if fromTapes {
		api.ContextsFn = func(string) (bridge.ContextList, error) {
			// tape-dev sets a namespace like a kubeconfig context can (e2e: new panes start in it)
			return bridge.ContextList{Contexts: []string{"tape", "tape-dev", "tape-live", "tape-prod"}, Current: "tape", Namespaces: map[string]string{"tape-dev": "prod"}}, nil
		}
	}
	mux := http.NewServeMux()
	mux.Handle("/kw-ws", hub.Handler(api))
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	log.Printf("kubewing headless bridge on ws://%s/kw-ws", addr)
	log.Fatal(http.ListenAndServe(addr, mux))
}

func loadTapes(dir string, speed float64) (*tape.Opener, error) {
	files, err := filepath.Glob(filepath.Join(dir, "*.yaml"))
	if err != nil {
		return nil, err
	}
	o := &tape.Opener{Tapes: map[string]*tape.Tape{}, Speed: speed}
	for _, f := range files {
		t, err := tape.Load(f)
		if err != nil {
			return nil, err
		}
		// addressable by file name ("pods-basic") and by its pipeline resource
		o.Tapes[strings.TrimSuffix(filepath.Base(f), ".yaml")] = t
		if _, dup := o.Tapes[t.Pipeline.Source.Resource]; !dup {
			o.Tapes[t.Pipeline.Source.Resource] = t
		}
	}
	if len(o.Tapes) == 0 {
		return nil, os.ErrNotExist
	}
	return o, nil
}
