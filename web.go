package main

// web.go — HTTP server: routing, middleware, JSON API handlers, login/logout, UI serving.

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Server struct {
	mu     sync.RWMutex
	cfg    *Config
	rules  []Rule
	sess   *SessionStore
	rl     *RateLimiter
	jobs   *JobHub
	dav    *LockDB
	prefix string // public prefix without slashes, e.g. "gofm"
	cfgPath string // absolute path of config.json, so setup can persist to it
}

func NewServer(cfg *Config, rules []Rule, dataDir string) *Server {
	s := &Server{
		cfg:   cfg,
		rules: rules,
		sess:  NewSessionStore(dataDir),
		rl:    NewRateLimiter(cfg.Rate),
		jobs:  NewJobHub(dataDir),
		dav:   NewLockDB(),
	}
	if cfg.PathPrefix != "" {
		s.prefix = cleanRel(cfg.PathPrefix)[1:] // strip leading /
	}
	return s
}

// SetCfgPath records where config.json lives, so first-run setup and admin
// user management can persist changes without a restart.
func (s *Server) SetCfgPath(p string) { s.cfgPath = p }

func (s *Server) Reload(cfg *Config, rules []Rule) {
	s.mu.Lock()
	defer s.mu.Unlock()
	cfg.validate()
	s.cfg = cfg
	s.rules = rules
	s.rl.cfg = cfg.Rate
}

func (s *Server) cfgR() *Config { s.mu.RLock(); defer s.mu.RUnlock(); return s.cfg }

// per-request context: identity + home jail
type ctx struct {
	w    http.ResponseWriter
	r    *http.Request
	s    *Server
	id   *Identity
	home string
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// prefix auto-detect from proxy header (config path_prefix otherwise)
	publicPrefix := s.cfgR().PathPrefix
	if pf := r.Header.Get("X-Forwarded-Prefix"); pf != "" && s.cfgR().TrustProxy {
		publicPrefix = "/" + strings.Trim(cleanRel(pf), "/")
	}
	publicPrefix = strings.TrimSuffix(cleanRel(publicPrefix), "/") // "" or "/gofm"

	// strip public prefix from path to get app path
	p := r.URL.Path
	if publicPrefix != "" && strings.HasPrefix(p, publicPrefix) {
		p = p[len(publicPrefix):]
	}
	if p == "" {
		p = "/"
	}
	r2 := r.Clone(r.Context())
	r2.URL.Path = p

	// CORS
	cfg := s.cfgR()
	if cfg.EnableCORS {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET,HEAD,PUT,POST,DELETE,PATCH,OPTIONS,PROPFIND,MKCOL,COPY,MOVE,LOCK,UNLOCK")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization,Content-Type,X-CSRF,X-Gofm-Mkdir,Depth,Overwrite,Destination,If,If-Match,If-None-Match,Range,X-Requested-With")
		w.Header().Set("Access-Control-Expose-Headers", "Content-Range,ETag,Accept-Ranges,X-File-Name,X-Upload-ID,X-Dir-Missing")
		w.Header().Set("Access-Control-Max-Age", "86400")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
	}

	// security headers
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Frame-Options", "SAMEORIGIN")
	w.Header().Set("Referrer-Policy", "same-origin")
	w.Header().Set("Content-Security-Policy", "default-src 'self' data: blob:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; font-src 'self' data:; object-src 'self'; frame-src 'self' blob:; child-src 'self' blob:; worker-src 'self' blob:; base-uri 'self'; form-action 'self'")

	// routing
	switch {
	case r2.URL.Path == "/api/login":
		s.hLogin(w, r2)
	case strings.HasPrefix(r2.URL.Path, "/api/"):
		s.hAPI(w, r2)
	case strings.HasPrefix(r2.URL.Path, "/assets/") || r2.URL.Path == "/assets":
		s.serveAsset(w, r2)
	case (r2.URL.Path == "/dav" || r2.URL.Path == "/dav/") && r.Method == http.MethodGet && strings.Contains(r.Header.Get("Accept"), "text/html"):
		target := publicPrefix
		if target != "" && !strings.HasSuffix(target, "/") {
			target += "/"
		} else if target == "" {
			target = "/"
		}
		http.Redirect(w, r, target, http.StatusPermanentRedirect)
	case strings.HasPrefix(r2.URL.Path, "/dav/") || r2.URL.Path == "/dav" || davMethod(r.Method) || r.Header.Get("Translate") == "f" || strings.Contains(strings.ToLower(r.UserAgent()), "webdav") || strings.Contains(strings.ToLower(r.UserAgent()), "rclone") || strings.Contains(strings.ToLower(r.UserAgent()), "cyberduck"):
		s.hDAV(w, r2)
	case strings.HasPrefix(r2.URL.Path, "/f/"):
		s.serveRaw(w, r2, cleanRel(strings.TrimPrefix(r2.URL.Path, "/f")), false)
	default:
		s.serveAppOrRaw(w, r2, publicPrefix)
	}
}

