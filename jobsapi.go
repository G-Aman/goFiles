package main

// jobsapi.go — HTTP handlers for jobs/archive/extract endpoints + SSE stream + i18n loader.

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
)

func (s *Server) hArchive(c *ctx, r *http.Request) {
	cfg := s.cfgR()
	if !cfg.allowArc {
		s.deny(c.w, 403, "archive disabled")
		return
	}
	var b struct {
		Items []string `json:"items"`
		Kind  string   `json:"kind"`
		Dir   string   `json:"dir"`
		Name  string   `json:"target_name"`
	}
	if c.decode(&b) != nil || len(b.Items) == 0 {
		jFail(c.w, 400, "items required")
		return
	}
	kind := b.Kind
	if kind == "" {
		kind = "zip"
	}
	switch kind {
	case "zip", "tar", "targz", "tar.gz":
		if kind == "tar.gz" {
			kind = "targz"
		}
	default:
		jFail(c.w, 400, "bad kind")
		return
	}
	dir := cleanRel(b.Dir)
	for _, it := range b.Items {
		if !s.perm(c, cleanRel(it), false) {
			s.deny(c.w, 403, "no read permission on "+it)
			return
		}
	}
	if !s.canWrite(c, dir) {
		s.deny(c.w, 403, "no write permission to target dir")
		return
	}
	root := cfg.Root
	home := c.home
	items := b.Items
	k, n, d := kind, b.Name, dir
	job := s.jobs.Start("archive", n, func(ctx context.Context, j *Job) error {
		outRel, err := s.archiveItems(ctx, j, root, jailItems(home, items), k, jailPath(home, d), n)
		if err != nil {
			return err
		}
		j.Result = unJail(home, outRel)
		return nil
	})
	jOK(c.w, map[string]any{"ok": true, "job_id": job.ID})
}

func jailItems(home string, items []string) []string {
	out := make([]string, len(items))
	for i, it := range items {
		out[i] = jailPath(home, cleanRel(it))
	}
	return out
}

func (s *Server) hExtract(c *ctx, r *http.Request) {
	cfg := s.cfgR()
	if !cfg.allowExt {
		s.deny(c.w, 403, "extract disabled")
		return
	}
	var b struct {
		Archive string `json:"archive"`
		To      string `json:"to"`     // "same" or dir rel path
		Unique  bool   `json:"unique"` // true → <name>/ subfolder
	}
	if c.decode(&b) != nil || b.Archive == "" {
		jFail(c.w, 400, "archive required")
		return
	}
	relA := cleanRel(b.Archive)
	if !s.perm(c, relA, false) {
		s.deny(c.w, 403, "no read permission")
		return
	}
	ext := strings.ToLower(path.Ext(relA))
	if ext != ".zip" && ext != ".tar" && ext != ".gz" && !strings.HasSuffix(strings.ToLower(relA), ".tgz") {
		jFail(c.w, 400, "unsupported archive type")
		return
	}
	to := path.Dir(relA)
	if b.To != "" && !strings.EqualFold(strings.TrimSpace(b.To), "same") {
		to = cleanRel(b.To)
	}
	if !s.canWrite(c, to) {
		s.deny(c.w, 403, "no write permission to target")
		return
	}
	absA, ok := s.resolveW(c, relA)
	if !ok {
		return
	}
	if !isFileAbs(absA) {
		jFail(c.w, 404, "archive not found")
		return
	}
	root := cfg.Root
	home := c.home
	absTo, err := safeJoin(root, jailPath(home, to), false)
	if err != nil {
		s.deny(c.w, 403, "path escapes root")
		return
	}
	uniq := b.Unique
	name := path.Base(relA)
	job := s.jobs.Start("extract", name, func(ctx context.Context, j *Job) error {
		return s.extractArchive(ctx, j, absA, absTo, uniq)
	})
	jOK(c.w, map[string]any{"ok": true, "job_id": job.ID})
}

