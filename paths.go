package main

// paths.go — clean relative path handling + traversal defense + hidden/deny logic.

import (
	"os"
	"path"
	"path/filepath"
	"strings"
)

// cleanRel normalizes a URL/body path to a rooted clean rel path: "/a/b"
func cleanRel(p string) string {
	p = strings.ReplaceAll(p, "\\", "/")
	p = strings.Trim(p, "/")
	p = path.Clean("/" + p)
	if p == "//" {
		p = "/"
	}
	return p
}

// pathHasPrefix reports whether p is under prefix (both cleaned, rooted).
// Empty prefix (legacy rule form) means root and matches everything.
func pathHasPrefix(p, prefix string) bool {
	p = cleanRel(p)
	if prefix == "" || prefix == "/" {
		return true
	}
	prefix = cleanRel(prefix)
	return strings.HasPrefix(p, prefix+"/") || p == prefix
}

// safeJoin joins root + rel ensuring the result stays under root (no symlink escapes
// unless allowSymlink). Returns cleaned absolute path.
func safeJoin(root, rel string, allowSymlink bool) (string, error) {
	rel = cleanRel(rel)
	full := filepath.Join(root, filepath.Clean("/"+rel))
	if full != root && !strings.HasPrefix(full, root+string(filepath.Separator)) {
		return "", os.ErrPermission
	}
	if allowSymlink {
		return full, nil
	}
	// resolve any existing symlinks on the existing portion of the path
	abs, err := filepath.EvalSymlinks(full)
	if err != nil {
		if os.IsNotExist(err) {
			// new file: check parent chain
			parent, perr := filepath.EvalSymlinks(filepath.Dir(full))
			if perr != nil {
				if os.IsNotExist(perr) {
					return full, nil
				}
				return "", perr
			}
			rp := root
			if rr, err2 := filepath.EvalSymlinks(root); err2 == nil {
				rp = rr
			}
			if !strings.HasPrefix(parent, rp+string(filepath.Separator)) && parent != rp {
				return "", os.ErrPermission
			}
			return full, nil
		}
		return "", err
	}
	rp := root
	if rr, err2 := filepath.EvalSymlinks(root); err2 == nil {
		rp = rr
	}
	if abs != rp && !strings.HasPrefix(abs, rp+string(filepath.Separator)) {
		return "", os.ErrPermission
	}
	return full, nil
}

// relOf converts abs path back to rel under root.
func relOf(root, abs string) string {
	r := strings.TrimPrefix(abs, root)
	if r == "" {
		return "/"
	}
	return cleanRel(r)
}

func baseName(rel string) string { return path.Base(cleanRel(rel)) }

func extOf(name string) string {
	name = strings.ToLower(name)
	i := strings.LastIndexByte(name, '.')
	if i <= 0 || i == len(name)-1 {
		return ""
	}
	return name[i+1:]
}

// matchPattern supports * and ?.
func matchPattern(pat, s string) bool {
	ok, err := filepath.Match(strings.ToLower(pat), strings.ToLower(s))
	return err == nil && ok
}

func isHidden(name string, hidden []string) bool {
	for _, h := range hidden {
		if strings.Contains(h, "/") {
			continue
		}
		if matchPattern(h, name) || name == h {
			return true
		}
	}
	return false
}

func extDenied(name string, deny []string) bool {
	e := extOf(name)
	if e == "" {
		return false
	}
	for _, d := range deny {
		d = strings.ToLower(strings.TrimPrefix(d, "."))
		if d == e {
			return true
		}
	}
	return false
}

// collision name: "a.txt" → "a (2).txt", "a (2).txt" → "a (3).txt"
func collisionName(dir, name string) string {
	if !exists(filepath.Join(dir, name)) {
		return name
	}
	ext := ""
	stem := name
	if i := strings.LastIndexByte(name, '.'); i > 0 {
		stem, ext = name[:i], name[i:]
	}
	// strip existing suffix " (n)"
	base := stem
	if strings.HasSuffix(stem, ")") {
		if j := strings.LastIndexByte(stem, '('); j > 0 {
			num := stem[j+1 : len(stem)-1]
			isNum := num != ""
			for _, ch := range num {
				if ch < '0' || ch > '9' {
					isNum = false
				}
			}
			if isNum {
				base = strings.TrimRight(stem[:j], " ")
			}
		}
	}
	for n := 2; n < 10000; n++ {
		cand := base + " (" + itoa(n) + ")" + ext
		if !exists(filepath.Join(dir, cand)) {
			return cand
		}
	}
	return name
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [24]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}

func exists(p string) bool {
	_, err := os.Lstat(p)
	return err == nil
}