func (s *Server) authed(w http.ResponseWriter, r *http.Request) (*ctx, bool) {
	id, ok := s.Identify(r)
	if !ok {
		http.Error(w, `{"ok":false,"error":{"code":401,"message":"unauthorized"}}`, http.StatusUnauthorized)
		return nil, false
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead && r.Method != http.MethodOptions {
		// A guest may write ONLY where the ACL explicitly grants it (a drop
		// box: "@/Public:ru"). This used to reject every anonymous POST up
		// front, which made anonymous upload impossible no matter what the
		// rules said. The per-endpoint permCap checks still decide what the
		// write may actually do — this only stops the blanket denial.
		if id.User == "" {
			rel := "/"
			if q := r.URL.Query().Get("dir"); q != "" {
				rel = cleanRel(q)
			} else if q := r.URL.Query().Get("path"); q != "" {
				rel = cleanRel(q)
			}
			if !Effective(s.rules, "", rel).Writable() {
				s.deny(w, 401, "login required")
				return nil, false
			}
		} else if !s.csrfOK(r, id) {
			// CSRF applies to cookie-authenticated users. A guest has no
			// session to forge against, and is instead constrained by the ACL
			// plus the same-origin check below.
			s.deny(w, 403, "csrf token invalid")
			return nil, false
		}
		// Guests write without a CSRF token, so every state-changing request
		// must come from our own page or a non-browser client. Without this
		// any page on the internet could push files into a public drop box.
		if id.User == "" && !s.sameOrigin(r) {
			s.deny(w, 403, "cross-origin request denied")
			return nil, false
		}
	}
	c := &ctx{w: w, r: r, s: s, id: id, home: id.Home}
	if c.home == "" {
		c.home = "/"
	}
	// anonymous + auth configured + no anon read on root -> 401 login prompt
	// (matches serveRaw; keeps per-path ACL denials at 403)
	// Anonymous access is decided PER PATH, not once at the root. With a rule
	// like "@/Public:r" the guest could download files but not list the folder,
	// because this used to deny every anonymous request up front. A guest is
	// now allowed through when the requested path is readable, and the
	// per-endpoint perm() checks still decide what they may actually do.
	if id.User == "" && len(s.cfgR().Users) > 0 {
		rel := "/"
		if q := r.URL.Query().Get("dir"); q != "" {
			rel = cleanRel(q)
		} else if q := r.URL.Query().Get("path"); q != "" {
			rel = cleanRel(q)
		} else if strings.HasPrefix(r.URL.Path, "/api/") {
			rel = "/"
		}
		// A guest is refused a directory only when there is nothing under it
		// they can read. A directory that CONTAINS a shared folder is listed
		// with the readable entries only (hList filters the children), which
		// is what lets a visitor browse from the root normally instead of
		// being redirected into a hardcoded path.
		if !Effective(s.rules, "", rel).R && !s.anyReadableUnder(rel) {
			s.deny(w, 401, "login required")
			return nil, false
		}
	}
	return c, true
}

// perm is the read/write shorthand kept for call sites that only care about
// "may I touch this at all". Capability-specific checks use permCap.
// sameOrigin reports whether a guest write came from our own UI. A browser
// always sends Origin on a cross-origin POST; curl and other API clients send
// none, and those are legitimate (WebDAV, scripts), so an absent Origin is
// treated as same-origin.
func (s *Server) sameOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "null" {
		return false
	}
	if origin == "" {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	// compare host:port against the request's own host, and against the
	// configured public prefix host
	if sameHostPort(u.Host, r.Host) {
		return true
	}
	if s.prefix != "" && strings.EqualFold(u.Host, r.Host) {
		return true
	}
	return false
}

// sameHostPort compares two authority strings (host[:port]), defaulting both
// to port 80 when no port is given. Case-insensitive, as hosts are.
func sameHostPort(a, b string) bool {
	norm := func(h string) string {
		if h == "" {
			return ""
		}
		host, port, err := net.SplitHostPort(h)
		if err != nil {
			return strings.ToLower(h) // no port: leave as-is
		}
		if port == "" {
			port = "80"
		}
		return strings.ToLower(host) + ":" + port
	}
	return norm(a) != "" && norm(a) == norm(b)
}

func (s *Server) perm(c *ctx, rel string, write bool) bool {
	if !write {
		return s.permCap(c, rel, CapRead)
	}
	return s.permCap(c, rel, CapWrite)
}

// Capability identifies one permission bit. Upload is deliberately separate
// from write: a shared drop box can accept new files while refusing to
// overwrite or destroy what is already there.
type Capability string

const (
	CapRead   Capability = "read"
	CapUpload Capability = "upload"
	CapWrite  Capability = "write"
	CapDelete Capability = "delete"
)

func (s *Server) permCap(c *ctx, rel string, cap Capability) bool {
	eff := EffectiveWithAdmin(s.rules, c.id.User, jailPath(c.home, rel), s.isAdmin(c))
	switch cap {
	case CapUpload:
		return eff.R && eff.U
	case CapWrite:
		return eff.R && eff.W
	case CapDelete:
		return eff.R && eff.D
	default:
		return eff.R
	}
}

func (s *Server) deny(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": map[string]any{"code": code, "message": msg}})
}

func jOK(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	if v == nil {
		v = map[string]any{"ok": true}
	}
	json.NewEncoder(w).Encode(v)
}

func jFail(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": map[string]any{"code": code, "message": msg}})
}

func (c *ctx) decode(v any) error {
	defer c.r.Body.Close()
	b, err := io.ReadAll(io.LimitReader(c.r.Body, 4<<20))
	if err != nil {
		return err
	}
	return json.Unmarshal(b, v)
}

// ---- login ----
func (s *Server) hLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jFail(w, 405, "POST only")
		return
	}
	var body struct {
		User string `json:"user"`
		Pass string `json:"pass"`
	}
	if json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&body) != nil {
		jFail(w, 400, "bad json")
		return
	}
	key := "web:" + body.User + ":" + clientIP(r)
	if s.rl.Locked(key) {
		jFail(w, 429, "too many attempts, locked temporarily")
		return
	}
	pass, exists := s.cfgR().userPass(body.User)
	// verify even when unknown user to keep timing even
	if exists {
		verify := verifyPass(body.Pass, pass)
		if !verify {
			s.rl.Fail(key)
			time.Sleep(200 * time.Millisecond)
			jFail(w, 401, "invalid credentials")
			return
		}
		s.rl.OK(key)
		sess := s.sess.Create(body.User, s.cfgR().userHome(body.User))
		// rotate: delete old session cookie value if present
		if old, err := r.Cookie(s.cfgR().SessionName); err == nil && old.Value != sess.ID {
			s.sess.Delete(old.Value)
		}
		secure := s.cookieSecure(r)
		http.SetCookie(w, &http.Cookie{
			Name: s.cfgR().SessionName, Value: sess.ID, Path: "/",
			HttpOnly: true, Secure: secure, SameSite: http.SameSiteLaxMode,
			Expires: sess.Expire, MaxAge: int(time.Until(sess.Expire).Seconds()),
		})
		eff := EffectiveWithAdmin(s.rules, sess.User, sess.Home, strings.EqualFold(sess.User, firstUserName(s.cfgR())))
		jOK(w, map[string]any{"ok": true, "me": sess.User, "csrf": sess.CSRF,
			"perms": permsJSON(eff)})
		return
	}
	// unknown user: still burn a verify for timing parity
	_ = verifyPass(body.Pass, "$2a$10$0000000000000000000000000000000000000000000000000000")
	s.rl.Fail(key)
	jFail(w, 401, "invalid credentials")
}

func (s *Server) cookieSecure(r *http.Request) bool {
	cs := s.cfgR().CookieSecure
	if cs == "on" {
		return true
	}
	if cs == "off" {
		return false
	}
	return strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
}