func isFileAbs(p string) bool {
	fi, err := os.Stat(p)
	return err == nil && fi.Mode().IsRegular()
}

func (s *Server) activeOrRecentJobs() []JobView {
	all := s.jobs.List()
	out := make([]JobView, 0, len(all))
	now := time.Now()
	for _, j := range all {
		isLive := j.State == "active" || j.State == "running" || j.State == "queued" || j.State == "paused"
		if isLive {
			out = append(out, j)
		} else if !j.Updated.IsZero() && now.Sub(j.Updated) < 10*time.Second {
			out = append(out, j)
		}
	}
	return out
}

func (s *Server) hJobs(c *ctx, r *http.Request) {
	jobs := s.activeOrRecentJobs()
	jOK(c.w, map[string]any{"ok": true, "jobs": jobs})
}

func (s *Server) hJobsStream(c *ctx, r *http.Request) {
	w := c.w
	flusher, ok := w.(http.Flusher)
	if !ok {
		jFail(w, 500, "stream unsupported")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	ch, unsub := s.jobs.Sub()
	defer unsub()
	// initial snapshot of active / fresh jobs only
	for _, j := range s.activeOrRecentJobs() {
		b, _ := json.Marshal(j)
		fmt.Fprintf(w, "event: job\ndata: %s\n\n", b)
	}
	flusher.Flush()
	keep := time.NewTicker(25 * time.Second)
	defer keep.Stop()
	for {
		select {
		case <-c.r.Context().Done():
			return
		case msg := <-ch:
			fmt.Fprintf(w, "event: job\ndata: %s\n\n", msg)
			flusher.Flush()
		case <-keep.C:
			fmt.Fprint(w, ": keep-alive\n\n")
			flusher.Flush()
		}
	}
}

func (s *Server) hJobCtl(c *ctx, r *http.Request, retry bool) {
	var b struct {
		ID string `json:"id"`
	}
	if c.decode(&b) != nil || b.ID == "" {
		jFail(c.w, 400, "id required")
		return
	}
	if retry {
		j := s.jobs.Get(b.ID)
		if j == nil {
			jFail(c.w, 404, "no such job")
			return
		}
		if j.State != "error" && j.State != "canceled" {
			jFail(c.w, 400, "job not in failed state")
			return
		}
		// relaunch same type with stored params: urlfetch only (archives/extract params not stored)
		if j.Type == "urlfetch" {
			cfg := s.cfgR()
			home := c.home
			dir := path.Dir(j.Result)
			if j.Result == "" {
				dir = "/"
			}
			job := s.jobs.Start("urlfetch", j.Name, func(ctx context.Context, nj *Job) error {
				return fmt.Errorf("retry requires original url; not stored")
			})
			_ = cfg
			_ = home
			_ = dir
			jOK(c.w, map[string]any{"ok": true, "job_id": job.ID, "note": "retry requires re-submit url"})
			return
		}
		jFail(c.w, 400, "retry not supported for "+j.Type)
		return
	}
	if !s.jobs.Cancel(b.ID) {
		jFail(c.w, 400, "cannot cancel")
		return
	}
	jOK(c.w, nil)
}

// ---- i18n ----
func loadI18n(lang string) (map[string]string, bool) {
	p := "ui/i18n/" + lang + ".json"
	b, err := fs.ReadFile(uiFS, p)
	if err != nil {
		return nil, false
	}
	d := map[string]string{}
	if json.Unmarshal(b, &d) != nil {
		return nil, false
	}
	return d, true
}

// i18nFileFromAssetsOverride checks the --assets dir override for i18n/<lang>.json first.
func (s *Server) i18nFile(lang string) (map[string]string, bool) {
	if as := s.cfgR().Assets; as != "" {
		if b, err := os.ReadFile(filepath.Join(as, "i18n", lang+".json")); err == nil {
			d := map[string]string{}
			if json.Unmarshal(b, &d) == nil {
				return d, true
			}
		}
	}
	return loadI18n(lang)
}

var _ = io.ReadAll
