package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestACLParseAndWrite(t *testing.T) {
	rules := []Rule{
		{User: "", Path: "/Public", Perms: Perms{R: true}},
		{User: "rani", Path: "/", Perms: Perms{R: true, U: true, W: true}},
		{User: "*", Path: "/Shared", Perms: Perms{R: true}},
	}
	tmpDir := t.TempDir()
	confPath := filepath.Join(tmpDir, "acl.conf")

	if err := WriteRules(confPath, rules); err != nil {
		t.Fatalf("WriteRules failed: %v", err)
	}

	content, err := os.ReadFile(confPath)
	if err != nil {
		t.Fatalf("ReadFile failed: %v", err)
	}
	t.Logf("Written acl.conf:\n%s", string(content))

	// Ensure no @@ appears anywhere
	if string(content) == "" || string(content)[0] == 0 {
		t.Fatal("empty file")
	}

	parsed, err := LoadRules(confPath)
	if err != nil {
		t.Fatalf("LoadRules failed: %v", err)
	}
	if len(parsed) != 3 {
		t.Fatalf("expected 3 rules, got %d", len(parsed))
	}
	if parsed[0].User != "" || parsed[0].Path != "/Public" || !parsed[0].R {
		t.Errorf("rule 0 mismatch: %+v", parsed[0])
	}
	if parsed[1].User != "rani" || parsed[1].Path != "/" || !parsed[1].U || !parsed[1].W {
		t.Errorf("rule 1 mismatch: %+v", parsed[1])
	}

	// Test healing legacy corrupted lines
	corrupted := []string{
		"@@/@/@/@/Public:r",
		"rani@/:ruw",
		"@@/@/Public:r",
	}
	healed, err := parseRules(corrupted)
	if err != nil {
		t.Fatalf("failed parsing corrupted rules: %v", err)
	}
	if healed[0].User != "" || healed[0].Path != "/Public" {
		t.Errorf("corrupted rule 0 not healed: %+v", healed[0])
	}
	if healed[2].User != "" || healed[2].Path != "/Public" {
		t.Errorf("corrupted rule 2 not healed: %+v", healed[2])
	}
}
