package main

// fs.go — directory listing, file info, mime, safe mutations (move/copy/delete/mkdir/save), hash.

import (
	"crypto/md5"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"hash"
	"io"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

type Item struct {
	Name    string    `json:"name"`
	Path    string    `json:"path"` // public rel, rooted
	IsDir   bool      `json:"is_dir"`
	Size    int64     `json:"size"`
	Mtime   time.Time `json:"mtime"`
	Mode    uint32    `json:"mode"`
	Mime    string    `json:"mime"`
	SymDir  bool      `json:"sym_dir,omitempty"`
}

func (s *Server) infoItem(rootDir, abs, publicRel string) Item {
	fi, err := os.Lstat(abs)
	if err != nil {
		return Item{}
	}
	it := Item{Name: fi.Name(), Path: publicRel, Mtime: fi.ModTime(), Mode: uint32(fi.Mode().Perm())}
	if fi.Mode()&os.ModeSymlink != 0 {
		if st, err := os.Stat(abs); err == nil {
			it.IsDir = st.IsDir()
			it.SymDir = st.IsDir()
			if !it.IsDir {
				it.Size = st.Size()
			}
			it.Mtime = st.ModTime()
		} else {
			return it // broken link: treat as file w/o size
		}
	} else {
		it.IsDir = fi.IsDir()
		if !it.IsDir {
			it.Size = fi.Size()
		}
	}
	if !it.IsDir {
		it.Mime = mimeByName(it.Name, abs)
	}
	return it
}

// listDir lists publicRel (rooted) under root honoring hidden + perms context.
func (s *Server) listDir(root, home, publicRel string, hidden []string, rec bool, q string, capN int) ([]Item, error) {
	startRel := jailPath(home, publicRel)
	startAbs, err := safeJoin(root, startRel, s.cfg.AllowSymlink)
	if err != nil {
		return nil, err
	}
	fi, err := os.Stat(startAbs)
	if err != nil {
		return nil, err
	}
	if !fi.IsDir() {
		return nil, fmt.Errorf("not a directory")
	}
	var out []Item
	if rec {
		depth := strings.Count(cleanRel(startRel), "/")
		filepath.Walk(startAbs, func(p string, st os.FileInfo, err error) error {
			if err != nil {
				return nil
			}
			if p == startAbs {
				return nil
			}
			d := strings.Count(strings.TrimPrefix(p, startAbs), string(filepath.Separator))
			if st.IsDir() && d > 5 {
				return filepath.SkipDir
			}
			if st.IsDir() {
				return nil
			}
			rel := relOf(root, p)
			rel = unJail(home, rel)
			// OR, not AND: a non-dot file matching a hidden pattern (e.g. "*.log")
			// must be filtered too. With && only dot-prefixed matches were
			// hidden, leaking every configured pattern through recursive search.
			if strings.HasPrefix(path.Base(rel), ".") || isHidden(path.Base(rel), hidden) {
				return nil
			}
			if q != "" && !strings.Contains(strings.ToLower(p), strings.ToLower(q)) {
				return nil
			}
			out = append(out, s.infoItem(root, p, rel))
			_ = depth
			if len(out) >= capN {
				return filepath.SkipAll
			}
			return nil
		})
		return out, nil
	}
	ents, err := os.ReadDir(startAbs)
	if err != nil {
		return nil, err
	}
	for _, e := range ents {
		name := e.Name()
		if strings.HasPrefix(name, ".") || isHidden(name, hidden) {
			continue
		}
		abs := filepath.Join(startAbs, name)
		rel := unJail(home, relOf(root, abs))
		it := s.infoItem(root, abs, rel)
		if it.Name == "" {
			it.Name = name
		}
		out = append(out, it)
	}
	return out, nil
}

// unJail converts internal rel back to public rel under user's home.
func unJail(home, rel string) string {
	rel = cleanRel(rel)
	home = cleanRel(home)
	if home == "/" || home == "" {
		return rel
	}
	if rel == home {
		return "/"
	}
	if strings.HasPrefix(rel, home+"/") {
		r := strings.TrimPrefix(rel, home)
		return cleanRel(r)
	}
	return rel
}



func sortItems(items []Item, key string, asc bool) {
	dirFirst := func(a, b Item) bool { return a.IsDir && !b.IsDir }
	less := func(a, b Item) bool {
		if dirFirst(a, b) {
			return true
		}
		if dirFirst(b, a) {
			return false
		}
		switch key {
		case "size":
			return a.Size < b.Size
		case "time":
			return a.Mtime.Before(b.Mtime)
		case "type":
			if extOf(a.Name) != extOf(b.Name) {
				return extOf(a.Name) < extOf(b.Name)
			}
			return strings.ToLower(a.Name) < strings.ToLower(b.Name)
		default:
			return strings.ToLower(a.Name) < strings.ToLower(b.Name)
		}
	}
	sort.Slice(items, func(i, j int) bool {
		if asc {
			return less(items[i], items[j])
		}
		return less(items[j], items[i])
	})
}

// ---- mime ----
var mimeMap = map[string]string{
	"txt": "text/plain", "md": "text/markdown", "log": "text/plain", "go": "text/plain",
	"js": "text/javascript", "ts": "text/javascript", "json": "application/json",
	"html": "text/html", "htm": "text/html", "css": "text/css", "xml": "text/xml",
	"yml": "text/yaml", "yaml": "text/yaml", "toml": "text/plain", "ini": "text/plain",
	"conf": "text/plain", "sh": "text/x-shellscript", "bash": "text/x-shellscript",
	"py": "text/x-python", "c": "text/plain", "h": "text/plain", "cpp": "text/plain",
	"rs": "text/plain", "java": "text/plain", "sql": "text/x-sql", "csv": "text/csv",
	"pdf": "application/pdf", "zip": "application/zip", "tar": "application/x-tar",
	"gz": "application/gzip", "tgz": "application/gzip", "bz2": "application/x-bzip2",
	"xz": "application/x-xz", "7z": "application/x-7z-compressed", "rar": "application/vnd.rar",
	"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif",
	"webp": "image/webp", "svg": "image/svg+xml", "bmp": "image/bmp", "ico": "image/x-icon",
	"avif": "image/avif", "heic": "image/heic",
	"mp4": "video/mp4", "webm": "video/webm", "mov": "video/quicktime", "mkv": "video/x-matroska",
	"avi": "video/x-msvideo",
	"mp3": "audio/mpeg", "wav": "audio/wav", "ogg": "audio/ogg", "flac": "audio/flac",
	"aac": "audio/aac", "m4a": "audio/mp4",
	"doc": "application/msword", "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	"xls": "application/vnd.ms-excel", "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	"ppt": "application/vnd.ms-powerpoint", "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	"epub": "application/epub+zip", "wasm": "application/wasm",
	"exe": "application/vnd.microsoft.portable-executable", "deb": "application/vnd.debian.binary-package",
	"iso": "application/x-iso9660-image",
}

func mimeByName(name, absPath string) string {
	if m, ok := mimeMap[extOf(name)]; ok {
		return m
	}
	// sniff small
	if f, err := os.Open(absPath); err == nil {
		defer f.Close()
		buf := make([]byte, 512)
		n, _ := io.ReadFull(f, buf)
		if n > 0 {
			return http.DetectContentType(buf[:n])
		}
	}
	return "application/octet-stream"
}

// ---- mutations ----
func (s *Server) fsMkdir(root, rel string) error {
	abs, err := safeJoin(root, rel, s.cfg.AllowSymlink)
	if err != nil {
		return err
	}
	if exists(abs) {
		return os.ErrExist
	}
	return os.MkdirAll(abs, 0o755)
}

func copyFile(src, dst string) (int64, error) {
	in, err := os.Open(src)
	if err != nil {
		return 0, err
	}
	defer in.Close()
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return 0, err
	}
	tmp := dst + ".gofm-tmp"
	out, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return 0, err
	}
	n, err := io.Copy(out, in)
	cerr := out.Close()
	if err != nil || cerr != nil {
		_ = os.Remove(tmp)
		if err == nil {
			err = cerr
		}
		return n, err
	}
	if fi, serr := in.Stat(); serr == nil {
		_ = os.Chmod(tmp, fi.Mode().Perm())
	}
	return n, os.Rename(tmp, dst)
}

