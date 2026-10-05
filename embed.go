package main

// embed.go — embedded UI assets with per-file fallback to --assets dir.

import (
	"embed"
	"io/fs"
	"path/filepath"
	"strings"
)

//go:embed all:ui
var uiFS embed.FS

func embeddedAsset(name string) (data []byte, mime string, ok bool) {
	clean := filepath.ToSlash(filepath.Clean("/" + strings.TrimPrefix(name, "/")))
	var b []byte
	var err error
	found := false
	for _, sub := range []string{"", "js/", "i18n/", "vendor/ace/", "vendor/ace/src-noconflict/", "vendor/ace/min/", "vendor/pdfjs/"} {
		p2 := "ui/" + sub + strings.TrimPrefix(clean, "/")
		b, err = fs.ReadFile(uiFS, p2)
		if err == nil {
			found = true
			break
		}
	}
	if !found {
		return nil, "", false
	}
	switch strings.ToLower(filepath.Ext(clean)) {
	case ".html":
		mime = "text/html; charset=utf-8"
	case ".css":
		mime = "text/css; charset=utf-8"
	case ".js":
		mime = "text/javascript; charset=utf-8"
	case ".mjs":
		// pdf.js is an ES module; without this the browser refuses to execute it
		mime = "text/javascript; charset=utf-8"
	case ".json":
		mime = "application/json"
	case ".map":
		mime = "application/json"
	case ".ico":
		mime = "image/x-icon"
	case ".svg":
		mime = "image/svg+xml"
	case ".png":
		mime = "image/png"
	case ".woff2":
		mime = "font/woff2"
	default:
		return nil, "", false
	}
	return b, mime, true
}

func assetUIIndex() string {
	b, err := fs.ReadFile(uiFS, "ui/index.html")
	if err != nil {
		return fallbackIndex
	}
	return string(b)
}

const fallbackIndex = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><title>GoFile</title>
<script>window.GOFM_PREFIX="__PREFIX__";</script></head>
<body style="font:14px system-ui;background:#0f1115;color:#e8eaed;display:grid;place-items:center;height:100vh;margin:0">
<div><h2>GoFile</h2><p>UI assets pending.</p></div></body></html>`
