package main

// state.go — runtime-state.json (UI prefs + audit tail), auto-managed.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
)

type RuntimeAudit struct {
	Time  string `json:"time"`
	User  string `json:"user"`
	Op    string `json:"op"`
	Path  string `json:"path"`
	Extra string `json:"extra,omitempty"`
	IP    string `json:"ip,omitempty"`
}

type RuntimeState struct {
	UI    map[string]string `json:"ui,omitempty"`
	Audit []RuntimeAudit    `json:"audit,omitempty"`
}

var stateMu sync.Mutex

func loadRuntimeState(dataDir string) *RuntimeState {
	stateMu.Lock()
	defer stateMu.Unlock()
	st := &RuntimeState{}
	b, err := os.ReadFile(filepath.Join(dataDir, "state", "runtime-state.json"))
	if err == nil {
		_ = json.Unmarshal(b, st)
	}
	if st.UI == nil {
		st.UI = map[string]string{}
	}
	return st
}

func saveRuntimeState(dataDir string, st *RuntimeState) {
	stateMu.Lock()
	defer stateMu.Unlock()
	b, _ := json.MarshalIndent(st, "", "  ")
	tmp := filepath.Join(dataDir, "state", "runtime-state.json.tmp")
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return
	}
	_ = os.Rename(tmp, filepath.Join(dataDir, "state", "runtime-state.json"))
}
