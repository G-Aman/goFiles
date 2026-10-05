package main

// main.go — flags, boot, SIGHUP reload, graceful shutdown.

import (
	"context"
	"errors"
	"flag"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

func main() {
	var (
		cfgPath  = flag.String("config", "", "path to config.json")
		listen   = flag.String("listen", "", "override listen addr (host:port or unix:/path)")
		root     = flag.String("root", "", "override serve root")
		assets   = flag.String("assets", "", "override assets dir (UI files)")
		prefix   = flag.String("path-prefix", "", "override public path prefix")
		check    = flag.Bool("check-config", false, "validate config and exit")
		genPass  = flag.String("genpass", "", "print bcrypt hash of given password and exit")
		showVer  = flag.Bool("version", false, "print version")
	)
	flag.Parse()

	if *showVer {
		log.SetFlags(0)
		log.Printf("%s %s", AppName, Version)
		return
	}
	if *genPass != "" {
		h, err := HashPass(*genPass)
		if err != nil {
			log.Fatal(err)
		}
		log.SetFlags(0)
		log.Println(h)
		return
	}

	// Resolve the config path ONCE, before loading, and use that single value
	// for both reading and writing. Previously the read path used the raw
	// -config flag while the write path derived its own default, so on a
	// config-less first run the server wrote config.json that it then refused
	// to read on the next boot — silently reverting the admin claim.
	effectiveCfg := absOr(*cfgPath, "")
	if effectiveCfg == "" {
		wd, wderr := os.Getwd()
		if wderr != nil {
			log.Fatalf("cwd: %v", wderr)
		}
		effectiveCfg = filepath.Join(wd, "config.json")
	}
	cfg, err := LoadConfig(effectiveCfg)
	if err != nil {
		log.Fatalf("config: %v", err)
	}
	trustXFF = cfg.TrustProxy
	if *listen != "" {
		cfg.Listen = *listen
	}
	if *root != "" {
		cfg.Root = *root
	}
	if *assets != "" {
		cfg.Assets = *assets
	}
	if *prefix != "" {
		cfg.PathPrefix = *prefix
	}
	if err := cfg.validate(); err != nil {
		log.Fatalf("config: %v", err)
	}
	// Permissions live in their own file so access control can be edited
	// without touching the main config. config.json "rules" is still honoured
	// when acl.conf is absent, so an existing install keeps working.
	aclPath := ACLPath(effectiveCfg)
	rules, err := LoadRules(aclPath)
	if err != nil {
		log.Fatalf("acl %s: %v", aclPath, err)
	}
	if len(rules) == 0 && len(cfg.Rules) > 0 {
		if rules, err = parseRules(cfg.Rules); err != nil {
			log.Fatalf("config rules: %v", err)
		}
		log.Printf("no %s yet; migrated %d rule(s) from config.json", aclFileName, len(rules))
		_ = WriteRules(aclPath, rules)
	}
	if *check {
		log.SetFlags(0)
		log.Printf("config OK (%d acl rule(s) from %s)", len(rules), aclPath)
		return
	}

	dataDir := filepath.Dir(effectiveCfg)
	if err := os.MkdirAll(filepath.Join(dataDir, "state"), 0o700); err != nil {
		log.Printf("state dir: %v", err)
	}

	srv := NewServer(cfg, rules, dataDir)
	srv.SetCfgPath(effectiveCfg)

	var ln net.Listener
	addr := cfg.Listen
	if strings.HasPrefix(addr, "unix:") {
		ln, err = net.Listen("unix", strings.TrimPrefix(addr, "unix:"))
	} else {
		ln, err = net.Listen("tcp", addr)
	}
	if err != nil {
		log.Fatalf("listen %s: %v", addr, err)
	}

	httpSrv := &http.Server{
		Handler:           srv,
		ReadHeaderTimeout: 20 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	// logging to file if configured
	if cfg.LogFile != "" {
		if f, err := os.OpenFile(cfg.LogFile, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600); err == nil {
			log.SetOutput(io.MultiWriter(os.Stderr, f))
		}
	}

	log.Printf("%s %s listening on %s root=%s prefix=/%s users=%d rules=%d",
		AppName, Version, addr, cfg.Root, cfg.PathPrefix, len(cfg.Users), len(rules))

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGHUP, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		for sig := range sigCh {
			switch sig {
			case syscall.SIGHUP:
				// Reload from the SAME resolved paths the initial boot used, and
				// re-apply every flag override. This used to read the raw
				// -config flag, ignore -root, and rebuild the ACL from
				// config.json instead of acl.conf — so a plain SIGHUP silently
				// reverted the admin claim, repointed the served root at the
				// install directory (exposing config.json and the session
				// store), and dropped all configured permissions.
				nc, err := LoadConfig(effectiveCfg)
				if err != nil {
					log.Printf("reload failed (keep running old config): %v", err)
					continue
				}
				if *listen != "" {
					nc.Listen = *listen
				}
				if *root != "" {
					nc.Root = *root
				}
				if *assets != "" {
					nc.Assets = *assets
				}
				if *prefix != "" {
					nc.PathPrefix = *prefix
				}
				if err := nc.validate(); err != nil {
					log.Printf("reload config invalid (keep running old config): %v", err)
					continue
				}
				// permissions come from acl.conf, which exists precisely so a
				// reload does not have to touch config.json
				nr, err := LoadRules(ACLPath(effectiveCfg))
				if err != nil {
					log.Printf("reload acl failed (keep running old rules): %v", err)
					continue
				}
				if len(nr) == 0 && len(nc.Rules) > 0 {
					if nr, err = parseRules(nc.Rules); err != nil {
						log.Printf("reload rules failed: %v", err)
						continue
					}
				}
				trustXFF = nc.TrustProxy
				srv.Reload(nc, nr)
				log.Printf("config reloaded (%d users, %d rules, root=%s)", len(nc.Users), len(nr), nc.Root)
			default:
				log.Printf("signal %v — shutting down", sig)
				ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				defer cancel()
				_ = httpSrv.Shutdown(ctx)
				return
			}
		}
	}()

	if err := httpSrv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("serve: %v", err)
	}
}

func absOr(p string, def string) string {
	if p == "" {
		return def
	}
	a, err := filepath.Abs(p)
	if err != nil {
		return def
	}
	return a
}