// ---- hAPI: /api/* router ----
func (s *Server) hAPI(w http.ResponseWriter, r *http.Request) {
	p := strings.TrimPrefix(r.URL.Path, "/api/")
	if p == "logout" {
		s.hLogout(w, r)
		return
	}
	if p == "version" {
		jOK(w, map[string]any{"ok": true, "name": AppName, "version": Version})
		return
	}
	if p == "diag" {
		var d struct {
			Msg  string `json:"msg"`
			Src  string `json:"src"`
			Line int    `json:"line"`
			UA   string `json:"ua"`
		}
		_ = json.NewDecoder(io.LimitReader(r.Body, 8192)).Decode(&d)
		log.Printf("[diag] user-agent=%q msg=%q src=%q line=%d", trunc(r.UserAgent(), 60), trunc(d.Msg, 300), trunc(d.Src, 120), d.Line)
		jOK(w, nil)
		return
	}
	if p == "i18n" {
		lang := cleanLang(r.URL.Query().Get("lang"))
		dict, ok := loadI18n(lang)
		if !ok {
			dict, _ = loadI18n("en")
		}
		jOK(w, map[string]any{"ok": true, "lang": lang, "dict": dict})
		return
	}
	if p == "shared" {
		// Public: the client needs this before it can decide whether to show a
		// login screen at all. No auth, no side effects.
		s.hShared(w, r)
		return
	}
	if p == "setup" {
		// Must be handled BEFORE authed(): on a fresh install nobody is logged
		// in and no account exists, so the gate would reject the very request
		// that creates the first one. The handler itself re-checks that no
		// users exist, so this cannot be used to add accounts later.
		if len(s.cfgR().Users) > 0 {
			s.deny(w, 403, "setup already completed")
			return
		}
		s.hSetup(w, r)
		return
	}

	c, ok := s.authed(w, r)
	if !ok {
		return
	}
	cfg := s.cfgR()

	switch p {
	case "users":
		s.hUsers(w, r)
		return
	case "acl":
		s.hACL(w, r)
		return
	case "session":
		eff := EffectiveWithAdmin(s.rules, c.id.User, c.home, s.isAdmin(c))
		/* Anonymous callers get ok:false with an explicit guest flag. Reporting
		   ok:true with an empty "me" made the SPA believe a session existed, so
		   it never entered guest mode and kept polling endpoints it cannot use. */
		if c.id.User == "" {
			// A guest still needs the per-capability allow map, otherwise the
			// client has nothing to gate the upload/new controls on.
			jOK(w, map[string]any{"ok": false, "guest": true, "me": "",
				"perms": permsJSON(eff),
				"setup": len(cfg.Users) == 0,
				"config": map[string]any{
					"theme": cfg.Theme, "lang": cfg.Lang, "version": Version, "app": cfg.AppName, "logo_url": cfg.LogoURL,
					"chunk_bytes": cfg.ChunkBytes, "max_upload_bytes": cfg.MaxUpload,
					"allow": map[string]bool{
						"write": false, "delete": false, "upload": eff.U,
						"edit": eff.W, "chmod": eff.W, "hash": eff.R,
						"urlfetch": eff.U, "archive": eff.R, "extract": eff.W,
						"webdav": eff.R, "search": false,
					},
				}})
			return
		}
		isAdminUser := s.isAdmin(c)
		jOK(w, map[string]any{"ok": true, "me": c.id.User, "csrf": c.id.CSRF,
			"admin": isAdminUser,
			"perms": permsJSON(eff),
			"setup": len(cfg.Users) == 0,
			"config": map[string]any{
				"theme": cfg.Theme, "lang": cfg.Lang, "version": Version, "app": cfg.AppName, "logo_url": cfg.LogoURL,
				"chunk_bytes": cfg.ChunkBytes, "max_upload_bytes": cfg.MaxUpload,
				"allow": map[string]bool{"write": cfg.allowW, "delete": cfg.allowD, "upload": cfg.allowU,
					"urlfetch": cfg.allowURL, "archive": cfg.allowArc, "extract": cfg.allowExt,
					"edit": cfg.allowEdit, "chmod": cfg.allowChmod, "hash": cfg.allowHash,
					"webdav": cfg.allowDAV},
			}})
	case "download":
		q := r.URL.Query()
		p := cleanRel(q.Get("path"))
		if !s.perm(c, p, false) {
			s.deny(w, 403, "no read permission")
			return
		}
		s.serveRaw(w, r, p, q.Get("mode") == "view")
		return
	case "list":
		s.hList(c, r)
	case "stat":
		s.hStat(c, r)
	case "usage":
		// filesystem totals are meaningless on this mount (42P); report the
		// served tree's real size so the storage bar reflects actual usage.
		used, err := dirSize(cfg.Root, 0)
		if err != nil {
			jFail(w, 500, err.Error())
			return
		}
		_, free, ferr := diskUsage(cfg.Root)
		if ferr != nil {
			free = 0
		}
		jOK(w, map[string]any{"ok": true, "total": used + free, "free": free, "used": used})
	case "hash":
		if !cfg.allowHash {
			s.deny(w, 403, "hash disabled")
			return
		}
		q := r.URL.Query()
		rel := cleanRel(q.Get("path"))
		if !s.perm(c, rel, false) {
			s.deny(w, 403, "no read permission")
			return
		}
		abs, err := safeJoin(cfg.Root, jailPath(c.home, rel), cfg.AllowSymlink)
		if err != nil {
			s.deny(w, 403, "path escapes root")
			return
		}
		fi, err := os.Stat(abs)
		if err != nil || fi.IsDir() {
			jFail(w, 404, "file not found")
			return
		}
		h, err := hashFile(abs, q.Get("algo"))
		if err != nil {
			jFail(w, 400, err.Error())
			return
		}
		jOK(w, map[string]any{"ok": true, "hash": h, "algo": q.Get("algo"), "path": rel})
	case "mkdir":
		s.hMkdir(c, r)
	case "create":
		s.hCreate(c, r)
	case "rename":
		s.hRename(c, r)
	case "move":
		s.hMove(c, r)
	case "copy":
		s.hCopy(c, r)
	case "delete":
		s.hDelete(c, r)
	case "save":
		s.hSave(c, r)
	case "chmod":
		s.hChmod(c, r)
	case "upload":
		s.hUpload(c, r)
	case "upload/chunk":
		s.hUploadChunk(c, r)
	case "urlfetch":
		s.hURLFetch(c, r)
	case "archive":
		s.hArchive(c, r)
	case "extract":
		s.hExtract(c, r)
	case "jobs":
		s.hJobs(c, r)
	case "jobs/stream":
		s.hJobsStream(c, r)
	case "jobs/cancel":
		s.hJobCtl(c, r, false)
	case "jobs/retry":
		s.hJobCtl(c, r, true)
	case "pref":
		s.hPref(c, r)
	default:
		jFail(w, 404, "unknown api")
	}
}

func (s *Server) hLogout(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jFail(w, 405, "POST only")
		return
	}
	if ck, err := r.Cookie(s.cfgR().SessionName); err == nil {
		s.sess.Delete(ck.Value)
	}
	http.SetCookie(w, &http.Cookie{Name: s.cfgR().SessionName, Value: "", Path: "/",
		HttpOnly: true, MaxAge: -1, Expires: time.Unix(1, 0)})
	jOK(w, nil)
}