func copyTree(srcRoot, dstRoot string) error {
	return filepath.Walk(srcRoot, func(p string, st os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel := strings.TrimPrefix(p, srcRoot)
		dst := filepath.Join(dstRoot, rel)
		if st.IsDir() {
			return os.MkdirAll(dst, st.Mode().Perm()|0o200)
		}
		if st.Mode()&os.ModeSymlink != 0 {
			tgt, err := os.Readlink(p)
			if err != nil {
				return err
			}
			return os.Symlink(tgt, dst)
		}
		_, err = copyFile(p, dst)
		return err
	})
}

func movePath(src, dst string) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	if err := os.Rename(src, dst); err == nil {
		return nil
	}
	// cross-device: copy+delete
	if err := copyTree(src, dst); err != nil {
		_ = os.RemoveAll(dst)
		return err
	}
	return os.RemoveAll(src)
}

func deletePath(abs string) error {
	fi, err := os.Lstat(abs)
	if err != nil {
		return err
	}
	if fi.IsDir() || fi.Mode()&os.ModeSymlink != 0 {
		return os.RemoveAll(abs)
	}
	return os.Remove(abs)
}

func writeFileAtomic(abs string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return err
	}
	tmp := abs + ".gofm-tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	if fi, err := os.Stat(abs); err == nil {
		_ = os.Chmod(tmp, fi.Mode().Perm())
	}
	return os.Rename(tmp, abs)
}

