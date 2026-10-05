package main

// job.go — async job hub (url fetch, big archives, extracts) with progress + SSE.

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type Job struct {
	hub       *JobHub
	ID        string    `json:"id"`
	Type      string    `json:"type"` // urlfetch|archive|extract
	Name      string    `json:"name"`
	State     string    `json:"state"` // queued|running|done|error|canceled
	Done      int64     `json:"done"`
	Total     int64     `json:"total"` // -1 unknown
	Speed     float64   `json:"speed"` // bytes/s (EMA)
	Error     string    `json:"error,omitempty"`
	Result    string    `json:"result,omitempty"` // path produced
	Created time.Time `json:"created"`
	Updated time.Time `json:"updated"`

	cancel context.CancelFunc `json:"-"`
	mu     sync.Mutex         `json:"-"`
	lastN  int64
	lastT  time.Time
	paused bool
}

type JobHub struct {
	mu     sync.RWMutex
	jobs   map[string]*Job
	order  []string
	dir    string
	watchers map[chan string]struct{}
}

func NewJobHub(dataDir string) *JobHub {
	jd := filepath.Join(dataDir, "state", "jobs")
	_ = os.MkdirAll(jd, 0o700)
	return &JobHub{jobs: map[string]*Job{}, dir: jd, watchers: map[chan string]struct{}{}}
}

func (h *JobHub) tmpDir() string {
	d := filepath.Join(h.dir, "tmp")
	_ = os.MkdirAll(d, 0o700)
	return d
}

func newID() string {
	b := make([]byte, 8)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func (h *JobHub) Start(jtype, name string, run func(ctx context.Context, j *Job) error) *Job {
	ctx, cancel := context.WithCancel(context.Background())
	j := &Job{ID: newID(), Type: jtype, Name: name, State: "queued", Total: -1,
		Created: time.Now(), Updated: time.Now(), cancel: cancel, lastT: time.Now()}
	h.mu.Lock()
	h.jobs[j.ID] = j
	h.order = append(h.order, j.ID)
	if len(h.order) > 200 { // trim old done jobs
		for i := 0; i < len(h.order); {
			old := h.jobs[h.order[i]]
			if old != nil && (old.State == "done" || old.State == "canceled") && time.Since(old.Updated) > time.Hour {
				delete(h.jobs, old.ID)
				h.order = append(h.order[:i], h.order[i+1:]...)
				continue
			}
			i++
		}
	}
	h.mu.Unlock()
	h.publish(j)
	go func() {
		defer cancel()
		j.set(func(j *Job) { j.State = "running" })
		h.publish(j)
		err := run(ctx, j)
		if err != nil {
			if ctx.Err() != nil {
				j.set(func(j *Job) { j.State = "canceled" })
			} else {
				j.set(func(j *Job) { j.State = "error"; j.Error = err.Error() })
			}
		} else {
			j.set(func(j *Job) { j.State = "done"; j.Done = j.Total })
		}
		h.publish(j)
	}()
	return j
}

func (j *Job) set(fn func(*Job)) {
	j.mu.Lock()
	fn(j)
	j.Updated = time.Now()
	j.mu.Unlock()
	if j.hub != nil {
		j.hub.publish(j)
	}
}

func (j *Job) Progress(delta int64, total int64) {
	j.mu.Lock()
	j.Done += delta
	if total >= 0 {
		j.Total = total
	}
	publishNow := false
	if s := time.Since(j.lastT).Seconds(); s > 0.4 {
		inst := float64(j.Done-j.lastN) / s
		if j.Speed == 0 {
			j.Speed = inst
		} else {
			j.Speed = j.Speed*0.6 + inst*0.4
		}
		j.lastN, j.lastT = j.Done, time.Now()
		publishNow = true
	}
	j.Updated = time.Now()
	j.mu.Unlock()
	if publishNow && j.hub != nil {
		j.hub.publish(j)
	}
}

type JobView struct {
	ID      string    `json:"id"`
	Type    string    `json:"type"`
	Name    string    `json:"name"`
	State   string    `json:"state"`
	Done    int64     `json:"done"`
	Total   int64     `json:"total"`
	Speed   float64   `json:"speed"`
	Error   string    `json:"error,omitempty"`
	Result  string    `json:"result,omitempty"`
	Created time.Time `json:"created"`
	Updated time.Time `json:"updated"`
}

func (j *Job) snapshot() JobView {
	j.mu.Lock()
	defer j.mu.Unlock()
	return JobView{ID: j.ID, Type: j.Type, Name: j.Name, State: j.State, Done: j.Done,
		Total: j.Total, Speed: j.Speed, Error: j.Error, Result: j.Result,
		Created: j.Created, Updated: j.Updated}
}

func (h *JobHub) Cancel(id string) bool {
	h.mu.RLock()
	j := h.jobs[id]
	h.mu.RUnlock()
	if j == nil {
		return false
	}
	j.mu.Lock()
	st := j.State
	j.mu.Unlock()
	if st == "done" || st == "error" {
		return false
	}
	j.cancel()
	return true
}

func (h *JobHub) List() []JobView {
	h.mu.RLock()
	defer h.mu.RUnlock()
	out := make([]JobView, 0, len(h.order))
	for _, id := range h.order {
		if j := h.jobs[id]; j != nil {
			out = append(out, j.snapshot())
		}
	}
	return out
}

func (h *JobHub) Get(id string) *Job {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.jobs[id]
}

// ---- SSE watchers ----
func (h *JobHub) Sub() (chan string, func()) {
	ch := make(chan string, 32)
	h.mu.Lock()
	h.watchers[ch] = struct{}{}
	h.mu.Unlock()
	return ch, func() {
		h.mu.Lock()
		delete(h.watchers, ch)
		h.mu.Unlock()
		close(ch)
	}
}

func (h *JobHub) publish(j *Job) {
	s := j.snapshot()
	b, _ := json.Marshal(s)
	msg := string(b)
	h.mu.RLock()
	defer h.mu.RUnlock()
	for ch := range h.watchers {
		select {
		case ch <- msg:
		default:
		}
	}
}

var _ = fmt.Sprint
