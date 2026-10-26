package main

import (
	"embed"
	"flag"
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
	flag.Parse()

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
	opts.History = config.OpenHistory(*stateDir)
	opts.Columns = config.OpenColumns(*stateDir)
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
	a := application.New(application.Options{
		Name:        "kubewing",
		Description: "keyboard-driven Kubernetes UI",
		Icon:        appIcon,
		Services:    []application.Service{application.NewService(api)},
		Assets:      application.AssetOptions{Handler: application.AssetFileServerFS(assets)},
		Mac:         application.MacOptions{ApplicationShouldTerminateAfterLastWindowClosed: true},
		OnShutdown:  svc.Shutdown, // exec sessions and port-forwards end with the app
	})
	emit.app = a
	// before the frontend sends its menus (and should it never): no ⌘W "Close Window", no ⌘R "Reload"
	a.Menu.Set(app.BaseMenu(nil, emit.Emit))
	api.MenuFn = func(m []app.Menu) { a.Menu.Set(app.BaseMenu(m, emit.Emit)) }
	// reopens in the size it was last closed in (history.yaml)
	app.NewMainWindow(a, opts.History, application.WebviewWindowOptions{
		Title:  "kubewing",
		Width:  1400,
		Height: 860,
		Mac: application.MacWindow{
			InvisibleTitleBarHeight: 28,
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

func runHeadless(addr string, opener source.Opener, opts bridge.Options, fromTapes bool) {
	hub := bridge.NewHub()
	api := app.New(bridge.New(source.NewRegistry(opener), hub, opts))
	if fromTapes {
		api.ContextsFn = func() (bridge.ContextList, error) {
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
