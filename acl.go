package main

// acl.go — per-user per-path permissions: read / upload / write / delete.
// Rules come from a SEPARATE acl.conf so access control can be edited without
// touching (or invalidating) the main config. Syntax, one rule per line:
//
//	<user|@>/<path>:<perms>
//
//	user    account name, or "@" for anonymous, "*" for any authenticated user
//	path    path prefix relative to root; omit for the user's whole home
//	perms   any of r (read/list/download), u (upload new files), w (modify
//	        existing: rename, chmod, copy-into, save, extract), d (delete).
//	        Omit the suffix for "r" only.
//
//	@/Public:r          anonymous can browse and download /Public
//	@/Public:ru         anonymous can also upload, but never overwrite or delete
//	@/Public:ruwd       anonymous full access (usually NOT what you want)
//	*/Team:r            any logged-in user can read /Team
//	bob@/Team:ruwd      bob full access to /Team, INCLUDING editing
//	bob@/Private:r      bob read-only in /Private
//
// REMINDER: "w" is what enables the in-app editor and rename. "rud" does not
// include it — an owner rule must be "ruwd" to be able to edit files.
//
// Longest matching path wins; a named user beats "@"; a named user beats "*".
// Anything with no match is denied.

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Perms is the full permission set. Kept as named fields (not a bitmask) so
// call sites read as intent rather than arithmetic.
type Perms struct {
	R bool // read: list, stat, download, preview
	U bool // upload: create a NEW file/folder via /api/upload or /api/create
	W bool // write: modify an EXISTING path (save, rename, chmod, copy/move into, extract)
	D bool // delete: /api/delete
}

func (p Perms) Any() bool { return p.R || p.U || p.W || p.D }

// Writable is what the UI and the guards mean by "may modify this path".
// Upload alone is deliberately NOT enough: a shared drop box accepts new files
// without letting a guest overwrite or destroy what is already there.
func (p Perms) Writable() bool { return p.U || p.W }

type Rule struct {
	User string // "" = anon, "*" = any authenticated user
	Path string // clean relative path prefix; "" = the user's whole home
	Perms
}

const aclFileName = "acl.conf"

func parseRule(s string) (Rule, error) {
	r := Rule{}
	rest := strings.TrimSpace(s)
	if i := strings.LastIndexByte(rest, ':'); i >= 0 && !strings.ContainsAny(rest[i:], "/") {
		perms := rest[i+1:]
		rest = rest[:i]
		if perms == "" {
			return r, fmt.Errorf("empty perms")
		}
		for _, ch := range perms {
			switch ch {
			case 'r':
				r.R = true
			case 'u':
				r.U = true
			case 'w':
				r.W = true
			case 'd':
				r.D = true
			default:
				return r, fmt.Errorf("bad perm %q (allowed: r u w d)", ch)
			}
		}
	} else {
		r.R = true // no suffix = read-only
	}

	cleanPath := func(p string) string {
		p = strings.TrimSpace(p)
		for strings.Contains(p, "/@/") || strings.HasPrefix(p, "@") {
			p = strings.ReplaceAll(p, "/@/", "/")
			p = strings.TrimPrefix(p, "@")
		}
		p = cleanRel(p)
		if p == "" {
			p = "/"
		}
		return p
	}

	if strings.HasPrefix(rest, "@") {
		r.User = "" // anonymous
		p := strings.TrimLeft(rest, "@")
		r.Path = cleanPath(p)
	} else if i := strings.IndexByte(rest, '@'); i >= 0 {
		r.User = strings.TrimSpace(rest[:i])
		if r.User == "@" {
			r.User = ""
		}
		p := rest[i+1:]
		r.Path = cleanPath(p)
	} else if strings.HasPrefix(rest, "/") {
		r.User = "*" // /path:r — any authenticated user
		r.Path = cleanPath(rest)
	} else {
		r.User = rest
		r.Path = "/"
	}
	return r, nil
}

func parseRules(lines []string) ([]Rule, error) {
	var out []Rule
	for i, l := range lines {
		t := strings.TrimSpace(l)
		if t == "" || strings.HasPrefix(t, "#") {
			continue
		}
		r, err := parseRule(t)
		if err != nil {
			return nil, fmt.Errorf("rule[%d] %q: %w", i, t, err)
		}
		out = append(out, r)
	}
	return out, nil
}