// ---- listing ----
// hSetup claims the first admin account on a fresh install. With no users
// configured the server serves the current directory read-only, and this is
// the only way in. It self-disables as soon as one account exists.
// isAdmin reports whether the caller is the first configured account. The
// first-run claimant is the owner; every account after it is a regular user.
func (s *Server) isAdmin(c *ctx) bool {
	users := s.cfgR().Users
	if len(users) == 0 || c.id.User == "" {
		return false
	}
	return strings.EqualFold(users[0].Name, c.id.User)
}

// ---- admin: users and permissions ----

// hUsers lists accounts, or adds one. Adding is an admin-only action: a guest
// claiming the very first account is hSetup, which is disabled once that
// account exists.
func (s *Server) hUsers(w http.ResponseWriter, r *http.Request) {
	cfg := s.cfgR()
	switch r.Method {
	case http.MethodGet:
		if !s.isAdmin(&ctx{w: w, r: r, s: s, id: mustID(w, r, s)}) {
			s.deny(w, 403, "admin only")
			return
		}
		out := make([]map[string]any, 0, len(cfg.Users))
		superAdmin := firstUserName(cfg)
		for _, u := range cfg.Users {
			if strings.EqualFold(u.Name, superAdmin) {
				continue // SuperAdmin is core account in config.json, excluded from web UI
			}
			out = append(out, map[string]any{
				"name": u.Name, "home": u.Home, "admin": false,
			})
		}
		jOK(w, map[string]any{"ok": true, "users": out, "acl_path": ACLPath(s.cfgPath)})
	case http.MethodPut, http.MethodPatch:
		id := mustID(w, r, s)
		if !s.isAdmin(&ctx{w: w, r: r, s: s, id: id}) {
			s.deny(w, 403, "admin only")
			return
		}
		if !s.csrfOK(r, id) {
			s.deny(w, 403, "csrf token invalid")
			return
		}
		var b struct {
			User string `json:"user"`
			Pass string `json:"pass"`
			Home string `json:"home"`
		}
		raw, err := io.ReadAll(io.LimitReader(r.Body, 8<<10))
		if err != nil || json.Unmarshal(raw, &b) != nil {
			jFail(w, 400, "invalid body")
			return
		}
		b.User = strings.TrimSpace(b.User)
		if b.User == "" {
			jFail(w, 400, "username required")
			return
		}
		if strings.EqualFold(b.User, firstUserName(cfg)) {
			jFail(w, 403, "superadmin is a core account and cannot be modified from the web UI")
			return
		}
		s.mu.Lock()
		found := false
		for i, u := range s.cfg.Users {
			if strings.EqualFold(u.Name, b.User) {
				found = true
				if b.Pass != "" {
					hash, err := HashPass(b.Pass)
					if err != nil {
						s.mu.Unlock()
						jFail(w, 500, "hash failed")
						return
					}
					s.cfg.Users[i].Pass = hash
				}
				if b.Home != "" {
					s.cfg.Users[i].Home = cleanRel(b.Home)
				}
				break
			}
		}
		s.mu.Unlock()
		if !found {
			jFail(w, 404, "no such user")
			return
		}
		if err := SaveConfig(s.cfgPath, s.cfgR()); err != nil {
			jFail(w, 500, "could not save config")
			return
		}
		log.Printf("admin: user %q updated", b.User)
		jOK(w, map[string]any{"ok": true})
	case http.MethodPost:
		id := mustID(w, r, s)
		if !s.isAdmin(&ctx{w: w, r: r, s: s, id: id}) {
			s.deny(w, 403, "admin only")
			return
		}
		if !s.csrfOK(r, id) {
			s.deny(w, 403, "csrf token invalid")
			return
		}
		var b struct {
			User string `json:"user"`
			Pass string `json:"pass"`
			Home string `json:"home"`
		}
		raw, err := io.ReadAll(io.LimitReader(r.Body, 8<<10))
		if err != nil || json.Unmarshal(raw, &b) != nil {
			jFail(w, 400, "invalid body")
			return
		}
		b.User = strings.TrimSpace(b.User)
		if b.User == "" || b.Pass == "" || strings.ContainsAny(b.User, ":/@ \t") {
			jFail(w, 400, "username and password required, and no : / @ or spaces")
			return
		}
		hash, err := HashPass(b.Pass)
		if err != nil {
			jFail(w, 500, "hash failed")
			return
		}
		s.mu.Lock()
		for _, u := range s.cfg.Users {
			if strings.EqualFold(u.Name, b.User) {
				s.mu.Unlock()
				jFail(w, 409, "user already exists")
				return
			}
		}
		home := cleanRel(b.Home)
		if home == "" {
			home = "/"
		}
		s.cfg.Users = append(s.cfg.Users, User{Name: b.User, Pass: hash, Home: home})
		snap := append([]User(nil), s.cfg.Users...)
		s.mu.Unlock()
		if err := SaveConfig(s.cfgPath, cfg); err != nil {
			jFail(w, 500, "could not save config")
			return
		}
		log.Printf("admin: user %q created", b.User)
		jOK(w, map[string]any{"ok": true, "count": len(snap)})
	case http.MethodDelete:
		id := mustID(w, r, s)
		if !s.isAdmin(&ctx{w: w, r: r, s: s, id: id}) {
			s.deny(w, 403, "admin only")
			return
		}
		if !s.csrfOK(r, id) {
			s.deny(w, 403, "csrf token invalid")
			return
		}
		var b struct {
			User string `json:"user"`
		}
		raw, _ := io.ReadAll(io.LimitReader(r.Body, 8<<10))
		_ = json.Unmarshal(raw, &b)
		admin := firstUserName(cfg)
		if strings.EqualFold(strings.TrimSpace(b.User), admin) {
			jFail(w, 403, "the admin account cannot be removed")
			return
		}
		s.mu.Lock()
		kept := s.cfg.Users[:0]
		removed := false
		for _, u := range s.cfg.Users {
			if strings.EqualFold(u.Name, b.User) {
				removed = true
				continue
			}
			kept = append(kept, u)
		}
		s.cfg.Users = kept
		s.mu.Unlock()
		if !removed {
			jFail(w, 404, "no such user")
			return
		}
		if err := SaveConfig(s.cfgPath, cfg); err != nil {
			jFail(w, 500, "could not save config")
			return
		}
		jOK(w, map[string]any{"ok": true})
	default:
		jFail(w, 405, "GET/POST/DELETE")
	}
}

