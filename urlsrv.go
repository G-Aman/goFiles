package main

// urlsrv.go — urlfetch job handler + raw file serving (Range/ETag) + static assets + app shell.

import (
	"bytes"
	"strconv"
	"context"
	"encoding/json"
	"fmt"
	"html"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
)

// ---- URL fetch (server-side downloader) ----
func (s *Server) hURLFetch(c *ctx, r *http.Request) {
	cfg := s.cfgR()
	if !cfg.allowURL {
		s.deny(c.w, 403, "url fetch disabled")
		return
	}
	var b struct {
		URL string `json:"url"`
		Dir string `json:"dir"`
	}
	if c.decode(&b) != nil || b.URL == "" {
		jFail(c.w, 400, "url required")
		return
	}
	u, err := url.Parse(b.URL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
		jFail(c.w, 400, `{"ok":false}`+"\nInvalid url parameter")
		return
	}
	host := u.Hostname()
	if ips, err := net.DefaultResolver.LookupIPAddr(r.Context(), host); err == nil {
		for _, ip := range ips {
			if isPrivateIP(ip.IP.String()) && !cfg.AllowPrivateURLFetch {
				jFail(c.w, 403, "refusing private/link-local target")
				return
			}
		}
	} else {
		jFail(c.w, 400, "cannot resolve host")
		return
	}
	dir := cleanRel(b.Dir)
	if !s.canWrite(c, dir) {
		s.deny(c.w, 403, "no write permission")
		return
	}
	name := path.Base(u.Path)
	if name == "/" || name == "." || name == "" || !validName(name) {
		name = fmt.Sprintf("download-%d", time.Now().Unix())
	}
	if extDenied(name, cfg.DenyExt) {
		jFail(c.w, 403, "extension denied")
		return
	}
	home := c.home
	root := cfg.Root
	job := s.jobs.Start("urlfetch", name, func(ctx context.Context, j *Job) error {
		return s.runURLFetch(ctx, j, root, home, dir, name, u.String())
	})
	jOK(c.w, map[string]any{"ok": true, "job_id": job.ID})
}

func isPrivateIP(s string) bool {
	ip := net.ParseIP(s)
	if ip == nil {
		return true
	}
	return ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() ||
		ip.IsLinkLocalMulticast() || ip.IsUnspecified()
}

func (s *Server) runURLFetch(ctx context.Context, j *Job, root, home, dir, name, rawurl string) error {
	relTarget := cleanRel(dir + "/" + name)
	client := &http.Client{Timeout: 30 * time.Minute, Transport: &http.Transport{
		ResponseHeaderTimeout: time.Duration(s.cfgR().ResponseHeaderTimeout) * time.Second,
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			// re-block private at dial time (DNS rebinding guard)
			host, _, _ := net.SplitHostPort(addr)
			if s.cfgR().TrustProxy || true {
				if ip := net.ParseIP(host); ip != nil && !s.cfgR().AllowPrivateURLFetch {
					if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsUnspecified() {
						return nil, fmt.Errorf("blocked private address")
					}
				}
			}
			var d net.Dialer
			return d.DialContext(ctx, network, addr)
		},
	}}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawurl, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", AppName+"/"+Version)
	// Stall watchdog. Without a response-header timeout a server that accepts
	// the connection and then never speaks leaves the job "running" forever
	// with done=0 — exactly the endless spinner. ResponseHeaderTimeout bounds
	// that first wait; a stalled body is bounded by the per-read deadline below.
	stall := time.Duration(s.cfgR().StallTimeout) * time.Second
	if stall <= 0 {
		stall = 30 * time.Second
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("remote status %d", resp.StatusCode)
	}
	// every Read must make progress within `stall`, otherwise the job errors
	// with a reason instead of spinning forever
	body := &stallReader{r: resp.Body, stall: stall}
	cfg := s.cfgR()
	var total int64 = -1
	if cl := resp.Header.Get("Content-Length"); cl != "" {
		total, _ = strconv.ParseInt(cl, 10, 64)
	}
	// collision rename
	for {
		abs, err := safeJoin(root, jailPath(home, relTarget), false)
		if err != nil {
			return err
		}
		// The destination folder may not exist yet (a URL fetch into a new
		// directory). Without this the open below failed with a bare
		// "no such file or directory" that the UI never surfaced.
		if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
			return fmt.Errorf("cannot create %s: %v", filepath.Dir(relTarget), err)
		}
		if !exists(abs) {
			tmp := abs + ".gofm-tmp"
			f, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
			if err != nil {
				return err
			}
			buf := make([]byte, 64*1024)
			var n int64
			for {
				if ctx.Err() != nil {
					f.Close()
					os.Remove(tmp)
					return ctx.Err()
				}
				rd, err := body.Read(buf)
				if rd > 0 {
					if _, werr := f.Write(buf[:rd]); werr != nil {
						f.Close()
						os.Remove(tmp)
						return werr
					}
					n += int64(rd)
					j.Progress(int64(rd), total)
					if cfg.MaxUpload > 0 && n > cfg.MaxUpload {
						f.Close()
						os.Remove(tmp)
						return fmt.Errorf("exceeds max upload size")
					}
				}
				if err == io.EOF {
					break
				}
				if err != nil {
					f.Close()
					os.Remove(tmp)
					return err
				}
			}
			f.Close()
			if err := os.Rename(tmp, abs); err != nil {
				os.Remove(tmp)
				return err
			}
			j.Result = relTarget
			j.set(func(j *Job) {})
			return nil
		}
		nn := collisionName(filepath.Dir(filepath.Join(root, jailPath(home, relTarget))), path.Base(relTarget))
		if nn == path.Base(relTarget) {
			return fmt.Errorf("name collision")
		}
		relTarget = cleanRel(dir + "/" + nn)
		name = nn
	}
}

