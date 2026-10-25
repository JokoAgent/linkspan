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
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/netbirdio/netbird/client/embed"
	bridge "linkspan.invalid/connectorbridge"
)

type config struct {
	RequestID            string `json:"requestId"`
	LocalAddress         string `json:"localAddress"`
	ManagementURL        string `json:"managementUrl"`
	SetupKey             string `json:"setupKey"`
	StateDirectory       string `json:"stateDirectory"`
	ListenPort           int    `json:"listenPort"`
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

func restrictedPeer(cfg config) (*embed.Client, error) {
	deviceName := "linkspan-" + strings.ReplaceAll(cfg.RequestID, ":", "-")
	if len(deviceName) > 63 {
		deviceName = deviceName[:63]
	}
	peer, err := embed.New(embed.Options{DeviceName: deviceName, SetupKey: cfg.SetupKey, ManagementURL: cfg.ManagementURL,
		ConfigPath: filepath.Join(cfg.StateDirectory, "config.json"), StatePath: filepath.Join(cfg.StateDirectory, "state.json"),
		LogOutput: io.Discard, LogLevel: "fatal", NoUserspace: false, DisableClientRoutes: true, BlockLANAccess: true, EnableRosenpass: false})
	if err != nil {
		return nil, err
	}
	observed, err := peer.GetConfig()
	if err != nil {
		return nil, err
	}
	expected, err := url.Parse(cfg.ManagementURL)
	if err != nil {
		return nil, err
	}
	port := func(value *url.URL) string {
		if value.Port() == "" {
			return "443"
		}
		return value.Port()
	}
	if !observed.DisableClientRoutes || !observed.DisableServerRoutes || !observed.BlockLANAccess || observed.ServerSSHAllowed == nil || *observed.ServerSSHAllowed || observed.RemoteJobsAllowed == nil || *observed.RemoteJobsAllowed || observed.LocalMetricsEnabled || observed.ManagementURL == nil || observed.ManagementURL.Scheme != "https" || observed.ManagementURL.User != nil || !strings.EqualFold(observed.ManagementURL.Hostname(), expected.Hostname()) || port(observed.ManagementURL) != port(expected) || strings.TrimSuffix(observed.ManagementURL.Path, "/") != strings.TrimSuffix(expected.Path, "/") || observed.ManagementURL.RawPath != expected.RawPath || observed.ManagementURL.Opaque != "" || observed.ManagementURL.RawQuery != "" || observed.ManagementURL.Fragment != "" {
		return nil, errUnsafeConfig{}
	}
	return peer, nil
}

type errUnsafeConfig struct{}

func (errUnsafeConfig) Error() string { return "unsafe_embedded_peer_config" }
func run(ctx context.Context, cfg config) error {
	peer, err := restrictedPeer(cfg)
	if err != nil {
		return err
	}
	start, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()
	if err := peer.Start(start); err != nil {
		return err
	}
	defer func() {
		cleanup, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		_ = peer.Stop(cleanup)
	}()
	if cfg.Mode == "udp" {
		listener, err := peer.ListenUDP(":" + strconv.Itoa(cfg.ListenPort))
		if err != nil {
			return err
		}
		defer listener.Close()
		_ = json.NewEncoder(os.Stdout).Encode(map[string]interface{}{"type": "ready", "protocol": "udp", "publicHost": cfg.PublicHost, "publicPort": cfg.PublicPort})
		return bridge.ServePacket(ctx, listener, cfg.LocalAddress, bridge.PacketLimits{MaximumDatagramBytes: cfg.MaximumDatagramBytes, MaximumPeers: cfg.MaximumPeers, IdleTimeout: time.Duration(cfg.IdleTimeoutMS) * time.Millisecond, MaximumBytes: cfg.MaximumBytes})
	}
	listener, err := peer.ListenTCP(":" + strconv.Itoa(cfg.ListenPort))
	if err != nil {
		return err
	}
	defer listener.Close()
	_ = json.NewEncoder(os.Stdout).Encode(map[string]string{"type": "ready", "publicOrigin": cfg.PublicOrigin})
	return bridge.Serve(ctx, listener, cfg.LocalAddress)
}

func main() {
	log.SetOutput(io.Discard)
	path := flag.String("config", "", "private configuration file")
	flag.Parse()
	var cfg config
	if flag.NArg() != 0 || !filepath.IsAbs(*path) || bridge.ReadConfig(*path, &cfg) != nil || bridge.ValidateAddress(cfg.LocalAddress) != nil ||
		cfg.RequestID == "" || cfg.SetupKey == "" || !filepath.IsAbs(cfg.StateDirectory) || cfg.ListenPort < 1 || cfg.ListenPort > 65535 || (cfg.Mode != "" && cfg.Mode != "http" && cfg.Mode != "tls" && cfg.Mode != "tcp" && cfg.Mode != "udp") {
		fail("invalid_config")
	}
	if cfg.Mode != "udp" {
		origin, err := url.Parse(cfg.PublicOrigin)
		if err != nil || origin.Scheme != "https" || origin.Host == "" || origin.User != nil || origin.RawQuery != "" || origin.Fragment != "" || (origin.Path != "" && origin.Path != "/") {
			fail("invalid_config")
		}
	} else if cfg.PublicHost == "" || cfg.PublicPort < 1 || cfg.PublicPort > 65535 || (net.ParseIP(cfg.PublicHost) == nil && strings.ContainsAny(cfg.PublicHost, " /:@\r\n")) || cfg.ExpiresAt <= time.Now().UnixMilli() || (bridge.PacketLimits{MaximumDatagramBytes: cfg.MaximumDatagramBytes, MaximumPeers: cfg.MaximumPeers, IdleTimeout: time.Duration(cfg.IdleTimeoutMS) * time.Millisecond, MaximumBytes: cfg.MaximumBytes}).Validate() != nil {
		fail("invalid_config")
	}
	management, err := url.Parse(cfg.ManagementURL)
	if err != nil || management.Scheme != "https" || management.Host == "" || management.User != nil || management.RawQuery != "" || management.Fragment != "" {
		fail("invalid_config")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() { _, _ = io.Copy(io.Discard, os.Stdin); stop() }()
	if cfg.Mode == "udp" {
		deadline, cancel := context.WithDeadline(ctx, time.UnixMilli(cfg.ExpiresAt))
		defer cancel()
		ctx = deadline
	}
	if run(ctx, cfg) != nil {
		fail("connection_failed")
	}
}

func fail(code string) {
	_ = json.NewEncoder(os.Stdout).Encode(map[string]string{"type": "error", "code": code})
	os.Exit(1)
}
