package main

// upload.go — stream single upload + resumable chunked multipart upload.

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strconv"
)

// POST /api/upload?path=/rel/dir/file.txt  (body = raw stream)
func (s *Server) hUpload(c *ctx, r *http.Request) {
	cfg := s.cfgR()
	if !cfg.allowU {
		s.deny(c.w, 403, "upload disabled")
		return
	}
	target := cleanRel(r.URL.Query().Get("path"))
	if target == "/" || target == "" {
		jFail(c.w, 400, "path must include file name")
		return
	}
	name := path.Base(target)
	dir := path.Dir(target)
	if !validName(name) {
		jFail(c.w, 400, "invalid name")
		return
	}
	if !s.canWrite(c, dir) {
		s.deny(c.w, 403, "no write permission")
		return
	}
	if extDenied(name, cfg.DenyExt) {
		jFail(c.w, 403, "extension denied")
		return
	}
	if cfg.MaxUpload > 0 && r.ContentLength > cfg.MaxUpload {
		jFail(c.w, 400, "too large")
		return
	}
	if free := checkFree(cfg); free {
		jFail(c.w, 507, "insufficient disk space")
		return
	}
	// collision auto-rename
	targetFull := target
	for {
		abs, ok := s.resolveW(c, targetFull)
		if !ok {
			return
		}
		if !exists(abs) {
			if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
				jFail(c.w, 500, err.Error())
				return
			}
			tmp := abs + ".gofm-tmp"
			f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
			if err != nil {
				jFail(c.w, 500, err.Error())
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
				jFail(c.w, 500, err.Error())
				return
			}
			if err := os.Rename(tmp, abs); err != nil {
				os.Remove(tmp)
				jFail(c.w, 500, err.Error())
				return
			}
			s.audit(c, "upload", targetFull, strconv.FormatInt(n, 10))
			jOK(c.w, map[string]any{"ok": true, "path": targetFull, "size": n})
			return
		}
		// exists: auto-rename file part
		newName := collisionName(filepath.Dir(abs), name)
		if newName == name {
			jFail(c.w, 409, "exists")
			return
		}
		targetFull = cleanRel(dir + "/" + newName)
		name = newName
	}
}

// POST /api/upload/chunk multipart fields: upload_id, index, total, size, name, dir, file
func (s *Server) hUploadChunk(c *ctx, r *http.Request) {
	cfg := s.cfgR()
	if !cfg.allowU {
		s.deny(c.w, 403, "upload disabled")
		return
	}
	if err := r.ParseMultipartForm(1 << 24); err != nil {
		jFail(c.w, 400, "bad multipart: " + err.Error())
		return
	}
	upID := safeID(r.FormValue("upload_id"))
	idx, _ := strconv.Atoi(r.FormValue("index"))
	total, _ := strconv.Atoi(r.FormValue("total"))
	size, _ := strconv.ParseInt(r.FormValue("size"), 10, 64)
	name := r.FormValue("name")
	dirS := r.FormValue("dir")
	if dirS == "" {
		dirS = r.FormValue("path")
		if path.Base(dirS) == name {
			dirS = path.Dir(dirS)
		}
	}
	dir := cleanRel(dirS)
	if upID == "" || name == "" || total <= 0 || idx < 0 || idx >= total {
		jFail(c.w, 400, "missing fields")
		return
	}
	if int64(total)*cfg.ChunkBytes+cfg.ChunkBytes < size {
		jFail(c.w, 400, "chunk count too small for size")
		return
	}
	if cfg.MaxUpload > 0 && size > cfg.MaxUpload {
		jFail(c.w, 400, "too large")
		return
	}
	if !validName(name) {
		jFail(c.w, 400, "invalid name")
		return
	}
	if !s.canWrite(c, dir) {
		s.deny(c.w, 403, "no write permission")
		return
	}
	cdir := filepath.Join(s.jobs.tmpDir(), upID)
	if err := os.MkdirAll(cdir, 0o700); err != nil {
		jFail(c.w, 500, err.Error())
		return
	}
	fh, hdr, err := r.FormFile("file")
	if err != nil {
		jFail(c.w, 400, "file part required")
		return
	}
	defer fh.Close()
	_ = hdr
	cfile := filepath.Join(cdir, strconv.Itoa(idx))
	out, err := os.OpenFile(cfile, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		jFail(c.w, 500, err.Error())
		return
	}
	got, err := io.Copy(out, io.LimitReader(fh, cfg.ChunkBytes+1))
	out.Close()
	if got == 0 && size > 0 {
		jFail(c.w, 400, "empty chunk")
		return
	}
	if err != nil {
		jFail(c.w, 500, err.Error())
		return
	}
	// write meta
	metaPath := filepath.Join(cdir, "meta.json")
	_ = os.WriteFile(metaPath, []byte(fmt.Sprintf(`{"name":%q,"dir":%q,"total":%d,"size":%d}`, name, dir, total, size)), 0o600)
	// all chunks present?
	all := true
	for i := 0; i < total; i++ {
		if !exists(filepath.Join(cdir, strconv.Itoa(i))) {
			all = false
			break
		}
	}
	if !all {
		jOK(c.w, map[string]any{"ok": true, "received": idx, "total": total})
		return
	}
	// assemble
	targetFull := cleanRel(dir + "/" + name)
	abs, ok := s.resolveW(c, targetFull)
	if !ok {
		return
	}
	if exists(abs) {
		newName := collisionName(filepath.Dir(abs), name)
		targetFull = cleanRel(dir + "/" + newName)
		abs, ok = s.resolveW(c, targetFull)
		if !ok {
			return
		}
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		jFail(c.w, 500, err.Error())
		return
	}
	tmp := abs + ".gofm-tmp"
	dst, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		jFail(c.w, 500, err.Error())
		return
	}
	var written int64
	for i := 0; i < total; i++ {
		src, err := os.Open(filepath.Join(cdir, strconv.Itoa(i)))
		if err != nil {
			dst.Close()
			os.Remove(tmp)
			jFail(c.w, 500, err.Error())
			return
		}
		n, err := io.Copy(dst, src)
		src.Close()
		written += n
		if err != nil {
			dst.Close()
			os.Remove(tmp)
			jFail(c.w, 500, err.Error())
			return
		}
	}
	if size > 0 && written != size {
		dst.Close()
		os.Remove(tmp)
		jFail(c.w, 400, fmt.Sprintf("size mismatch: got %d want %d", written, size))
		return
	}
	dst.Close()
	if err := os.Rename(tmp, abs); err != nil {
		os.Remove(tmp)
		jFail(c.w, 500, err.Error())
		return
	}
	os.RemoveAll(cdir)
	s.audit(c, "upload-chunk", targetFull, strconv.FormatInt(written, 10))
	jOK(c.w, map[string]any{"ok": true, "path": targetFull, "size": written})
}

func safeID(s string) string {
	if len(s) < 8 || len(s) > 64 {
		return ""
	}
	for _, ch := range s {
		if !(ch >= 'a' && ch <= 'z' || ch >= 'A' && ch <= 'Z' || ch >= '0' && ch <= '9' || ch == '-' || ch == '_') {
			return ""
		}
	}
	return s
}

func checkFree(cfg *Config) bool {
	if cfg.MinFree <= 0 {
		return false
	}
	_, free, err := diskUsage(cfg.Root)
	if err != nil {
		return false
	}
	return uint64(cfg.MinFree) > free
}
