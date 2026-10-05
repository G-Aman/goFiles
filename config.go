package main

// config.go — config.json schema, defaults, validation, SIGHUP reload.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const Version = "1.0.0"
const AppName = "goFiles"

type User struct {
	Name string `json:"name"`
	Pass string `json:"pass"` // bcrypt hash or plain (auto-upgrade note in docs)
	Home string `json:"home"` // jail dir relative to root, default "/"
}

type AllowFlags struct {
	Write   *bool `json:"write"`
	Delete  *bool `json:"delete"`
	Upload  *bool `json:"upload"`
	URLFetch *bool `json:"urlfetch"`
	Archive *bool `json:"archive"`
	Extract *bool `json:"extract"`
	Edit    *bool `json:"edit"`
	Chmod   *bool `json:"chmod"`
	Hash    *bool `json:"hash"`
	WebDAV  *bool `json:"webdav"`
}

func (a AllowFlags) get(v **bool, def bool) bool {
	if *v != nil {
		return **v
	}
	return a.global(def)
}
func (a AllowFlags) global(def bool) bool { return def }

type RateLimit struct {
	MaxFails int `json:"max_fails"`
	WindowS  int `json:"window_s"`
	LockoutS int `json:"lockout_s"`
}

type Config struct {
	AppName       string   `json:"app_name"`
	LogoURL       string   `json:"logo_url"`
	Listen        string   `json:"listen"`
	Root          string   `json:"root"`
	PathPrefix    string   `json:"path_prefix"`
	Assets        string   `json:"assets"`
	Users         []User   `json:"users"`
	Rules         []string `json:"rules"`
	Allow         AllowFlags `json:"allow"`
	DenyExt       []string `json:"deny_ext"`
	Hidden        []string `json:"hidden"`
	AllowSymlink  bool     `json:"allow_symlink"`
	TrustProxy    bool     `json:"trust_proxy"`
	EnableCORS    bool     `json:"enable_cors"`
	IndexMode     string   `json:"index_mode"` // off|index|try-index|spa
	Compress      string   `json:"compress"`   // none|low|medium|high
	MaxUpload     int64    `json:"max_upload_bytes"`
	ChunkBytes    int64    `json:"chunk_bytes"`
	// StallTimeout bounds how long a url fetch waits for data before the job
	// errors out, instead of spinning forever. ResponseHeaderTimeout covers
	// the initial wait for the remote to answer at all.
	StallTimeout          int `json:"stall_timeout"`
	ResponseHeaderTimeout int `json:"response_header_timeout"`
	MinFree       int64    `json:"min_free_bytes"`
	Theme         string   `json:"theme"`
	Lang          string   `json:"lang"`
	LogFile       string   `json:"log_file"`
	AuditLog      *bool    `json:"audit_log"`
	Rate          RateLimit `json:"rate_limit"`
	SessionName   string   `json:"session_name"`
	CookieSecure  string   `json:"cookie_secure"` // auto|on|off
	AllowPrivateURLFetch bool `json:"allow_private_urlfetch"`
	EnableBackup  bool     `json:"enable_backup"`
	BackupCopies  int      `json:"backup_copies"` // max backups per file (default 3)

	// computed
	allowW, allowD, allowU, allowURL, allowArc, allowExt, allowEdit, allowChmod, allowHash, allowDAV bool
}

func DefaultConfig() *Config {
	c := &Config{
		AppName: "GoFile", LogoURL: "",
		Listen: "127.0.0.1:9001", Root: ".", PathPrefix: "", Assets: "",
		DenyExt: []string{}, Hidden: []string{},
		TrustProxy: true, IndexMode: "off", Compress: "low",
		MaxUpload: 50000000000, ChunkBytes: 2000000, MinFree: 100000000,
		Theme: "auto", Lang: "auto", CookieSecure: "auto", SessionName: "gofiles_session",
		Rate: RateLimit{MaxFails: 5, WindowS: 60, LockoutS: 300},
		EnableBackup: true, BackupCopies: 3,
	}
	tr := true
	c.AuditLog = &tr
	// each flag needs its OWN allocation — sharing one *true makes JSON decode
	// (which writes through the pointer) flip every flag at once.
	bp := func() *bool { v := true; return &v }
	c.Allow = AllowFlags{bp(), bp(), bp(), bp(), bp(), bp(), bp(), bp(), bp(), bp()}
	return c
}

