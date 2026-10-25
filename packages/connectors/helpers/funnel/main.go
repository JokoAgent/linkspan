package main

import (
	"bytes"
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
	"sync"
	"syscall"
	"time"

	bridge "linkspan.invalid/connectorbridge"
	"tailscale.com/client/local"
	"tailscale.com/ipn"
	"tailscale.com/ipn/store"
	"tailscale.com/tsnet"
)

type config struct {
	RequestID      string `json:"requestId"`
	LocalAddress   string `json:"localAddress"`
	Hostname       string `json:"hostname"`
	AuthKey        string `json:"authKey"`
	StateDirectory string `json:"stateDirectory"`
	Port           int    `json:"port"`
	Mode           string `json:"mode"`
}

// Node enrollment and identity remain in the upstream FileStore. Serve targets
// exist only for this helper occurrence: even an old persisted profile must not
// reopen yesterday's ephemeral bridge port before the new host approves one.
type transientServeStore struct {
	durable ipn.StateStore
	mu      sync.RWMutex
	serve   map[ipn.StateKey][]byte
}

func (s *transientServeStore) ReadState(id ipn.StateKey) ([]byte, error) {
	if !strings.HasPrefix(string(id), "_serve/") {
		return s.durable.ReadState(id)
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	value, ok := s.serve[id]
	if !ok {
		return nil, ipn.ErrStateNotExist
	}
	return bytes.Clone(value), nil
}

func (s *transientServeStore) WriteState(id ipn.StateKey, value []byte) error {
	if !strings.HasPrefix(string(id), "_serve/") {
		return s.durable.WriteState(id, value)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if value == nil {
		delete(s.serve, id)
	} else {
		if s.serve == nil {
			s.serve = make(map[ipn.StateKey][]byte)
		}
		s.serve[id] = bytes.Clone(value)
	}
	return nil
}

func funnelDomain(value string) (string, error) {
	host := strings.ToLower(strings.TrimSuffix(value, "."))
	labels := strings.Split(host, ".")
	if len(host) > 253 || len(labels) < 3 || !strings.HasSuffix(host, ".ts.net") {
		return "", errUnavailable{}
	}
	for _, label := range labels {
		if len(label) < 1 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return "", errUnavailable{}
		}
		for _, character := range label {
			if character != '-' && (character < 'a' || character > 'z') && (character < '0' || character > '9') {
				return "", errUnavailable{}
			}
		}
	}
	return host, nil
}

func rawFunnelConfig(cfg config, domain string) (*ipn.ServeConfig, error) {
	host, err := funnelDomain(domain)
	if err != nil || bridge.ValidateAddress(cfg.LocalAddress) != nil || (cfg.Port != 443 && cfg.Port != 8443 && cfg.Port != 10000) {
		return nil, errUnavailable{}
	}
	return &ipn.ServeConfig{
		TCP:         map[uint16]*ipn.TCPPortHandler{uint16(cfg.Port): {TCPForward: cfg.LocalAddress}},
		AllowFunnel: map[ipn.HostPort]bool{ipn.HostPort(net.JoinHostPort(host, strconv.Itoa(cfg.Port))): true},
	}, nil
}

func publishRawFunnel(ctx context.Context, client *local.Client, cfg config, domain string) error {
	selected, err := rawFunnelConfig(cfg, domain)
	if err != nil {
		return err
	}
	// Replace with the one host-approved destination. Never merge platform or
	// persisted Serve/Web/foreground targets, and never terminate the host TLS.
	return client.SetServeConfig(ctx, selected)
}

func run(ctx context.Context, cfg config) error {
	if cfg.Mode == "" {
		cfg.Mode = "http"
	}
	if (cfg.Mode != "http" && cfg.Mode != "tcp") || bridge.ValidateAddress(cfg.LocalAddress) != nil {
		return errUnavailable{}
	}
	expectedHost, err := funnelDomain(cfg.Hostname)
	if err != nil {
		return err
	}
	durable, err := store.NewFileStore(func(string, ...any) {}, filepath.Join(cfg.StateDirectory, "tailscaled.state"))
	if err != nil {
		return err
	}
	server := &tsnet.Server{Dir: cfg.StateDirectory, Hostname: strings.SplitN(expectedHost, ".", 2)[0], AuthKey: cfg.AuthKey,
		Store: &transientServeStore{durable: durable},
		Logf:  func(string, ...any) {}, UserLogf: func(string, ...any) {}}
	defer server.Close()
	stopped := make(chan struct{})
	defer close(stopped)
	go func() {
		select {
		case <-ctx.Done():
			_ = server.Close()
		case <-stopped:
		}
	}()
	status, err := server.Up(ctx)
	if err != nil || status == nil || status.Self == nil || len(status.CertDomains) == 0 {
		return errUnavailable{}
	}
	host, err := funnelDomain(status.CertDomains[0])
	if err != nil || host != expectedHost {
		return errUnavailable{}
	}
	if err = ipn.CheckFunnelAccess(uint16(cfg.Port), status.Self); err != nil {
		return errUnavailable{}
	}
	var listener net.Listener
	if cfg.Mode == "tcp" {
		client, err := server.LocalClient()
		if err != nil {
			return err
		}
		if err = publishRawFunnel(ctx, client, cfg, host); err != nil {
			return err
		}
		defer func() {
			cleanup, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			_ = client.SetServeConfig(cleanup, nil)
		}()
	} else {
		listener, err = server.ListenFunnel("tcp", ":"+strconv.Itoa(cfg.Port), tsnet.FunnelOnly())
		if err != nil {
			return err
		}
		defer listener.Close()
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	publicHost := host
	if cfg.Port != 443 {
		publicHost = net.JoinHostPort(host, strconv.Itoa(cfg.Port))
	}
	if err = json.NewEncoder(os.Stdout).Encode(map[string]string{"type": "ready", "publicOrigin": (&url.URL{Scheme: "https", Host: publicHost}).String()}); err != nil {
		return err
	}
	if cfg.Mode == "tcp" {
		<-ctx.Done()
		return nil
	}
	return bridge.Serve(ctx, listener, cfg.LocalAddress)
}

type errUnavailable struct{}

func (errUnavailable) Error() string { return "unavailable" }

func main() {
	log.SetOutput(io.Discard)
	path := flag.String("config", "", "private configuration file")
	flag.Parse()
	var cfg config
	if flag.NArg() != 0 || !filepath.IsAbs(*path) || bridge.ReadConfig(*path, &cfg) != nil || bridge.ValidateAddress(cfg.LocalAddress) != nil ||
		cfg.RequestID == "" || cfg.Hostname == "" || cfg.AuthKey == "" || !filepath.IsAbs(cfg.StateDirectory) || (cfg.Port != 443 && cfg.Port != 8443 && cfg.Port != 10000) {
		fail("invalid_config")
	}
	if cfg.Mode != "" && cfg.Mode != "http" && cfg.Mode != "tcp" {
		fail("invalid_config")
	}
	if _, err := funnelDomain(cfg.Hostname); err != nil {
		fail("invalid_config")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() { _, _ = io.Copy(io.Discard, os.Stdin); stop() }()
	if run(ctx, cfg) != nil {
		fail("connection_failed")
	}
}

func fail(code string) {
	_ = json.NewEncoder(os.Stdout).Encode(map[string]string{"type": "error", "code": code})
	os.Exit(1)
}
