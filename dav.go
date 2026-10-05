package main

// dav.go — WebDAV: OPTIONS/PROPFIND/GET/HEAD/PUT/MKCOL/DELETE/COPY/MOVE/LOCK/UNLOCK.

import (
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type LockDB struct {
	mu    sync.Mutex
	locks map[string]*lockEntry
}
type lockEntry struct {
	token  string
	owner  string
	path   string
	expire time.Time
	depth  string
}

func NewLockDB() *LockDB { return &LockDB{locks: map[string]*lockEntry{}} }

func (s *Server) hDAV(w http.ResponseWriter, r *http.Request) {
	cfg := s.cfgR()
	if !cfg.allowDAV {
		http.Error(w, "WebDAV disabled", http.StatusForbidden)
		return
	}
	id, ok := s.Identify(r)
	if !ok {
		w.Header().Set("WWW-Authenticate", `Basic realm="`+AppName+`"`)
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	home := id.Home
	if home == "" {
		home = "/"
	}
	rel := strings.TrimPrefix(cleanRel(r.URL.Path), "/dav")
	rel = cleanRel(rel)

	// A guest is allowed over DAV only where the ACL grants it, and only for
	// verbs it may perform. This used to reject every anonymous DAV request
	// outright, which made a public drop box unreachable from any WebDAV
	// client. The per-verb davPerm checks below remain the real gate.
	if id.User == "" {
		need := "r"
		switch r.Method {
		case http.MethodPut, "MKCOL", "COPY", "MOVE":
			// creating something new needs the upload bit
			need = "u"
		case http.MethodDelete:
			need = "d"
		}
		if !s.davPerm(id, home, rel, need) {
			w.Header().Set("WWW-Authenticate", `Basic realm="`+AppName+`"`)
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
	}

	if r.Method == http.MethodOptions {
		w.Header().Set("DAV", "1, 2")
		w.Header().Set("MS-Author-Via", "DAV")
		w.Header().Set("Allow", "OPTIONS,GET,HEAD,PUT,DELETE,MKCOL,COPY,MOVE,PROPFIND,LOCK,UNLOCK")
		w.WriteHeader(http.StatusOK)
		return
	}

	abs, err := safeJoin(cfg.Root, jailPath(home, rel), cfg.AllowSymlink)
	if err != nil {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	if !s.permCtx(id, home, rel, false) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}

	switch r.Method {
	case "PROPFIND":
		s.davPropfind(w, r, id, home, rel, abs)
	case http.MethodGet, http.MethodHead:
		fi, err := os.Stat(abs)
		if err != nil {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		if fi.IsDir() {
			http.Error(w, "collection (browse via app)", http.StatusNotFound)
			return
		}
		etag := etagOf(fi)
		w.Header().Set("ETag", etag)
		w.Header().Set("Last-Modified", fi.ModTime().UTC().Format(http.TimeFormat))
		if inm := r.Header.Get("If-None-Match"); inm != "" && strings.Trim(inm, " W/") == etag {
			w.WriteHeader(http.StatusNotModified)
			return
		}
		http.ServeFile(w, r, abs)
	case http.MethodPut:
		// PUT creates OR replaces. A new file only needs the upload bit (so a
		// drop box works from a WebDAV client), but replacing something that
		// already exists additionally needs write — otherwise a guest could
		// silently clobber the contents of a shared folder.
		if !s.canUploadCtx(id, home, rel) || !cfg.allowU {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		if exists(abs) && (!s.canWriteCtx(id, home, rel) || !cfg.allowW) {
			http.Error(w, "forbidden (cannot replace an existing file)", http.StatusForbidden)
			return
		}
		if !s.lockedOK(r, rel) {
			http.Error(w, "resource locked", http.StatusLocked)
			return
		}
		s.davPut(w, r, abs, cfg)
	case "MKCOL":
		if !s.canUploadCtx(id, home, rel) || !cfg.allowU || rel == "/" {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		if exists(abs) {
			http.Error(w, "exists", http.StatusMethodNotAllowed)
			return
		}
		if err := os.MkdirAll(abs, 0o755); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusCreated)
	case http.MethodDelete:
		if !s.canDeleteCtx(id, home, rel) || !cfg.allowD {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		if rel == "/" {
			http.Error(w, "cannot delete root", http.StatusForbidden)
			return
		}
		if !exists(abs) {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		if err := deletePath(abs); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	case "COPY", "MOVE":
		s.davCopyMove(w, r, id, home, rel, r.Method == "MOVE")
	case "LOCK":
		if !s.canWriteCtx(id, home, rel) || !cfg.allowW {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		s.davLock(w, r, id, home, rel)
	case "UNLOCK":
		s.davUnlock(w, r, rel)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// canWriteCtx is the shorthand for "may create or modify". Call sites that
// create a new path use canUploadCtx; removing a path uses canDeleteCtx.
func (s *Server) canWriteCtx(id *Identity, home, rel string) bool {
	return s.davPerm(id, home, rel, "w")
}

func (s *Server) canUploadCtx(id *Identity, home, rel string) bool {
	return s.davPerm(id, home, rel, "u")
}

func (s *Server) canDeleteCtx(id *Identity, home, rel string) bool {
	return s.davPerm(id, home, rel, "d")
}

func (s *Server) davPerm(id *Identity, home, rel, bit string) bool {
	eff := EffectiveWithAdmin(s.rules, id.User, jailPath(home, rel), id.User != "" && strings.EqualFold(id.User, firstUserName(s.cfgR())))
	switch bit {
	case "r":
		return eff.R
	case "u":
		return eff.R && eff.U
	case "w":
		return eff.R && eff.W
	case "d":
		return eff.R && eff.D
	default:
		return eff.R && eff.W
	}
}

// lockedOK enforces DAV class-1 locks: if a lock exists on rel (or any parent dir),
// mutating requests must present its token in the If header.
func (s *Server) lockedOK(r *http.Request, rel string) bool {
	ifH := r.Header.Get("If")
	s.dav.mu.Lock()
	var toks []string
	var active *lockEntry
	for pth := rel; ; {
		if lk, okk := s.dav.locks[pth]; okk && time.Now().Before(lk.expire) {
			toks = append(toks, lk.token)
			if active == nil {
				active = lk
			}
		}
		parent := path.Dir(strings.TrimSuffix(pth, "/"))
		if parent == pth || parent == "." || parent == "/" {
			break
		}
		pth = parent
	}
	s.dav.mu.Unlock()
	if active == nil {
		return true
	}
	if ifH == "" {
		return false
	}
	for _, t := range toks {
		if strings.Contains(ifH, t) || strings.Contains(ifH, strings.TrimPrefix(t, "opaquelocktoken:")) {
			return true
		}
	}
	return false
}

func (s *Server) davPut(w http.ResponseWriter, r *http.Request, abs string, cfg *Config) {
	if fi, err := os.Stat(abs); err == nil && fi.IsDir() {
		http.Error(w, "is a directory", http.StatusMethodNotAllowed)
		return
	}
	if im := r.Header.Get("If-Match"); im != "" {
		if fi, err := os.Stat(abs); err == nil && etagOf(fi) != im {
			http.Error(w, "etag mismatch", http.StatusPreconditionFailed)
			return
		}
	}
	if cfg.MaxUpload > 0 && r.ContentLength > cfg.MaxUpload {
		http.Error(w, "too large", http.StatusRequestEntityTooLarge)
		return
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	created := !exists(abs)
	tmp := abs + ".gofm-tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	var n int64
	if cfg.MaxUpload > 0 {
		n, err = io.Copy(f, io.LimitReader(r.Body, cfg.MaxUpload+1))
		if err == nil && n > cfg.MaxUpload {
			err = fmt.Errorf("too large")
		}
	} else {
		n, err = io.Copy(f, r.Body)
	}
	_ = n
	f.Close()
	if err != nil {
		os.Remove(tmp)
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err := os.Rename(tmp, abs); err != nil {
		os.Remove(tmp)
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if created {
		w.WriteHeader(http.StatusCreated)
	} else {
		w.WriteHeader(http.StatusNoContent)
	}
}

func davDestPath(r *http.Request) (string, error) {
	dest := r.Header.Get("Destination")
	if dest == "" {
		return "", fmt.Errorf("Destination header required")
	}
	if i := strings.Index(dest, "://"); i >= 0 {
		rest := dest[i+3:]
		if j := strings.IndexByte(rest, '/'); j >= 0 {
			dest = rest[j:]
		} else {
			dest = "/"
		}
	}
	// strip proxy public prefix (e.g. /gofm) if present
	if pf := strings.Trim(r.Header.Get("X-Forwarded-Prefix"), "/"); pf != "" {
		dest = strings.TrimPrefix(dest, "/"+pf)
	}
	// strip /dav marker
	if i := strings.Index(dest, "/dav"); i == 0 {
		dest = dest[4:]
	}
	// strip public prefix from absolute Destination (same-origin)
	if cfg := r.Context().Value(davCfgKey{}); cfg != nil {
		if pref, ok := cfg.(string); ok && pref != "" {
			dest = strings.TrimPrefix(dest, "/"+pref)
		}
	}
	dest = cleanRel(dest)
	dest = strings.TrimPrefix(dest, "/dav")
	if unesc, uerr := url.PathUnescape(dest); uerr == nil {
		dest = unesc
	}
	return cleanRel(dest), nil
}

type davCfgKey struct{}

func (s *Server) davCopyMove(w http.ResponseWriter, r *http.Request, id *Identity, home, rel string, isMove bool) {
	cfg := s.cfgR()
	// The destination gains a NEW path, so the destination check is an upload
	// check. A MOVE additionally removes the source, so it needs write/delete
	// rights on the source too — a drop box may receive, never relocate.
	srcCap := s.canUploadCtx(id, home, rel)
	if isMove {
		srcCap = srcCap && s.canWriteCtx(id, home, rel)
	}
	if !srcCap || !cfg.allowW {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	targetRel, err := davDestPath(r)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if targetRel == "/" || rel == "/" {
		http.Error(w, "bad destination", http.StatusBadRequest)
		return
	}
	if !s.canUploadCtx(id, home, targetRel) {
		http.Error(w, "forbidden destination", http.StatusForbidden)
		return
	}
	if pathHasPrefix(targetRel, rel) {
		http.Error(w, "destination under source", http.StatusConflict)
		return
	}
	if isMove && targetRel == rel {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	absSrc, err := safeJoin(cfg.Root, jailPath(home, rel), cfg.AllowSymlink)
	if err != nil {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	absDst, err := safeJoin(cfg.Root, jailPath(home, targetRel), cfg.AllowSymlink)
	if err != nil {
		http.Error(w, "forbidden destination", http.StatusForbidden)
		return
	}
	fi, err := os.Stat(absSrc)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	dstExists := exists(absDst)
	if dstExists && r.Header.Get("Overwrite") == "F" {
		http.Error(w, "target exists (Overwrite:F)", http.StatusPreconditionFailed)
		return
	}
	if dstExists {
		if fi.IsDir() {
			http.Error(w, "target collection exists", http.StatusConflict)
			return
		}
		if err := deletePath(absDst); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	}
	if isMove {
		if err := movePath(absSrc, absDst); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if fi.IsDir() {
		if err := copyTree(absSrc, absDst); err != nil {
			os.RemoveAll(absDst)
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	} else {
		if _, err := copyFile(absSrc, absDst); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	}
	if dstExists {
		w.WriteHeader(http.StatusNoContent)
	} else {
		w.WriteHeader(http.StatusCreated)
	}
}

func (s *Server) davLock(w http.ResponseWriter, r *http.Request, id *Identity, home, rel string) {
	b, _ := io.ReadAll(io.LimitReader(r.Body, 1<<16))
	body := string(b)
	owner := ""
	if i := strings.Index(body, "<owner>"); i >= 0 {
		rest := body[i+7:]
		if j := strings.Index(rest, "</owner>"); j >= 0 {
			owner = strings.TrimSpace(rest[:j])
		}
	} else if i := strings.Index(body, "<D:owner>"); i >= 0 {
		rest := body[i+9:]
		if j := strings.Index(rest, "</D:owner>"); j >= 0 {
			owner = strings.TrimSpace(rest[:j])
		}
	}
	if len(owner) > 128 {
		owner = owner[:128]
	}
	depth := r.Header.Get("Depth")
	if depth == "" {
		depth = "infinity"
	}
	token := "opaquelocktoken:" + randHex(12)
	s.dav.mu.Lock()
	now := time.Now()
	for k, v := range s.dav.locks {
		if v.expire.Before(now) {
			delete(s.dav.locks, k)
		}
	}
	s.dav.locks[rel] = &lockEntry{token: token, owner: owner, path: rel, expire: now.Add(5 * time.Minute), depth: depth}
	s.dav.mu.Unlock()
	w.Header().Set("Lock-Token", "<"+token+">")
	w.Header().Set("Content-Type", "application/xml; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	fmt.Fprintf(w, `<?xml version="1.0" encoding="utf-8"?>
<d:prop xmlns:d="DAV:"><d:lockdiscovery><d:activelock>
<d:locktype><d:write/></d:locktype><d:lockscope><d:exclusive/></d:lockscope>
<d:depth>%s</d:depth><d:owner>%s</d:owner>
<d:timeout>Second-300</d:timeout><d:locktoken><d:href>%s</d:href></d:locktoken>
</d:activelock></d:lockdiscovery></d:prop>`, depth, xmlEscape(owner), token)
}

func (s *Server) davUnlock(w http.ResponseWriter, r *http.Request, rel string) {
	token := strings.Trim(r.Header.Get("Lock-Token"), "<> ")
	s.dav.mu.Lock()
	lk := s.dav.locks[rel]
	deleted := false
	if lk != nil && token != "" && (lk.token == token || lk.token == "opaquelocktoken:"+token) {
		delete(s.dav.locks, rel)
		deleted = true
	}
	s.dav.mu.Unlock()
	if !deleted {
		http.Error(w, "invalid lock token", http.StatusForbidden)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func xmlEscape(s string) string {
	var b strings.Builder
	for _, c := range s {
		switch c {
		case '&':
			b.WriteString("&amp;")
		case '<':
			b.WriteString("&lt;")
		case '>':
			b.WriteString("&gt;")
		case '"':
			b.WriteString("&quot;")
		default:
			b.WriteRune(c)
		}
	}
	return b.String()
}

// davHrefPrefix rebuilds the public URL prefix for hrefs from the original request.
func davHrefPrefix(r *http.Request, cfg *Config) string {
	pf := "/"
	if xfp := r.Header.Get("X-Forwarded-Prefix"); xfp != "" && cfg.TrustProxy {
		pf = xfp
	} else if cfg.PathPrefix != "" {
		pf = cleanRel(cfg.PathPrefix)
	}
	pf = strings.TrimSuffix(cleanRel(pf), "/") // "" or /gofm
	// did the request go through /dav? detect from original full path
	full := r.URL.EscapedPath()
	if strings.Contains(full, "/dav") {
		return pf + "/dav"
	}
	return pf
}

func (s *Server) davPropfind(w http.ResponseWriter, r *http.Request, id *Identity, home, rel string, abs string) {
	cfg := s.cfgR()
	depth := strings.ToLower(r.Header.Get("Depth"))
	if depth == "" {
		depth = "infinity"
	}
	base := davHrefPrefix(r, cfg)

	type ent struct {
		rel  string
		abs  string
		st   os.FileInfo
		dir  bool
	}
	var ents []ent
	self, err := os.Stat(abs)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	ents = append(ents, ent{rel, abs, self, self.IsDir()})

	collect := func(childAbs string, st os.FileInfo) {
		relP := unJail(home, relOf(cfg.Root, childAbs))
		if !s.permCtx(id, home, relP, false) {
			return
		}
		ents = append(ents, ent{relP, childAbs, st, st.IsDir()})
	}

	if self.IsDir() && depth != "0" {
		if depth == "1" {
			des, err := os.ReadDir(abs)
			if err == nil {
				for _, e := range des {
					if isHidden(e.Name(), cfg.Hidden) {
						continue
					}
					st, err := e.Info()
					if err != nil {
						continue
					}
					collect(filepath.Join(abs, e.Name()), st)
				}
			}
		} else {
			filepath.Walk(abs, func(p string, st os.FileInfo, err error) error {
				if err != nil || p == abs {
					return nil
				}
				if isHidden(path.Base(p), cfg.Hidden) {
					if st.IsDir() {
						return filepath.SkipDir
					}
					return nil
				}
				collect(p, st)
				return nil
			})
		}
	}

	w.Header().Set("Content-Type", "application/xml; charset=utf-8")
	w.WriteHeader(207)
	io.WriteString(w, `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:s="http://apache.org/dav/prop/1.0/">`)
	for _, e := range ents {
		href := base + davEncodePath(home, e.rel)
		if !strings.HasSuffix(href, "/") {
			href += "/"
		}
		if !e.dir {
			href = strings.TrimSuffix(href, "/")
		}
		fmt.Fprintf(w, "<d:response><d:href>%s</d:href><d:propstat><d:prop>", xmlEscape(href))
		fmt.Fprintf(w, "<d:displayname>%s</d:displayname>", xmlEscape(e.st.Name()))
		if e.dir {
			fmt.Fprint(w, "<d:resourcetype><d:collection/></d:resourcetype>")
			fmt.Fprint(w, "<d:getcontentlength>0</d:getcontentlength>")
		} else {
			fmt.Fprint(w, "<d:resourcetype/>")
			fmt.Fprintf(w, "<d:getcontentlength>%d</d:getcontentlength>", e.st.Size())
			fmt.Fprintf(w, "<d:getcontenttype>%s</d:getcontenttype>", xmlEscape(mimeByName(e.st.Name(), e.abs)))
			fmt.Fprintf(w, "<d:getetag>%s</d:getetag>", xmlEscape(etagOf(e.st)))
		}
		fmt.Fprintf(w, "<d:getlastmodified>%s</d:getlastmodified>", e.st.ModTime().UTC().Format(http.TimeFormat))
		fmt.Fprintf(w, "<d:creationdate>%s</d:creationdate>", e.st.ModTime().UTC().Format(time.RFC3339))
		fmt.Fprint(w, "<d:supportedlock><d:lockentry><d:lockscope><d:exclusive/></d:lockscope><d:locktype><d:write/></d:locktype></d:lockentry></d:supportedlock>")
		s.dav.mu.Lock()
		lk := s.dav.locks[e.rel]
		s.dav.mu.Unlock()
		if lk != nil && lk.expire.After(time.Now()) {
			fmt.Fprintf(w, `<d:lockdiscovery><d:activelock><d:locktype><d:write/></d:locktype><d:lockscope><d:exclusive/></d:lockscope><d:depth>%s</d:depth><d:owner>%s</d:owner><d:timeout>Second-300</d:timeout><d:locktoken><d:href>%s</d:href></d:locktoken></d:activelock></d:lockdiscovery>`,
				lk.depth, xmlEscape(lk.owner), xmlEscape(lk.token))
		} else {
			fmt.Fprint(w, "<d:lockdiscovery/>")
		}
		fmt.Fprint(w, "</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>")
	}
	io.WriteString(w, "</d:multistatus>")
}

// davEncodePath percent-encodes jail-mapped rel path for href.
func davEncodePath(home, rel string) string {
	internal := jailPath(home, rel)
	internal = cleanRel(internal)
	if internal == "/" {
		return "/"
	}
	parts := strings.Split(strings.Trim(internal, "/"), "/")
	for i, p := range parts {
		parts[i] = url.PathEscape(p)
	}
	return "/" + strings.Join(parts, "/")
}
