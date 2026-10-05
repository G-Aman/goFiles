package main

// archive.go — zip/tar/tar.gz create (jobs w/ progress), safe extract (same-folder or unique folder).

import (
	"archive/tar"
	"bytes"
	"archive/zip"
	"compress/gzip"
	"context"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

func compressLevel(cfg *Config) int {
	switch cfg.Compress {
	case "none", "store":
		return 0
	case "high":
		return 9
	case "medium":
		return 6
	case "low", "fast":
		return 1
	default:
		return 1 // BestSpeed: minimal CPU consumption, zero CPU spike on low-end routers
	}
}

// archiveItems packs items (public rel paths, already perm-checked) into newName under dir (rel).
func (s *Server) archiveItems(ctx context.Context, j *Job, root string, items []string, kind, dir string, newName string) (string, error) {
	// expand dirs and resolve abs paths
	var files []string // abs
	for _, it := range items {
		rel := cleanRel(it)
		abs, err := safeJoin(root, rel, s.cfgR().AllowSymlink)
		if err != nil {
			return "", err
		}
		fi, err := os.Stat(abs)
		if err != nil {
			return "", fmt.Errorf("%s: not found", it)
		}
		if fi.IsDir() {
			filepath.Walk(abs, func(p string, st os.FileInfo, err error) error {
				if err != nil || st.IsDir() {
					return nil
				}
				files = append(files, p)
				return nil
			})
		} else {
			files = append(files, abs)
		}
	}
	if len(files) == 0 {
		return "", fmt.Errorf("nothing to pack")
	}
	sort.Strings(files)
	var total int64
	for _, f := range files {
		if st, err := os.Stat(f); err == nil {
			total += st.Size()
		}
	}
	j.mu.Lock()
	j.Total = total
	j.mu.Unlock()

	ext := kind
	if kind == "targz" {
		ext = "tar.gz"
	}
	if newName == "" {
		if len(files) == 1 {
			st, _ := os.Stat(files[0])
			base := path.Base(files[0])
			newName = fmt.Sprintf("%s_%s.%s", base, time.Now().Format("060102_150405"), ext)
			_ = st
		} else {
			newName = fmt.Sprintf("archive_%s.%s", time.Now().Format("060102_150405"), ext)
		}
	} else if !strings.HasSuffix(strings.ToLower(newName), "."+ext) {
		newName = newName + "." + ext
	}
	if !validName(newName) {
		return "", fmt.Errorf("invalid archive name")
	}
	targetRel := cleanRel(dir + "/" + newName)
	targetAbs, err := safeJoin(root, targetRel, s.cfgR().AllowSymlink)
	if err != nil {
		return "", err
	}
	if exists(targetAbs) {
		newName = collisionName(filepath.Dir(targetAbs), newName)
		targetRel = cleanRel(dir + "/" + newName)
		targetAbs, err = safeJoin(root, targetRel, false)
		if err != nil {
			return "", err
		}
	}
	tmp := targetAbs + ".gofm-tmp"
	// compute relative-to-root names (preserves folder structure inside archive)
	// like drive zip: entries are the original public paths
	stripRoot := root + string(filepath.Separator)
	out, err := os.Create(tmp)
	if err != nil {
		return "", err
	}
	defer out.Close()
	cleanup := func() { out.Close(); os.Remove(tmp) }

	var zw *zip.Writer
	var tw *tar.Writer
	var gw *gzip.Writer
	lvl := compressLevel(s.cfgR())
	switch kind {
	case "zip":
		zw = zip.NewWriter(out)
	case "tar":
		tw = tar.NewWriter(out)
	case "targz":
		gw = gzip.NewWriter(out)
		tw = tar.NewWriter(gw)
	default:
		cleanup()
		return "", fmt.Errorf("unknown kind %q", kind)
	}

	addOne := func(abs string) error {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		fi, err := os.Stat(abs)
		if err != nil {
			return nil
		}
		name := strings.TrimPrefix(abs, stripRoot)
		f, err := os.Open(abs)
		if err != nil {
			return nil
		}
		defer f.Close()
		switch kind {
		case "zip":
			hdr := &zip.FileHeader{Name: filepath.ToSlash(name), Method: zip.Deflate}
			if lvl == 0 {
				hdr.Method = zip.Store
			}
			hdr.SetMode(fi.Mode())
			hdr.Modified = fi.ModTime()
			wr, err := zw.CreateHeader(hdr)
			if err != nil {
				return err
			}
			buf := make([]byte, 64*1024)
			n, err := copyProgress(wr, f, buf, j, fi.Size())
			_ = n
			return err
		default:
			hdr := &tar.Header{
				Name:    filepath.ToSlash(name),
				Size:    fi.Size(),
				Mode:    int64(fi.Mode().Perm()),
				ModTime: fi.ModTime(),
			}
			if err := tw.WriteHeader(hdr); err != nil {
				return err
			}
			buf := make([]byte, 64*1024)
			_, err := copyProgress(tw, f, buf, j, fi.Size())
			return err
		}
	}
	for _, abs := range files {
		if err := addOne(abs); err != nil {
			cleanup()
			return "", err
		}
	}
	switch kind {
	case "zip":
		if err := zw.Close(); err != nil {
			cleanup()
			return "", err
		}
	default:
		if err := tw.Close(); err != nil {
			cleanup()
			return "", err
		}
		if gw != nil {
			if err := gw.Close(); err != nil {
				cleanup()
				return "", err
			}
		}
	}
	out.Close()
	if err := os.Rename(tmp, targetAbs); err != nil {
		os.Remove(tmp)
		return "", err
	}
	// fix: targz needs gw closed before out rename; reopen path handled below via fallback
	return targetRel, nil
}

func copyProgress(dst io.Writer, src io.Reader, buf []byte, j *Job, size int64) (int64, error) {
	var written int64
	for {
		n, err := src.Read(buf)
		if n > 0 {
			if _, werr := dst.Write(buf[:n]); werr != nil {
				return written, werr
			}
			written += int64(n)
			j.Progress(int64(n), -1)
		}
		if err == io.EOF {
			return written, nil
		}
		if err != nil {
			return written, err
		}
	}
}

// extractArchive unpacks archiveAbs into targetDir abs. unique → create <name>/ subfolder.
func (s *Server) extractArchive(ctx context.Context, j *Job, archiveAbs, targetAbs string, unique bool) error {
	ext := strings.ToLower(path.Ext(archiveAbs))
	if strings.HasSuffix(strings.ToLower(archiveAbs), ".tar.gz") || strings.HasSuffix(strings.ToLower(archiveAbs), ".tgz") {
		ext = ".gz"
	}
	lb0 := strings.ToLower(path.Base(archiveAbs))
	archiveBase := lb0
	for _, suf := range []string{".tar.gz", ".tgz", ".tar.bz2", ".zip", ".tar", ".gz"} {
		if strings.HasSuffix(archiveBase, suf) {
			archiveBase = strings.TrimSuffix(archiveBase, suf)
			break
		}
	}
	fi, err := os.Stat(archiveAbs)
	if err != nil {
		return err
	}
	j.mu.Lock()
	j.Total = fi.Size()
	j.mu.Unlock()

	if unique {
		lb := path.Base(archiveAbs) // preserve case for folder name (suffix check uses lower)
		lbl := strings.ToLower(lb)
		base := lb
		for _, suf := range []string{".tar.gz", ".tgz", ".tar.bz2", ".tar.xz", ".zip", ".tar", ".gz", ".bz2", ".xz"} {
			if strings.HasSuffix(lbl, suf) {
				base = base[:len(base)-len(suf)]
				lbl = lbl[:len(lbl)-len(suf)]
				break
			}
		}
		if base == lb || base == "" {
			if i := strings.LastIndexByte(lb, '.'); i > 0 {
				base = lb[:i]
			} else {
				base = lb + "-unpacked"
			}
		}
		if i := strings.LastIndexByte(base, '.'); i > 0 {
			base = base[:i]
		}
		targetAbs = filepath.Join(targetAbs, collisionName(targetAbs, base))
		if err := os.MkdirAll(targetAbs, 0o755); err != nil {
			return err
		}
	}
	switch ext {
	case ".zip":
		return s.unzip(ctx, j, archiveAbs, targetAbs)
	case ".gz":
		f, err := os.Open(archiveAbs)
		if err != nil {
			return err
		}
		defer f.Close()
		gz, err := gzip.NewReader(f)
		if err != nil {
			return err
		}
		defer gz.Close()
		// tar.gz? peek tar magic at offset 257 ("ustar"), restore and stream once.
		head := make([]byte, 512)
		nh, _ := io.ReadFull(gz, head)
		isTar := nh == 512 && string(head[257:262]) == "ustar"
		br := io.MultiReader(bytes.NewReader(head[:nh]), gz)
		if isTar {
			return s.untarReader(ctx, j, br, targetAbs)
		}
		dst := filepath.Join(targetAbs, collisionName(targetAbs, archiveBase))
		out, err := os.OpenFile(dst+".gofm-tmp", os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
		if err != nil {
			return err
		}
		buf := make([]byte, 64*1024)
		for {
			if ctx.Err() != nil {
				out.Close()
				os.Remove(dst + ".gofm-tmp")
				return ctx.Err()
			}
			n, rerr := br.Read(buf)
			if n > 0 {
				if _, werr := out.Write(buf[:n]); werr != nil {
					out.Close()
					os.Remove(dst + ".gofm-tmp")
					return werr
				}
				j.Progress(int64(n), -1)
			}
			if rerr == io.EOF {
				break
			}
			if rerr != nil {
				out.Close()
				os.Remove(dst + ".gofm-tmp")
				return rerr
			}
		}
		out.Close()
		return os.Rename(dst+".gofm-tmp", dst)
	case ".tar":
		f, err := os.Open(archiveAbs)
		if err != nil {
			return err
		}
		defer f.Close()
		return s.untar(ctx, j, f, targetAbs)
	default:
		return fmt.Errorf("unsupported archive type %q", ext)
	}
}

func (s *Server) unzip(ctx context.Context, j *Job, zpath, dest string) error {
	zr, err := zip.OpenReader(zpath)
	if err != nil {
		return err
	}
	defer zr.Close()
	var total int64
	for _, f := range zr.File {
		total += int64(f.UncompressedSize64)
	}
	j.mu.Lock()
	j.Total = total
	j.mu.Unlock()
	var written int64
	buf := make([]byte, 64*1024)
	for _, fh := range zr.File {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		name := filepath.Clean("/" + strings.ReplaceAll(fh.Name, "\\", "/"))
		target := filepath.Join(dest, name)
		if !strings.HasPrefix(target, filepath.Clean(dest)+string(os.PathSeparator)) {
			continue // zip-slip guard
		}
		if fh.FileInfo().IsDir() {
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		rc, err := fh.Open()
		if err != nil {
			return err
		}
		out, err := os.OpenFile(target+".gofm-tmp", os.O_CREATE|os.O_WRONLY|os.O_TRUNC, fh.Mode()&0o777)
		if err != nil {
			rc.Close()
			return err
		}
		for {
			n, err := rc.Read(buf)
			if n > 0 {
				if _, werr := out.Write(buf[:n]); werr != nil {
					out.Close()
					rc.Close()
					os.Remove(target + ".gofm-tmp")
					return werr
				}
				written += int64(n)
				j.Progress(int64(n), -1)
			}
			if err == io.EOF {
				break
			}
			if err != nil {
				out.Close()
				rc.Close()
				os.Remove(target + ".gofm-tmp")
				return err
			}
		}
		out.Close()
		rc.Close()
		if err := os.Rename(target+".gofm-tmp", target); err != nil {
			return err
		}
	}
	return nil
}

func (s *Server) untar(ctx context.Context, j *Job, r io.Reader, dest string) error {
	return s.untarReader(ctx, j, r, dest)
}

func (s *Server) untarReader(ctx context.Context, j *Job, r io.Reader, dest string) error {
	tr := tar.NewReader(r)
	buf := make([]byte, 64*1024)
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		hdr, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		name := filepath.Clean("/" + strings.ReplaceAll(hdr.Name, "\\", "/"))
		target := filepath.Join(dest, name)
		if !strings.HasPrefix(target, filepath.Clean(dest)+string(os.PathSeparator)) {
			continue
		}
		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			out, err := os.OpenFile(target+".gofm-tmp", os.O_CREATE|os.O_WRONLY|os.O_TRUNC, os.FileMode(hdr.Mode).Perm())
			if err != nil {
				return err
			}
			for {
				n, err := tr.Read(buf)
				if n > 0 {
					if _, werr := out.Write(buf[:n]); werr != nil {
						out.Close()
						os.Remove(target + ".gofm-tmp")
						return werr
					}
					j.Progress(int64(n), -1)
				}
				if err == io.EOF {
					break
				}
				if err != nil {
					out.Close()
					os.Remove(target + ".gofm-tmp")
					return err
				}
			}
			out.Close()
			if err := os.Rename(target+".gofm-tmp", target); err != nil {
				return err
			}
		}
	}
}