// ---- raw serving (GET /f/... ) ----
func (s *Server) serveRaw(w http.ResponseWriter, r *http.Request, rel string, inline bool) {
	cfg := s.cfgR()
	id, ok := s.Identify(r)
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if id.User == "" && len(cfg.Users) > 0 {
		// anonymous only if anon rules grant read
		eff := Effective(s.rules, "", jailPath("/", rel))
		if !eff.R {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
	}
	home := "/"
	if id.User != "" {
		home = id.Home
		if home == "" {
			home = "/"
		}
	}
	if !s.permCtx(id, home, rel, false) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	abs, err := safeJoin(cfg.Root, jailPath(home, rel), cfg.AllowSymlink)
	if err != nil {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	fi, err := os.Stat(abs)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if fi.IsDir() {
		http.Error(w, "not a file", http.StatusNotFound)
		return
	}
	if isHidden(path.Base(abs), cfg.Hidden) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	ext := path.Base(abs)
	mime := mimeByName(ext, abs)
	dispo := "inline"
	q := r.URL.Query()
	// Active content served from our own origin is a stored-XSS primitive:
	// an uploaded .html (or .svg with script) would run with the app's session
	// cookie and same-origin API access. Never render these inline — download
	// them instead, and sandbox the response for good measure.
		baseMime := strings.TrimSpace(strings.Split(mime, ";")[0])
	active := baseMime == "text/html" || baseMime == "application/xhtml+xml" || baseMime == "image/svg+xml" || baseMime == "text/xml" || baseMime == "application/xml" || strings.Contains(mime, "javascript")
	if mime == "text/html" || active {
		dispo = "attachment"
	} else if q.Get("dl") == "1" || (!inline && !viewable(mime)) {
		dispo = "attachment"
	}
	w.Header().Set("Content-Type", mime)
	w.Header().Set("ETag", etagOf(fi)) // ServeContent honors If-None-Match w/ this
	if active {
		w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:")
		w.Header().Set("X-Content-Type-Options", "nosniff")
	}
	// RFC 5987/6266 utf-8 filename
	name := path.Base(rel)
	asciiFallback := sanitizeASCII(name)
	w.Header().Set("Content-Disposition", fmt.Sprintf(`%s; filename="%s"; filename*=UTF-8''%s`, dispo, asciiFallback, url.PathEscape(name)))
	// http.ServeFile applies path-based redirects: any request URL ending in
	// "/index.html" gets a 301 -> "./", which then 404s through the SPA
	// fallback (or loops forever if we rewrite r.URL). ServeContent does the
	// same Range/ETag/304 work with no path inspection, so every filename —
	// index.html included — is served verbatim.
	f, err := os.Open(abs)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	defer f.Close()
	http.ServeContent(w, r, name, fi.ModTime(), f)
}

func viewable(m string) bool {
	return strings.HasPrefix(m, "text/") || strings.HasPrefix(m, "image/") ||
		strings.HasPrefix(m, "video/") || strings.HasPrefix(m, "audio/") || m == "application/pdf"
}

func sanitizeASCII(s string) string {
	var b []byte
	for i := 0; i < len(s); i++ {
		ch := s[i]
		if ch >= 0x20 && ch < 0x7f && ch != '"' && ch != '\\' {
			b = append(b, ch)
		} else {
			b = append(b, '?')
		}
	}
	if len(b) == 0 {
		return "file"
	}
	return string(b)
}

// permCtx is the read gate for raw file serving (/f/... and bare paths).
// Serving is inherently read-only, so only the r bit applies here.
func (s *Server) permCtx(id *Identity, home, rel string, write bool) bool {
	isSuperAdmin := id != nil && id.User != "" && strings.EqualFold(id.User, firstUserName(s.cfgR()))
	eff := EffectiveWithAdmin(s.rules, id.User, jailPath(home, rel), isSuperAdmin)
	return eff.R
}

// ---- assets (embedded UI + vendor) ----
func (s *Server) serveAsset(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(r.URL.Path, "/assets/")
	// ace loader asks /assets/ace/<file> — map same vendor dir as flat /assets/<file>
	if strings.HasPrefix(name, "ace/") {
		name = strings.TrimPrefix(name, "ace/")
	}
	// pdf.js ships as an ES module + worker under the same flat namespace
	if strings.HasPrefix(name, "pdfjs/") {
		name = strings.TrimPrefix(name, "pdfjs/")
	}
	if name == "" || strings.Contains(name, "..") {
		http.NotFound(w, r)
		return
	}
	// assets override dir (partial allowed: per-file fallback)
	if as := s.cfgR().Assets; as != "" {
		for _, sub := range []string{"", "js/", "i18n/", "vendor/ace/"} {
			fp := filepath.Join(as, sub, filepath.Clean("/"+name))
			if fi, err := os.Stat(fp); err == nil && !fi.IsDir() {
				w.Header().Set("Cache-Control", "no-cache, must-revalidate")
				http.ServeFile(w, r, fp)
				return
			}
		}
	}
	data, mime, ok := embeddedAsset(name)
	if !ok {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", mime)
	w.Header().Set("Cache-Control", "no-cache, must-revalidate")
	http.ServeContent(w, r, name, time.Time{}, bytes.NewReader(data))
}

// ---- app shell serving + index modes ----
func (s *Server) serveAppOrRaw(w http.ResponseWriter, r *http.Request, publicPrefix string) {
	cfg := s.cfgR()
	p := cleanRel(r.URL.Path)
	// /f was handled separately; here: "/" (app) or a raw path like /any/dir/file.png
	if p == "/" {
		// index modes
		absRoot := cfg.Root
		switch cfg.IndexMode {
		case "index", "try-index":
			if exists(filepath.Join(absRoot, "index.html")) {
				s.serveRaw(w, r, "/index.html", true)
				return
			}
		}
		s.serveShell(w, r, publicPrefix)
		return
	}
	// maybe a directory or file requested directly
	abs, err := safeJoin(cfg.Root, p, cfg.AllowSymlink)
	if err != nil {
		s.serveShell(w, r, publicPrefix) // SPA fallback for unknown paths
		return
	}
	fi, err := os.Stat(abs)
	if err != nil {
		s.serveShell(w, r, publicPrefix) // unknown → app (hash-router will show not-found)
		return
	}
	if fi.IsDir() {
		switch cfg.IndexMode {
		case "index":
			if exists(filepath.Join(abs, "index.html")) {
				s.serveRaw(w, r, cleanRel(p+"/index.html"), true)
				return
			}
			http.NotFound(w, r)
		case "try-index":
			if exists(filepath.Join(abs, "index.html")) {
				s.serveRaw(w, r, cleanRel(p+"/index.html"), true)
				return
			}
			s.serveShell(w, r, publicPrefix)
		case "spa":
			s.serveShell(w, r, publicPrefix)
		default:
			s.serveShell(w, r, publicPrefix)
		}
		return
	}
	// a bare file URL: serve inline raw
	s.serveRaw(w, r, p, true)
}

func (s *Server) serveShell(w http.ResponseWriter, r *http.Request, publicPrefix string) {
	cfg := s.cfgR()
	appName := cfg.AppName
	if appName == "" {
		appName = AppName
	}
	pageHTML := assetUIIndex()
	pageHTML = strings.ReplaceAll(pageHTML, "__PREFIX__", publicPrefix)
	pageHTML = strings.ReplaceAll(pageHTML, "<title>goFiles</title>", "<title>" + html.EscapeString(appName) + "</title>")
	pageHTML = strings.ReplaceAll(pageHTML, ">goFiles</h1>", ">" + html.EscapeString(appName) + "</h1>")
	pageHTML = strings.ReplaceAll(pageHTML, ">goFiles</span>", ">" + html.EscapeString(appName) + "</span>")
	boot := map[string]any{
		"app": appName, "logo_url": cfg.LogoURL, "version": Version, "prefix": publicPrefix,
		"config": map[string]any{
			"theme": cfg.Theme, "lang": cfg.Lang, "version": Version, "app": appName, "logo_url": cfg.LogoURL,
			"chunk_bytes": cfg.ChunkBytes, "max_upload_bytes": cfg.MaxUpload,
			"allow": map[string]bool{
				"write": cfg.allowW, "delete": cfg.allowD, "upload": cfg.allowU,
				"urlfetch": cfg.allowURL, "archive": cfg.allowArc, "extract": cfg.allowExt,
				"edit": cfg.allowEdit, "chmod": cfg.allowChmod, "hash": cfg.allowHash,
				"webdav": cfg.allowDAV,
			},
		},
	}
	// Determine default public share directory if available
	sharedDir := ""
	for _, rl := range s.rules {
		if rl.User == "" && rl.R {
			sharedDir = cleanRel(rl.Path)
			break
		}
	}
	if sharedDir != "" {
		boot["shared"] = true
		boot["shared_dir"] = sharedDir
	}

	if id, ok := s.Identify(r); ok && id.User != "" {
		// A Basic-auth client that already sent a valid session cookie reuses
		// it. Minting one per page load (polling, rclone mounts, crawlers)
		// grew state/sessions without bound.
		if id.Sess == nil {
			if ck, cerr := r.Cookie(s.cfgR().SessionName); cerr == nil && ck.Value != "" {
				if ex := s.sess.Get(ck.Value); ex != nil && ex.User == id.User {
					id.CSRF = ex.CSRF
					id.Sess = ex
				}
			}
		}
		if id.Sess == nil {
			sess := s.sess.Create(id.User, id.Home)
			id.CSRF = sess.CSRF
			id.Sess = sess
			secure := s.cookieSecure(r)
			http.SetCookie(w, &http.Cookie{
				Name:     s.cfgR().SessionName,
				Value:    sess.ID,
				Path:     "/",
				HttpOnly: true,
				Secure:   secure,
				SameSite: http.SameSiteLaxMode,
				Expires:  sess.Expire,
				MaxAge:   int(time.Until(sess.Expire).Seconds()),
			})
		}
		boot["me"] = id.User
		boot["admin"] = strings.EqualFold(id.User, firstUserName(cfg))
		boot["csrf"] = id.CSRF
		boot["perms"] = func() map[string]bool {
			eff := Effective(s.rules, id.User, func() string { if id.Home == "" { return "/" }; return id.Home }())
			return permsJSON(eff)
		}()
	}
	if b, err := json.Marshal(boot); err == nil {
		pageHTML = strings.ReplaceAll(pageHTML, "__BOOT__", string(b))
		pageHTML = strings.ReplaceAll(pageHTML, "</title>", "</title>\n<script>window.GOFM_BOOT="+string(b)+";window.GOFM_PREFIX="+strconv.Quote(publicPrefix)+";</script>")
	}
	dict, _ := loadI18n("en")
	if b, err := json.Marshal(dict); err == nil {
		pageHTML = strings.ReplaceAll(pageHTML, "__I18N__", string(b))
	} else {
		pageHTML = strings.ReplaceAll(pageHTML, "__I18N__", "{}")
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	io.WriteString(w, pageHTML)
}

// stallReader fails a read that makes no progress within d, so a hung remote
// server ends the job with a reason instead of leaving it "running" forever.
type stallReader struct {
	r     io.Reader
	stall time.Duration
}

func (s *stallReader) Read(p []byte) (int, error) {
	type res struct {
		n   int
		err error
	}
	ch := make(chan res, 1)
	go func() {
		n, err := s.r.Read(p)
		ch <- res{n, err}
	}()
	select {
	case v := <-ch:
		return v.n, v.err
	case <-time.After(s.stall):
		return 0, fmt.Errorf("stalled: no data for %s", s.stall)
	}
}
