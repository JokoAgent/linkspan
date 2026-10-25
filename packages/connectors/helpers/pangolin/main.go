package main

import (
	"context"
	"encoding/json"
	"flag"
	"io"
	"log"
	"net"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/fosrl/newt/newt"
	"github.com/fosrl/newt/proxy"
	"github.com/fosrl/newt/websocket"
	bridge "linkspan.invalid/connectorbridge"
)

type config struct {
	RequestID            string `json:"requestId"`
	LocalAddress         string `json:"localAddress"`
	Endpoint             string `json:"endpoint"`
	SiteID               string `json:"siteId"`
	SiteSecret           string `json:"siteSecret"`
	PublicOrigin         string `json:"publicOrigin"`
	Mode                 string `json:"mode"`
	PublicHost           string `json:"publicHost"`
	PublicPort           int    `json:"publicPort"`
	MaximumDatagramBytes int    `json:"maximumDatagramBytes"`
	MaximumPeers         int    `json:"maximumPeers"`
	IdleTimeoutMS        int    `json:"idleTimeoutMs"`
	MaximumBytes         int64  `json:"maximumBytes"`
	ExpiresAt            int64  `json:"expiresAt"`
}

func main() {
	log.SetOutput(io.Discard)
	path := flag.String("config", "", "private configuration file")
	flag.Parse()
	var cfg config
	if flag.NArg() != 0 || !filepath.IsAbs(*path) || bridge.ReadConfig(*path, &cfg) != nil || bridge.ValidateAddress(cfg.LocalAddress) != nil || cfg.RequestID == "" || cfg.SiteID == "" || cfg.SiteSecret == "" || (cfg.Mode != "" && cfg.Mode != "http" && cfg.Mode != "tcp" && cfg.Mode != "udp") {
		fail("invalid_config")
	}
	urls := []string{cfg.Endpoint}
	if cfg.Mode != "udp" {
		urls = append(urls, cfg.PublicOrigin)
	}
	for _, raw := range urls {
		u, err := url.Parse(raw)
		if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" {
			fail("invalid_config")
		}
	}
	if cfg.Mode == "udp" && (cfg.PublicHost == "" || cfg.PublicPort < 1 || cfg.PublicPort > 65535 || (net.ParseIP(cfg.PublicHost) == nil && strings.ContainsAny(cfg.PublicHost, " /:@\r\n")) || cfg.ExpiresAt <= time.Now().UnixMilli() || (bridge.PacketLimits{MaximumDatagramBytes: cfg.MaximumDatagramBytes, MaximumPeers: cfg.MaximumPeers, IdleTimeout: time.Duration(cfg.IdleTimeoutMS) * time.Millisecond, MaximumBytes: cfg.MaximumBytes}).Validate() != nil) {
		fail("invalid_config")
	}
	websocket.LinkspanCarrierTarget = cfg.LocalAddress
	websocket.LinkspanCarrierProtocol = "tcp"
	idle := 30 * time.Second
	if cfg.Mode == "udp" {
		websocket.LinkspanCarrierProtocol = "udp"
		proxy.LinkspanMaximumUDPPeers = cfg.MaximumPeers
		proxy.LinkspanUDPSlots = make(chan struct{}, cfg.MaximumPeers)
		proxy.LinkspanMaximumDatagramBytes = cfg.MaximumDatagramBytes
		idle = time.Duration(cfg.IdleTimeoutMS) * time.Millisecond
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() { _, _ = io.Copy(io.Discard, os.Stdin); stop() }()
	if cfg.Mode == "udp" {
		deadline, cancel := context.WithDeadline(ctx, time.UnixMilli(cfg.ExpiresAt))
		defer cancel()
		ctx = deadline
	}
	var once sync.Once
	newt.LinkspanCarrierReady = func() {
		once.Do(func() {
			if cfg.Mode == "udp" {
				_ = json.NewEncoder(os.Stdout).Encode(map[string]interface{}{"type": "ready", "protocol": "udp", "publicHost": cfg.PublicHost, "publicPort": cfg.PublicPort})
			} else {
				_ = json.NewEncoder(os.Stdout).Encode(map[string]string{"type": "ready", "publicOrigin": cfg.PublicOrigin})
			}
		})
	}
	instance, err := newt.Init(ctx, newt.Config{Version: "1.19.0-linkspan.1", Agent: "linkspan", AgentVersion: "0.1.0", LogLevel: "ERROR", Endpoint: cfg.Endpoint, ID: cfg.SiteID, Secret: cfg.SiteSecret,
		MTU: 1280, InterfaceName: "linkspan-public", DisableClients: true, DisableSSH: true, UseNativeInterface: false, UseNativeMainInterface: false, EnforceHealthcheckCert: true,
		PingInterval: 15 * time.Second, PingTimeout: 5 * time.Second, UDPProxyIdleTimeout: idle})
	if err != nil {
		fail("connection_failed")
	}
	defer instance.Close()
	instance.Start(ctx)
}

func fail(code string) {
	_ = json.NewEncoder(os.Stdout).Encode(map[string]string{"type": "error", "code": code})
	os.Exit(1)
}