// hShared reports the folder an anonymous visitor may browse, if any. The
// client uses it to decide between a read-only guest view and a login screen,
// so it must be derived from the ACL rather than assuming a name like
// "/Public" — an operator may share "/Shared" or "/downloads" instead.
func (s *Server) hShared(w http.ResponseWriter, r *http.Request) {
	best := ""
	bestDepth := 1 << 30
	for _, rl := range s.rules {
		if rl.User != "" { // named users and "*" are not anonymous
			continue
		}
		if !rl.R {
			continue
		}
		d := len(strings.Split(strings.Trim(rl.Path, "/"), "/"))
		if cleanRel(rl.Path) == "/" {
			d = 0
		}
		if d < bestDepth {
			bestDepth = d
			best = cleanRel(rl.Path)
		}
	}
	// With no rules, public access is disabled — require login
	if best == "" {
		// nothing shared with anonymous visitors
		jOK(w, map[string]any{"ok": true, "dir": nil, "shared": false})
		return
	}
	abs, err := safeJoin(s.cfgR().Root, jailPath("/", best), s.cfgR().AllowSymlink)
	if err != nil {
		jOK(w, map[string]any{"ok": true, "dir": nil, "shared": false})
		return
	}
	if fi, err := os.Stat(abs); err != nil || !fi.IsDir() {
		// the rule points at something that is not there: not a valid share
		jOK(w, map[string]any{"ok": true, "dir": nil, "shared": false})
		return
	}
	jOK(w, map[string]any{"ok": true, "dir": best, "shared": true})
}

func firstUserName(cfg *Config) string {
	if len(cfg.Users) == 0 {
		return ""
	}
	return cfg.Users[0].Name
}

func mustID(w http.ResponseWriter, r *http.Request, s *Server) *Identity {
	id, ok := s.Identify(r)
	if !ok {
		s.deny(w, 401, "login required")
		return &Identity{}
	}
	return id
}

// hACL reads and writes the permission rules (acl.conf).
func (s *Server) hACL(w http.ResponseWriter, r *http.Request) {
	id, ok := s.Identify(r)
	if !ok {
		s.deny(w, 401, "login required")
		return
	}
	cc := &ctx{w: w, r: r, s: s, id: id, home: id.Home}
	if !s.isAdmin(cc) {
		s.deny(w, 403, "admin only")
		return
	}
	p := ACLPath(s.cfgPath)
	if r.Method == http.MethodGet {
		raw, err := os.ReadFile(p)
		if err != nil && !os.IsNotExist(err) {
			jFail(w, 500, err.Error())
			return
		}
		rules, _ := parseRules(strings.Split(string(raw), "\n"))
		outRules := make([]map[string]any, 0, len(rules))
		for _, rl := range rules {
			outRules = append(outRules, map[string]any{
				"user": rl.User,
				"path": rl.Path,
				"r":    rl.R,
				"u":    rl.U,
				"w":    rl.W,
				"d":    rl.D,
			})
		}
		jOK(w, map[string]any{"ok": true, "path": p, "text": string(raw), "rules": outRules})
		return
	}
	if !s.csrfOK(r, id) {
		s.deny(w, 403, "csrf token invalid")
		return
	}
	var b struct {
		Text  string `json:"text"`
		Rules []struct {
			User string `json:"user"`
			Path string `json:"path"`
			R    bool   `json:"r"`
			U    bool   `json:"u"`
			W    bool   `json:"w"`
			D    bool   `json:"d"`
		} `json:"rules"`
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, 64<<10))
	if err != nil || json.Unmarshal(raw, &b) != nil {
		jFail(w, 400, "invalid body")
		return
	}
	var rules []Rule
	if len(b.Rules) > 0 {
		for _, br := range b.Rules {
			u := strings.TrimSpace(br.User)
			if u == "@" {
				u = ""
			}
			rules = append(rules, Rule{
				User: u,
				Path: cleanRel(br.Path),
				Perms: Perms{
					R: br.R,
					U: br.U,
					W: br.W,
					D: br.D,
				},
			})
		}
	} else {
		var err error
		rules, err = parseRules(strings.Split(b.Text, "\n"))
		if err != nil {
			// refuse to install rules we could not parse, so a typo in the UI
			// cannot lock the owner out of their own server
			jFail(w, 400, err.Error())
			return
		}
	}
	if err := WriteRules(p, rules); err != nil {
		jFail(w, 500, err.Error())
		return
	}
	s.mu.Lock()
	s.rules = rules
	s.mu.Unlock()
	log.Printf("admin: acl reloaded (%d rules)", len(rules))
	jOK(w, map[string]any{"ok": true, "count": len(rules)})
}

func (s *Server) hSetup(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jFail(w, 405, "POST required")
		return
	}
	var b struct {
		User string `json:"user"`
		Pass string `json:"pass"`
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, 8<<10))
	if err != nil || json.Unmarshal(raw, &b) != nil {
		jFail(w, 400, "invalid body")
		return
	}
	r.Body.Close()
	b.User = strings.TrimSpace(b.User)
	if b.User == "" || b.Pass == "" {
		jFail(w, 400, "username and password required")
		return
	}
	if strings.ContainsAny(b.User, ":/@ 	") {
		jFail(w, 400, "username may not contain : / @ or spaces")
		return
	}
	hash, err := HashPass(b.Pass)
	if err != nil {
		jFail(w, 500, "hash failed")
		return
	}
	// re-check under the config lock: two racing first-run requests must not
	// both create an admin
	if !s.cfgAddUser(User{Name: b.User, Pass: hash, Home: "/"}) {
		jFail(w, 409, "setup already completed")
		return
	}
	// persist immediately, or the account vanishes on restart
	if s.cfgPath != "" {
		if err := SaveConfig(s.cfgPath, s.cfgR()); err != nil {
			log.Printf("setup: save config: %v", err)
			jFail(w, 500, "could not save config")
			return
		}
	}
	// the claimant gets full control; write it to the acl file so it survives
	// a restart and is visible/editable
	if err := s.writeOwnerRule(b.User); err != nil {
		log.Printf("setup: acl: %v", err)
	}
	log.Printf("setup: admin %q created", b.User)
	jOK(w, map[string]any{"ok": true, "me": b.User})
}

// cfgAddUser appends the first user if none exist yet. Returns false if the
// install is already claimed.
func (s *Server) cfgAddUser(u User) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cfg == nil || len(s.cfg.Users) > 0 {
		return false
	}
	s.cfg.Users = append(s.cfg.Users, u)
	// rebuild the in-memory ACL so the new admin is effective immediately
	if rules, err := parseRules([]string{u.Name + "@/:ruwd"}); err == nil {
		s.rules = append([]Rule{{Path: "/", Perms: Perms{R: true}}}, rules...)
	}
	return true
}

func (s *Server) writeOwnerRule(user string) error {
	p := ACLPath(s.cfgPath)
	if _, err := os.Stat(p); err == nil {
		// an acl file already exists: leave the operator's rules alone
		return nil
	}
	return WriteRules(p, []Rule{
		{Path: "/Public", Perms: Perms{R: true}}, // default public share (superadmin has full bypass)
	})
}

