package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"tailscale.com/client/local"
	"tailscale.com/ipn"
	"tailscale.com/ipn/store"
)

type transportFunc func(*http.Request) (*http.Response, error)

func (f transportFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return f(request)
}

func TestRawFunnelSetsOnlyApprovedTarget(t *testing.T) {
	for _, address := range []string{"127.0.0.1:42101", "[::1]:42102"} {
		for _, port := range []int{443, 8443, 10000} {
			cfg := config{Mode: "tcp", LocalAddress: address, Port: port}
			var received ipn.ServeConfig
			called := false
			client := &local.Client{OmitAuth: true, Transport: transportFunc(func(request *http.Request) (*http.Response, error) {
				called = true
				if request.Method != "POST" || request.URL.Path != "/localapi/v0/serve-config" {
					t.Fatalf("unexpected local API mutation: %s %s", request.Method, request.URL.Path)
				}
				if err := json.NewDecoder(request.Body).Decode(&received); err != nil {
					t.Fatal(err)
				}
				return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(bytes.NewReader(nil))}, nil
			})}
			if err := publishRawFunnel(context.Background(), client, cfg, "Host.Tailnet.ts.net."); err != nil {
				t.Fatal(err)
			}
			if !called || len(received.TCP) != 1 || len(received.AllowFunnel) != 1 || len(received.Web) != 0 || len(received.Foreground) != 0 || len(received.Services) != 0 {
				t.Fatalf("unexpected published targets: %#v", received)
			}
			handler := received.TCP[uint16(port)]
			if handler == nil || handler.TCPForward != address || handler.TerminateTLS != "" || handler.HTTPS {
				t.Fatalf("raw forwarding terminated TLS or changed the host target: %#v", handler)
			}
			want, _ := rawFunnelConfig(cfg, "host.tailnet.ts.net")
			for destination, allowed := range want.AllowFunnel {
				if !allowed || !received.AllowFunnel[destination] {
					t.Fatalf("Funnel is not restricted to %s", destination)
				}
			}
		}
	}
}

func TestRawFunnelRejectsUnapprovedTargetsBeforeMutation(t *testing.T) {
	for _, address := range []string{"169.254.169.254:80", "localhost:443", "origin.example:443", "127.0.0.1:0", "127.0.0.1:65536", "127.0.0.1:443/path"} {
		if _, err := rawFunnelConfig(config{LocalAddress: address, Port: 443}, "host.tailnet.ts.net"); err == nil {
			t.Fatalf("accepted target %q", address)
		}
	}
	for _, domain := range []string{"ts.net", "host.example.com", "host.ts.net/evil", "host.ts.net:443", "bad..ts.net", "-bad.ts.net", "bad_.ts.net", "host.ts.net\n"} {
		if _, err := rawFunnelConfig(config{LocalAddress: "127.0.0.1:42101", Port: 443}, domain); err == nil {
			t.Fatalf("accepted Funnel domain %q", domain)
		}
	}
	for _, port := range []int{0, 80, 4430, 65536} {
		if _, err := rawFunnelConfig(config{LocalAddress: "127.0.0.1:42101", Port: port}, "host.tailnet.ts.net"); err == nil {
			t.Fatalf("accepted public port %d", port)
		}
	}
	client := &local.Client{OmitAuth: true, Transport: transportFunc(func(*http.Request) (*http.Response, error) {
		t.Fatal("invalid target was sent to the platform")
		return nil, nil
	})}
	if err := publishRawFunnel(context.Background(), client, config{LocalAddress: "169.254.169.254:80", Port: 443}, "host.tailnet.ts.net"); err == nil {
		t.Fatal("invalid target did not fail")
	}
}

func TestServeStateDoesNotPersistOrRestoreBridgePorts(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tailscaled.state")
	durable, err := store.NewFileStore(func(string, ...any) {}, path)
	if err != nil {
		t.Fatal(err)
	}
	// Simulate a profile written by an older helper that persisted ServeConfig.
	serveKey := ipn.StateKey("_serve/profile-one")
	if err := durable.WriteState(serveKey, []byte("stale-target:41000")); err != nil {
		t.Fatal(err)
	}
	selected := &transientServeStore{durable: durable}
	if _, err := selected.ReadState(serveKey); !errors.Is(err, ipn.ErrStateNotExist) {
		t.Fatalf("restored a stale ephemeral target: %v", err)
	}
	identity := []byte("node-identity-is-durable")
	if err := selected.WriteState(ipn.MachineKeyStateKey, identity); err != nil {
		t.Fatal(err)
	}
	if err := selected.WriteState(ipn.StateKey("profile-one"), []byte("enrollment-is-durable")); err != nil {
		t.Fatal(err)
	}
	value := []byte("current-target:42000")
	if err := selected.WriteState(serveKey, value); err != nil {
		t.Fatal(err)
	}
	value[0] = 'X'
	read, err := selected.ReadState(serveKey)
	if err != nil || string(read) != "current-target:42000" {
		t.Fatalf("caller modified stored ServeConfig: %q %v", read, err)
	}
	read[0] = 'Y'
	read, err = selected.ReadState(serveKey)
	if err != nil || string(read) != "current-target:42000" {
		t.Fatalf("read exposed writable ServeConfig memory: %q %v", read, err)
	}
	file, err := os.ReadFile(path)
	if err != nil || bytes.Contains(file, []byte("current-target")) {
		t.Fatalf("ephemeral bridge was persisted: %v", err)
	}
	reopened, err := store.NewFileStore(func(string, ...any) {}, path)
	if err != nil {
		t.Fatal(err)
	}
	afterRestart := &transientServeStore{durable: reopened}
	if _, err := afterRestart.ReadState(serveKey); !errors.Is(err, ipn.ErrStateNotExist) {
		t.Fatalf("restart reopened a Serve target: %v", err)
	}
	read, err = afterRestart.ReadState(ipn.MachineKeyStateKey)
	if err != nil || !bytes.Equal(read, identity) {
		t.Fatalf("node identity was lost: %q %v", read, err)
	}
	read, err = afterRestart.ReadState(ipn.StateKey("profile-one"))
	if err != nil || string(read) != "enrollment-is-durable" {
		t.Fatalf("enrollment was lost: %q %v", read, err)
	}
	if err := selected.WriteState(serveKey, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := selected.ReadState(serveKey); !errors.Is(err, ipn.ErrStateNotExist) {
		t.Fatalf("deletion retained ephemeral ServeConfig: %v", err)
	}
}

func TestServeStateSupportsConcurrentPlatformUpdates(t *testing.T) {
	durable, err := store.NewFileStore(func(string, ...any) {}, filepath.Join(t.TempDir(), "tailscaled.state"))
	if err != nil {
		t.Fatal(err)
	}
	selected := &transientServeStore{durable: durable}
	var updates sync.WaitGroup
	for i := 0; i < 32; i++ {
		updates.Go(func() {
			for iteration := 0; iteration < 32; iteration++ {
				if err := selected.WriteState(ipn.StateKey("_serve/profile-one"), []byte("approved")); err != nil {
					t.Error(err)
				}
				if _, err := selected.ReadState(ipn.StateKey("_serve/profile-one")); err != nil {
					t.Error(err)
				}
			}
		})
	}
	updates.Wait()
}