// LoadRules reads acl.conf. A missing file is not an error: an empty rule set
// means "authenticated users get everything, anonymous is denied", which is
// the safe default for a fresh install.
func LoadRules(path string) ([]Rule, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	return parseRules(strings.Split(string(b), "\n"))
}

// WriteRules serialises rules back to acl.conf with a header, so the file is
// self-documenting when opened in an editor.
func WriteRules(path string, rules []Rule) error {
	var sb strings.Builder
	sb.WriteString("# goFiles access control — one rule per line.\n")
	sb.WriteString("# <user|@|*> / <path> : <perms>      e.g.  @/Public:ru\n")
	sb.WriteString("#   r = read/list/download    u = upload NEW files\n")
	sb.WriteString("#   w = modify existing (rename, edit, chmod)   d = delete\n")
	sb.WriteString("# NOTE: editing a file needs \"w\". An owner rule must be ruwd.\n")
	sb.WriteString("# Longest path wins; a named user beats @ and *.\n")
	for _, r := range rules {
		p := cleanRel(r.Path)
		if p == "" {
			p = "/"
		}
		if r.User == "" || r.User == "@" {
			sb.WriteString("@" + p + ":" + permString(r.Perms) + "\n")
		} else {
			sb.WriteString(r.User + "@" + p + ":" + permString(r.Perms) + "\n")
		}
	}
	return os.WriteFile(path, []byte(sb.String()), 0o600)
}

func permString(p Perms) string {
	var sb strings.Builder
	if p.R {
		sb.WriteByte('r')
	}
	if p.U {
		sb.WriteByte('u')
	}
	if p.W {
		sb.WriteByte('w')
	}
	if p.D {
		sb.WriteByte('d')
	}
	if sb.Len() == 0 {
		return "-"
	}
	return sb.String()
}

// Effective resolves user ("" = anon) + path (clean rel) → permissions.
// No rules at all → read-only for everyone, so a config-less first run works.
func EffectiveWithAdmin(rules []Rule, user, path string, isSuperAdmin bool) Perms {
	if isSuperAdmin {
		return Perms{R: true, U: true, W: true, D: true}
	}
	return Effective(rules, user, path)
}

func Effective(rules []Rule, user, path string) Perms {
	if len(rules) == 0 {
		// When no rules are defined in acl.conf:
		// Any logged-in user gets full access by default.
		// Anonymous visitor (user == "") gets NO permissions (requires login).
		if user != "" {
			return Perms{R: true, U: true, W: true, D: true}
		}
		return Perms{}
	}
	res := Perms{}
	matched := false
	p := cleanRel(path)
	// specificity: named-user (2) > "*" (1) > anon "@" (0); deeper paths win ties
	bestUser, bestDepth := -1, -1
	for _, rl := range rules {
		uScore := 0
		switch {
		case rl.User == "*":
			// applies to any logged-in user, but never to anonymous
			if user == "" {
				continue
			}
			uScore = 1
		case rl.User == "":
			uScore = 0
		default:
			if rl.User != user {
				continue
			}
			uScore = 2
		}
		if !pathHasPrefix(p, rl.Path) {
			continue
		}
		pTrim := strings.Trim(rl.Path, "/")
		depth := 0
		if pTrim != "" && cleanRel(rl.Path) != "/" {
			depth = len(strings.Split(pTrim, "/"))
		}
		// Strict > on depth: with >=, a later rule of the SAME depth but lower
		// user-score would overwrite a named-user rule, downgrading it.
		if uScore > bestUser || (uScore == bestUser && depth > bestDepth) {
			bestUser, bestDepth = uScore, depth
			res = rl.Perms
			matched = true
		}
	}
	if !matched {
		return Perms{} // default deny when rules exist but none matched
	}
	return res
}

// ACLPath is the sibling of the main config file.
func ACLPath(cfgPath string) string {
	if cfgPath == "" {
		cfgPath = "config.json"
	}
	return filepath.Join(filepath.Dir(cfgPath), aclFileName)
}