func (s *Server) hList(c *ctx, r *http.Request) {
	cfg := s.cfgR()
	q := r.URL.Query()
	dir := cleanRel(q.Get("dir"))
	/* A guest may LIST a directory when it contains anything they can read,
	   even if the directory itself has no explicit rule. Denying the container
	   outright meant a visitor could not see the root at all, so the shared
	   folder was unreachable without a hardcoded redirect. hList filters the
	   children below, so this cannot leak anything. */
	canReadDir := s.perm(c, dir, false)
	if !canReadDir && c.id.User == "" {
		canReadDir = s.anyReadableUnder(dir)
	}
	if !canReadDir {
		s.deny(c.w, 403, "no read permission")
		return
	}
	hidden := cfg.Hidden
	if q.Get("show_hidden") == "1" {
		hidden = nil
	}
	items, err := c.s.listDir(cfg.Root, c.home, dir, hidden, false, "", 500)
	if err != nil {
		jFail(c.w, map404(err), err.Error())
		return
	}
	if items == nil {
		items = []Item{}
	}
	/* A guest listing a directory sees only the entries they are allowed to
	   read. Previously any folder without an explicit anon rule was refused
	   outright, so a visitor could not see the root at all and had to be
	   redirected into a hardcoded shared path. Filtering means the normal
	   navigation works: root -> the shared folder, with everything else simply
	   absent. */
	if c.id.User == "" {
		kept := items[:0]
		for _, it := range items {
			child := it.Path
			if !s.perm(c, child, false) {
				continue
			}
			kept = append(kept, it)
		}
		items = kept
	}
	sortItems(items, q.Get("sort"), q.Get("asc") != "0")
	eff := EffectiveWithAdmin(s.rules, c.id.User, jailPath(c.home, dir), s.isAdmin(c))
	/* For a guest on a container they can only traverse (the root, when only a
	   nested folder is shared), the effective perms are all-false: they are not
	   granted anything AT this path. But the UI needs read=true to show the
	   listing and enable breadcrumbs, and it must not claim upload/write. Grant
	   read only, and let the per-entry check decide what is actually visible. */
	containerOnly := !eff.R && c.id.User == "" && len(items) > 0
	if containerOnly {
		eff.R = true
	}
	par, _ := path.Split(dir)
	jOK(c.w, map[string]any{"ok": true, "dir": dir, "parent": cleanRel(par), "items": items,
		"user": c.id.User, "perms": permsJSON(eff),
		"allow": map[string]bool{"write": cfg.allowW && eff.W, "delete": cfg.allowD && eff.D,
		"upload": cfg.allowU && eff.U, "edit": cfg.allowEdit && eff.W, "archive": cfg.allowArc && eff.R,
		"extract": cfg.allowExt && eff.W, "urlfetch": cfg.allowURL && eff.U}})
}

// anyReadableUnder reports whether a guest can read anything beneath dir.
// It is what allows the root to be listed (and shown filtered) when only a
// nested folder such as /Public is shared.
func (s *Server) anyReadableUnder(dir string) bool {
	base := cleanRel(dir)
	for _, rl := range s.rules {
		if rl.User != "" || !rl.R {
			continue
		}
		if pathHasPrefix(cleanRel(rl.Path), base) {
			return true
		}
	}
	return false
}

func map404(err error) int {
	if os.IsNotExist(err) || err != nil && strings.Contains(err.Error(), "not a directory") {
		return 404
	}
	return 500
}

// ---- stat ----
func (s *Server) hStat(c *ctx, r *http.Request) {
	cfg := s.cfgR()
	rel := cleanRel(r.URL.Query().Get("path"))
	if !s.perm(c, rel, false) {
		s.deny(c.w, 403, "no read permission")
		return
	}
	abs, err := safeJoin(cfg.Root, jailPath(c.home, rel), cfg.AllowSymlink)
	if err != nil {
		s.deny(c.w, 403, "path escapes root")
		return
	}
	it := c.s.infoItem(cfg.Root, abs, rel)
	if it.Name == "" && rel == "/" {
		it = Item{Name: "/", Path: "/", IsDir: true}
	}
	if it.Name == "" {
		jFail(c.w, 404, "not found")
		return
	}
	jOK(c.w, map[string]any{"ok": true, "item": it})
}

// ---- write handlers ----
type pathBody struct {
	Dir  string   `json:"dir"`
	Name string   `json:"name"`
	Path string   `json:"path"`
	From string   `json:"from"`
	To   string   `json:"to"`
	Items []string `json:"items"`
	Content string `json:"content"`
	Backup bool    `json:"backup"`
	Mode string    `json:"mode"`
	Archive string `json:"archive"`
	Kind string    `json:"kind"`
	URL  string    `json:"url"`
	Pref string    `json:"pref"`
}

// canWrite is the "may I create something here" gate used by upload, mkdir,
// create, archive and extract. It needs the UPLOAD bit plus the global
// allow.write switch. It previously required the global allow.upload switch
// together with the W bit, which meant a drop-box rule (@/path:ru) could never
// actually receive a file: the ACL said yes and the handler said no.
func (s *Server) canWrite(c *ctx, rel string) bool {
	cfg := s.cfgR()
	return cfg.allowU && cfg.allowW && s.permCap(c, rel, CapUpload)
}

func (s *Server) resolveW(c *ctx, rel string) (string, bool) {
	abs, err := safeJoin(s.cfgR().Root, jailPath(c.home, rel), s.cfgR().AllowSymlink)
	if err != nil {
		s.deny(c.w, 403, "path escapes root")
		return "", false
	}
	return abs, true
}

func (s *Server) hMkdir(c *ctx, r *http.Request) {
	var b pathBody
	if c.decode(&b) != nil || b.Name == "" {
		jFail(c.w, 400, "name required")
		return
	}
	if !validName(b.Name) {
		jFail(c.w, 400, "invalid name")
		return
	}
	dir := cleanRel(b.Dir)
	if !s.canWrite(c, dir) {
		s.deny(c.w, 403, "no write permission")
		return
	}
	target := cleanRel(dir + "/" + b.Name)
	if existsOr(s.cfgR().Root, c.home, target) {
		jFail(c.w, 409, "exists")
		return
	}
	if err := s.fsMkdir(s.cfgR().Root, jailPath(c.home, target)); err != nil {
		jFail(c.w, 500, err.Error())
		return
	}
	s.audit(c, "mkdir", target, "")
	jOK(c.w, map[string]any{"ok": true, "path": target})
}