// backupFile copies src into root/.backups/<dirname>/name-stamp.bak (hidden from UI).
// root is the serving root; src is absolute under it. Returns stored backup name.
// Automatically prunes older backups so at most maxCopies remain for this file.
func backupFile(root, src string, maxCopies int) (string, error) {
	base := path.Base(src)
	dirRel := path.Dir(relOf(root, src))
	if dirRel == "." || dirRel == "/" || dirRel == "" {
		dirRel = "/"
	}
	name := fmt.Sprintf("%s-%s.bak", base, time.Now().Format("02Jan06-150405"))
	bdir := filepath.Join(root, ".backups", strings.ReplaceAll(cleanRel(dirRel), "/", "_"))
	if err := os.MkdirAll(bdir, 0o700); err != nil {
		return "", err
	}
	if _, err := copyFile(src, filepath.Join(bdir, name)); err != nil {
		return "", err
	}

	// Auto-prune older backups for this file
	if maxCopies > 0 {
		prefix := base + "-"
		entries, err := os.ReadDir(bdir)
		if err == nil {
			type bakEntry struct {
				name  string
				mtime time.Time
			}
			var fileBaks []bakEntry
			for _, e := range entries {
				if e.IsDir() {
					continue
				}
				nm := e.Name()
				if strings.HasPrefix(nm, prefix) && strings.HasSuffix(nm, ".bak") {
					info, err := e.Info()
					mt := time.Time{}
					if err == nil {
						mt = info.ModTime()
					}
					fileBaks = append(fileBaks, bakEntry{name: nm, mtime: mt})
				}
			}
			if len(fileBaks) > maxCopies {
				sort.Slice(fileBaks, func(i, j int) bool {
					return fileBaks[i].mtime.After(fileBaks[j].mtime) // newest first
				})
				for _, old := range fileBaks[maxCopies:] {
					_ = os.Remove(filepath.Join(bdir, old.name))
				}
			}
		}
	}

	return name, nil
}

func hashFile(abs, algo string) (string, error) {
	var h hash.Hash
	switch algo {
	case "md5":
		h = md5.New()
	case "sha1":
		h = sha1.New()
	case "sha256":
		h = sha256.New()
	default:
		return "", fmt.Errorf("unsupported algo")
	}
	f, err := os.Open(abs)
	if err != nil {
		return "", err
	}
	defer f.Close()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func diskUsage(dir string) (total, free uint64, err error) {
	var st syscallStatfs
	if err = statfs(dir, &st); err != nil {
		return
	}
	total = st.Blocks * uint64(st.Bsize)
	free = st.Bfree * uint64(st.Bsize)
	return
}

func etagOf(fi os.FileInfo) string {
	return fmt.Sprintf("\"%x-%x\"", fi.ModTime().UnixNano(), fi.Size())
}

// dirSize sums the apparent size of every file under dir. Used by /api/usage
// so the storage bar reports the served tree's real usage rather than the
// underlying filesystem's (meaningless on network/overlay mounts).
func dirSize(dir string, depth int) (uint64, error) {
	if depth > 24 {
		return 0, nil
	}
	ents, err := os.ReadDir(dir)
	if err != nil {
		return 0, err
	}
	var total uint64
	for _, e := range ents {
		p := filepath.Join(dir, e.Name())
		if e.IsDir() {
			n, err := dirSize(p, depth+1)
			if err != nil {
				continue // unreadable subtree: skip rather than fail the whole scan
			}
			total += n
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		if info.Mode().IsRegular() {
			total += uint64(info.Size())
		}
	}
	return total, nil
}
