package main

// auth.go — sessions (memory + file), bcrypt/plain pass verify, CSRF, login rate-limit/lockout.

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/bcrypt"
)

type Session struct {
	ID     string
	User   string // "" = anonymous
	CSRF   string
	Home   string // jail prefix
	Expire time.Time
}

type SessionStore struct {
	mu  sync.Mutex
	dir string
	mem map[string]*Session
	ttl time.Duration
}

func NewSessionStore(dataDir string) *SessionStore {
	// sessions live OUTSIDE the served tree (state dir beside config/binary)
	d := filepath.Join(dataDir, "state", "sessions")
	_ = os.MkdirAll(d, 0o700)
	return &SessionStore{dir: d, mem: map[string]*Session{}, ttl: 14 * 24 * time.Hour}
}

func randHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		for i := range b {
			b[i] = byte(time.Now().UnixNano() >> (i * 8))
		}
	}
	return hex.EncodeToString(b)
}

func (st *SessionStore) Create(user, home string) *Session {
	s := &Session{ID: randHex(16), User: user, CSRF: randHex(32), Home: home, Expire: time.Now().Add(st.ttl)}
	st.save(s)
	return s
}

func (st *SessionStore) Get(id string) *Session {
	st.mu.Lock()
	if s, ok := st.mem[id]; ok && s.Expire.After(time.Now()) {
		st.mu.Unlock()
		return s
	}
	st.mu.Unlock()
	b, err := os.ReadFile(filepath.Join(st.dir, id+".json"))
	if err != nil {
		return nil
	}
	s := &Session{}
	if json.Unmarshal(b, s) != nil || !s.Expire.After(time.Now()) {
		return nil
	}
	st.mu.Lock()
	st.mem[id] = s
	st.mu.Unlock()
	return s
}

func (st *SessionStore) save(s *Session) {
	st.mu.Lock()
	st.mem[s.ID] = s
	st.mu.Unlock()
	b, _ := json.Marshal(s)
	_ = os.WriteFile(filepath.Join(st.dir, s.ID+".json"), b, 0o600)
}

func (st *SessionStore) Delete(id string) {
	st.mu.Lock()
	delete(st.mem, id)
	st.mu.Unlock()
	_ = os.Remove(filepath.Join(st.dir, id+".json"))
}

// verifyPass: bcrypt hash config (or "$2y$") or plain compare (constant time).
func verifyPass(supplied, stored string) bool {
	if strings.HasPrefix(stored, "$2a$") || strings.HasPrefix(stored, "$2b$") || strings.HasPrefix(stored, "$2y$") {
		err := bcrypt.CompareHashAndPassword([]byte(strings.Replace(stored, "$2y$", "$2a$", 1)), []byte(supplied))
		return err == nil
	}
	return subtle.ConstantTimeCompare([]byte(supplied), []byte(stored)) == 1
}

func HashPass(plain string) (string, error) {
	b, err := bcrypt.GenerateFromPassword([]byte(plain), bcrypt.DefaultCost)
	return string(b), err
}

// ---- rate limit ----
type failRec struct {
	n      int
	first  time.Time
	locked time.Time
}

type RateLimiter struct {
	mu   sync.Mutex
	b    map[string]*failRec
	cfg  RateLimit
}

func NewRateLimiter(cfg RateLimit) *RateLimiter { return &RateLimiter{b: map[string]*failRec{}, cfg: cfg} }

func (rl *RateLimiter) Locked(key string) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	r := rl.b[key]
	return r != nil && r.locked.After(time.Now())
}

func (rl *RateLimiter) Fail(key string) {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	now := time.Now()
	r := rl.b[key]
	if r == nil || now.Sub(r.first) > time.Duration(rl.cfg.WindowS)*time.Second {
		rl.b[key] = &failRec{n: 1, first: now}
		return
	}
	r.n++
	if r.n >= rl.cfg.MaxFails {
		r.locked = now.Add(time.Duration(rl.cfg.LockoutS) * time.Second)
	}
}

func (rl *RateLimiter) OK(key string) {
	rl.mu.Lock()
	delete(rl.b, key)
	rl.mu.Unlock()
}

// ---- request-level helpers ----
func (s *Server) sessionFromReq(r *http.Request) *Session {
	c, err := r.Cookie(s.cfg.SessionName)
	if err != nil {
		return nil
	}
	return s.sess.Get(c.Value)
}

// identify resolves user identity for a request: Basic-auth wins over cookie (dav clients).
// returns session (nil for pure basic), user name, perms-check closure needs path.
type Identity struct {
	User  string
	Home  string
	CSRF  string
	Sess  *Session
	Basic bool
}

func (s *Server) Identify(r *http.Request) (*Identity, bool) {
	if u, p, ok := r.BasicAuth(); ok {
		bkey := "basic:" + u + ":" + clientIP(r)
		if pass, exists := s.cfg.userPass(u); exists && verifyPass(p, pass) && !s.rl.Locked(bkey) {
			s.rl.OK(bkey) // successful auth resets the failure counter
			return &Identity{User: u, Home: s.cfg.userHome(u), Basic: true}, true
		}
		s.rl.Fail(bkey)
		return nil, false
	}
	if sess := s.sessionFromReq(r); sess != nil {
		if _, exists := s.cfg.userPass(sess.User); !exists {
			return nil, false
		}
		return &Identity{User: sess.User, Home: sess.Home, CSRF: sess.CSRF, Sess: sess}, true
	}
	return &Identity{}, true // anonymous
}

// trustXFF is set once from cfg.TrustProxy at boot. When it is false the
// X-Forwarded-For header is ignored entirely: otherwise any client could mint
// an unbounded set of "client IPs" by varying the header, defeating both the
// login rate limiter and its lockout (and growing its map without bound).
var trustXFF bool

func clientIP(r *http.Request) string {
	if trustXFF {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			if i := strings.IndexByte(xff, ','); i > 0 {
				return strings.TrimSpace(xff[:i])
			}
			return strings.TrimSpace(xff)
		}
	}
	if i := strings.LastIndexByte(r.RemoteAddr, ':'); i > 0 {
		return r.RemoteAddr[:i]
	}
	return r.RemoteAddr
}

func (c *Config) userPass(name string) (string, bool) {
	for _, u := range c.Users {
		if u.Name == name {
			return u.Pass, true
		}
	}
	return "", false
}
func (c *Config) userHome(name string) string {
	for _, u := range c.Users {
		if u.Name == name {
			if u.Home == "" {
				return "/"
			}
			return cleanRel(u.Home)
		}
	}
	return "/"
}

// jailPath maps a public rel path through the user's home jail.
func jailPath(home, rel string) string {
	rel = cleanRel(rel)
	if home == "/" || home == "" {
		return rel
	}
	if rel == "/" {
		return home
	}
	return cleanRel(home + rel)
}

// csrfOK for cookie sessions (basic auth doesn't need it).
func (s *Server) csrfOK(r *http.Request, id *Identity) bool {
	if id.Basic {
		return true
	}
	if id.Sess == nil {
		return false
	}
	tok := r.Header.Get("X-CSRF")
	if tok == "" {
		tok = r.FormValue("csrf")
	}
	return subtle.ConstantTimeCompare([]byte(tok), []byte(id.CSRF)) == 1
}