func (s *Server) hCreate(c *ctx, r *http.Request) {
	var b pathBody
	if c.decode(&b) != nil || b.Name == "" {
		jFail(c.w, 400, "name required")
		return
	}
	if !validName(b.Name) {
		jFail(c.w, 400, "invalid name")
		return
	}
	dir := cleanRel(b.Dir)
	if !s.canWrite(c, dir) {
		s.deny(c.w, 403, "no write permission")
		return
	}
	if extDenied(b.Name, s.cfgR().DenyExt) {
		jFail(c.w, 403, "extension denied")
		return
	}
	target := cleanRel(dir + "/" + b.Name)
	abs, ok := s.resolveW(c, target)
	if !ok {
		return
	}
	if exists(abs) {
		jFail(c.w, 409, "exists")
		return
	}
	if err := writeFileAtomic(abs, []byte(b.Content)); err != nil {
		jFail(c.w, 500, err.Error())
		return
	}
	s.audit(c, "create", target, "")
	jOK(c.w, map[string]any{"ok": true, "path": target})
}

func (s *Server) hRename(c *ctx, r *http.Request) {
	var b pathBody
	if c.decode(&b) != nil || b.From == "" {
		jFail(c.w, 400, "from required")
		return
	}
	if b.Name == "" && b.To != "" {
		b.Name = path.Base(b.To)
	}
	if b.Name == "" {
		jFail(c.w, 400, "from+name required")
		return
	}
	if !validName(b.Name) {
		jFail(c.w, 400, "invalid name")
		return
	}
	from := cleanRel(b.From)
	if !s.permCap(c, from, CapWrite) || !s.permCap(c, path.Dir(from), CapWrite) {
		s.deny(c.w, 403, "no write permission")
		return
	}
	if extDenied(b.Name, s.cfgR().DenyExt) {
		jFail(c.w, 403, "extension denied")
		return
	}
	target := cleanRel(path.Dir(from) + "/" + b.Name)
	absFrom, ok := s.resolveW(c, from)
	if !ok {
		return
	}
	absTo, ok := s.resolveW(c, target)
	if !ok {
		return
	}
	if !exists(absFrom) {
		jFail(c.w, 404, "not found")
		return
	}
	if exists(absTo) {
		jFail(c.w, 409, "exists")
		return
	}
	if err := movePath(absFrom, absTo); err != nil {
		jFail(c.w, 500, err.Error())
		return
	}
	s.audit(c, "rename", from, target)
	jOK(c.w, map[string]any{"ok": true, "path": target})
}

func (s *Server) hMove(c *ctx, r *http.Request) {
	s.transfer(c, r, true)
}
func (s *Server) hCopy(c *ctx, r *http.Request) {
	s.transfer(c, r, false)
}

func (s *Server) transfer(c *ctx, r *http.Request, isMove bool) {
	var b pathBody
	if c.decode(&b) != nil || len(b.Items) == 0 || b.To == "" {
		jFail(c.w, 400, "items+to required")
		return
	}
	to := cleanRel(b.To)
	// The destination gains a NEW path: that is an upload right, not a write
	// right. A drop-box rule (ru) can therefore receive files but not have
	// things relocated into it.
	if !s.permCap(c, to, CapUpload) {
		s.deny(c.w, 403, "no upload permission at destination")
		return
	}
	type fail struct {
		Item   string `json:"item"`
		Reason string `json:"reason"`
	}
	var done, failed []any
	for _, it := range b.Items {
		it = cleanRel(it)
		if it == "/" {
			failed = append(failed, fail{it, "cannot operate on root"})
			continue
		}
		if pathHasPrefix(to, it) {
			actionName := "move"
			if !isMove { actionName = "copy" }
			failed = append(failed, fail{it, "cannot " + actionName + " into itself"})
			continue
		}
		absSrc, ok := s.resolveW(c, it)
		if !ok {
			// A single unresolvable item must not silently discard the rest
			// of the batch: record it and carry on.
			failed = append(failed, fail{it, "path not permitted"})
			continue
		}
		if !exists(absSrc) {
			failed = append(failed, fail{it, "not found"})
			continue
		}
		// copy needs only read at the source; move also removes it there,
		// which is a write (never granted by an upload-only rule)
		if isMove && !s.permCap(c, it, CapWrite) {
			failed = append(failed, fail{it, "no write permission at source"})
			continue
		}
		if !isMove && !s.perm(c, it, false) {
			failed = append(failed, fail{it, "no read permission"})
			continue
		}
		if isMove && path.Dir(it) == to {
			// rename-in-place still allowed when Name given via hRename; here just skip same-dir
			failed = append(failed, fail{it, "same directory"})
			continue
		}
		name := path.Base(it)
		targetRel := cleanRel(to + "/" + name)
		absDst, ok := s.resolveW(c, targetRel)
		if !ok {
			failed = append(failed, fail{it, "destination path not permitted"})
			continue
		}
		st, err := os.Lstat(absSrc)
		if err == nil && !st.IsDir() && extDenied(name, s.cfgR().DenyExt) {
			failed = append(failed, fail{it, "extension denied"})
			continue
		}
		if exists(absDst) {
			if st.IsDir() {
				failed = append(failed, fail{it, "target dir exists"})
				continue
			}
			absDst = filepath.Join(filepath.Dir(absDst), collisionName(filepath.Dir(absDst), path.Base(absDst)))
		}
		if isMove {
			if err := movePath(absSrc, absDst); err != nil {
				failed = append(failed, fail{it, err.Error()})
				continue
			}
			s.audit(c, "move", it, relOf(s.cfgR().Root, absDst))
		} else {
			if st.IsDir() || st.Mode()&os.ModeSymlink != 0 {
				if err := copyTree(absSrc, absDst); err != nil {
					_ = os.RemoveAll(absDst)
					failed = append(failed, fail{it, err.Error()})
					continue
				}
			} else if _, err := copyFile(absSrc, absDst); err != nil {
				failed = append(failed, fail{it, err.Error()})
				continue
			}
			s.audit(c, "copy", it, relOf(s.cfgR().Root, absDst))
		}
		done = append(done, relOf(s.cfgR().Root, absDst))
	}
	if len(done) == 0 && len(failed) > 0 {
		c.w.WriteHeader(http.StatusBadRequest)
	}
	jOK(c.w, map[string]any{"ok": len(failed) == 0, "done": done, "failed": failed})
}

func (s *Server) hDelete(c *ctx, r *http.Request) {
	var b pathBody
	if c.decode(&b) != nil || len(b.Items) == 0 {
		jFail(c.w, 400, "items required")
		return
	}
	cfg := s.cfgR()
	if !cfg.allowD {
		s.deny(c.w, 403, "delete disabled")
		return
	}
	type fail struct {
		Item   string `json:"item"`
		Reason string `json:"reason"`
	}
	var done, failed []any
	for _, it := range b.Items {
		it = cleanRel(it)
		if it == "/" {
			failed = append(failed, fail{it, "cannot delete root"})
			continue
		}
		if !s.permCap(c, it, CapDelete) {
			failed = append(failed, fail{it, "no write permission"})
			continue
		}
		abs, ok := s.resolveW(c, it)
		if !ok {
			failed = append(failed, fail{it, "path not permitted"})
			continue
		}
		if !exists(abs) {
			failed = append(failed, fail{it, "not found"})
			continue
		}
		if err := deletePath(abs); err != nil {
			failed = append(failed, fail{it, err.Error()})
			continue
		}
		s.audit(c, "delete", it, "")
		done = append(done, it)
	}
	if len(done) == 0 && len(failed) > 0 {
		c.w.WriteHeader(http.StatusBadRequest)
	}
	jOK(c.w, map[string]any{"ok": len(failed) == 0, "done": done, "failed": failed})
}