func (c *Config) validate() error {
	if c.AppName == "" {
		c.AppName = "GoFile"
	}
	if c.Root == "" {
		c.Root = "."
	}
	abs, err := filepath.Abs(c.Root)
	if err != nil {
		return err
	}
	fi, err := os.Stat(abs)
	if os.IsNotExist(err) {
		if merr := os.MkdirAll(abs, 0o755); merr == nil {
			fi, err = os.Stat(abs)
		}
	}
	if err != nil || !fi.IsDir() {
		return fmt.Errorf("root %q is not a directory", abs)
	}
	c.Root = abs
	c.PathPrefix = strings.Trim(c.PathPrefix, "/")
	switch c.IndexMode {
	case "", "off", "index", "try-index", "spa":
	default:
		return fmt.Errorf("bad index_mode %q", c.IndexMode)
	}
	if c.Compress == "" {
		c.Compress = "low"
	}
	switch c.Compress {
	case "none", "low", "medium", "high":
	default:
		return fmt.Errorf("bad compress %q", c.Compress)
	}
	if c.MaxUpload < 0 {
		c.MaxUpload = 0 // 0 = unlimited
	}
	if c.ChunkBytes < 64*1024 || c.ChunkBytes > 64*1024*1024 {
		c.ChunkBytes = 2000000
	}
	if c.StallTimeout <= 0 {
		c.StallTimeout = 30
	}
	if c.ResponseHeaderTimeout <= 0 {
		c.ResponseHeaderTimeout = 20
	}
	if c.SessionName == "" {
		c.SessionName = "gofiles_session"
	}
	if c.BackupCopies <= 0 {
		c.BackupCopies = 3
	}
	if c.Rate.MaxFails == 0 {
		c.Rate = RateLimit{5, 60, 300}
	}
	if len(c.Users) == 0 {
		// NO users is a valid, supported state. Do not invent a password: the
		// server boots read-only on the served tree and the first visitor
		// claims the admin account through the setup screen. Never ship a
		// default credential.
		return nil
	}
	for i := range c.Users {
		if c.Users[i].Name == "" || c.Users[i].Pass == "" {
			return fmt.Errorf("user[%d] missing name or pass", i)
		}
	}
	c.allowW = deref(c.Allow.Write)
	c.allowD = deref(c.Allow.Delete)
	c.allowU = deref(c.Allow.Upload)
	c.allowURL = deref(c.Allow.URLFetch)
	c.allowArc = deref(c.Allow.Archive)
	c.allowExt = deref(c.Allow.Extract)
	c.allowEdit = deref(c.Allow.Edit)
	c.allowChmod = deref(c.Allow.Chmod)
	c.allowHash = deref(c.Allow.Hash)
	c.allowDAV = deref(c.Allow.WebDAV)
	return nil
}

func deref(p *bool) bool { return p != nil && *p }

// SaveConfig writes config.json atomically. Used by first-run setup and by the
// admin settings screen so changes survive a restart.
func SaveConfig(path string, c *Config) error {
	if path == "" {
		return fmt.Errorf("no config path")
	}
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func LoadConfig(path string) (*Config, error) {
	c := DefaultConfig()
	if path != "" {
		b, err := os.ReadFile(path)
		if err != nil {
			// A missing config is the normal first-run state, not a failure:
			// the server boots read-only and the setup screen claims the admin.
			// Only an explicit -config that does not exist is worth reporting,
			// and even then we continue rather than refusing to start.
			if !os.IsNotExist(err) {
				return nil, fmt.Errorf("config %s: %w", path, err)
			}
		} else if err := json.Unmarshal(b, c); err != nil {
			return nil, fmt.Errorf("config %s: %w", path, err)
		}
	}
	if err := c.validate(); err != nil {
		return nil, err
	}
	return c, nil
}