func (s *Server) hSave(c *ctx, r *http.Request) {
	var b pathBody
	if c.decode(&b) != nil || b.Path == "" {
		jFail(c.w, 400, "path required")
		return
	}
	cfg := s.cfgR()
	if !cfg.allowEdit {
		s.deny(c.w, 403, "edit disabled")
		return
	}
	rel := cleanRel(b.Path)
	if !s.permCap(c, rel, CapWrite) {
		s.deny(c.w, 403, "no write permission")
		return
	}
	if int64(len(b.Content)) > cfg.MaxUpload {
		jFail(c.w, 400, "content too large")
		return
	}
	abs, ok := s.resolveW(c, rel)
	if !ok {
		return
	}
	fi, err := os.Stat(abs)
	if err != nil {
		jFail(c.w, 404, "not found")
		return
	}
	if fi.IsDir() {
		jFail(c.w, 400, "is a directory")
		return
	}
	if im := r.Header.Get("If-Match"); im != "" && im != etagOf(fi) {
		jFail(c.w, 412, "etag mismatch — file changed")
		return
	}
	bakName := ""
	if b.Backup && cfg.EnableBackup {
		if n, err := backupFile(cfg.Root, abs, cfg.BackupCopies); err == nil {
			bakName = n
		}
	}
	if err := writeFileAtomic(abs, []byte(b.Content)); err != nil {
		jFail(c.w, 500, err.Error())
		return
	}
	s.audit(c, "save", rel, bakName)
	newFi, _ := os.Stat(abs)
	newEtag := ""
	if newFi != nil {
		newEtag = etagOf(newFi)
	}
	jOK(c.w, map[string]any{"ok": true, "etag": newEtag, "backup": bakName, "size": len(b.Content), "path": rel})
}

func (s *Server) hChmod(c *ctx, r *http.Request) {
	var b pathBody
	if c.decode(&b) != nil || b.Path == "" || b.Mode == "" {
		jFail(c.w, 400, "path+mode required")
		return
	}
	cfg := s.cfgR()
	if !cfg.allowChmod {
		s.deny(c.w, 403, "chmod disabled")
		return
	}
	rel := cleanRel(b.Path)
	if !s.permCap(c, rel, CapWrite) {
		s.deny(c.w, 403, "no write permission")
		return
	}
	m, err := strconv.ParseUint(strings.TrimPrefix(b.Mode, "0"), 8, 32)
	if err != nil {
		jFail(c.w, 400, "bad mode")
		return
	}
	abs, ok := s.resolveW(c, rel)
	if !ok {
		return
	}
	if !exists(abs) {
		jFail(c.w, 404, "not found")
		return
	}
	if err := setMode(abs, os.FileMode(m)); err != nil {
		jFail(c.w, 500, err.Error())
		return
	}
	s.audit(c, "chmod", rel, fmt.Sprintf("%04o", m))
	jOK(c.w, map[string]any{"ok": true, "mode": fmt.Sprintf("%04o", m)})
}

func (s *Server) hPref(c *ctx, r *http.Request) {
	var b struct {
		Theme   string `json:"theme"`
		Lang    string `json:"lang"`
		Density string `json:"density"`
		Hidden  *bool  `json:"show_hidden"`
	}
	if c.decode(&b) != nil {
		jFail(c.w, 400, "bad json")
		return
	}
	st := loadRuntimeState(s.dataDir())
	st.UI = map[string]string{"theme": b.Theme, "lang": b.Lang, "density": b.Density}
	saveRuntimeState(s.dataDir(), st)
	jOK(c.w, nil)
}

func (s *Server) dataDir() string { return s.jobs.dir }

func (s *Server) audit(c *ctx, op, path, extra string) {
	cfg := s.cfgR()
	if cfg.AuditLog == nil || !*cfg.AuditLog {
		return
	}
	st := loadRuntimeState(s.dataDir())
	line := RuntimeAudit{Time: time.Now().Format(time.RFC3339), User: c.id.User, Op: op, Path: path, Extra: extra, IP: clientIP(c.r)}
	st.Audit = append(st.Audit, line)
	if len(st.Audit) > 2000 {
		st.Audit = st.Audit[len(st.Audit)-2000:]
	}
	saveRuntimeState(s.dataDir(), st)
	log.Printf("[audit] user=%s op=%s path=%q extra=%q ip=%s", line.User, line.Op, line.Path, line.Extra, line.IP)
}

// ---- helpers ----
func validName(n string) bool {
	if n == "" || n == "." || n == ".." || len(n) > 255 {
		return false
	}
	if strings.ContainsAny(n, "/\x00") {
		return false
	}
	if strings.ContainsRune(n, os.PathSeparator) && os.PathSeparator != '/' {
		return false
	}
	return true
}

func existsOr(root, home, rel string) bool {
	abs, err := safeJoin(root, jailPath(home, rel), false)
	if err != nil {
		return false
	}
	return exists(abs)
}

func trunc(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

func cleanLang(l string) string {
	l = strings.ToLower(strings.TrimSpace(l))
	if l == "" || len(l) > 8 {
		return "en"
	}
	if i := strings.IndexAny(l, "-_ "); i >= 0 {
		l = l[:i]
	}
	if l == "" {
		return "en"
	}
	for _, ch := range l {
		if ch < 'a' || ch > 'z' {
			return "en"
		}
	}
	return l
}

func davMethod(m string) bool {
	switch m {
	case "PROPFIND", "MKCOL", "COPY", "MOVE", "LOCK", "UNLOCK", "PROPPATCH", "PUT":
		return true
	}
	return false
}


// PERMSJSON is the permission payload the SPA reads to decide which controls to
// show. Upload is reported separately from write so a read-only folder hides
// the upload button instead of offering an action that 403s.
func permsJSON(p Perms) map[string]bool {
	// "write" is a convenience for the client, but it must mean the actual w
	// bit. Reporting Writable() (u||w) made a read+upload drop box look like it
	// could modify existing files, and the UI then offered actions that 403.
	return map[string]bool{
		"r": p.R, "u": p.U, "w": p.W, "d": p.D,
		"read": p.R, "write": p.W,
	}
}
