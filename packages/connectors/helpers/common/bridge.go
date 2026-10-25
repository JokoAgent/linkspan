package connectorbridge

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"strconv"
	"sync"
)

// ReadConfig accepts one bounded private JSON object and no additional inputs.
func ReadConfig(path string, value any) error {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() < 2 || info.Size() > 65536 { return errors.New("invalid_config") }
	f, err := os.Open(path)
	if err != nil { return errors.New("invalid_config") }
	defer f.Close()
	d := json.NewDecoder(io.LimitReader(f, 65537)); d.DisallowUnknownFields()
	if d.Decode(value) != nil { return errors.New("invalid_config") }
	var extra any
	if d.Decode(&extra) != io.EOF { return errors.New("invalid_config") }
	return nil
}

func ValidateAddress(address string) error {
	host, portText, err := net.SplitHostPort(address)
	port, parseErr := strconv.Atoi(portText)
	if err != nil || parseErr != nil || port < 1 || port > 65535 || (host != "127.0.0.1" && host != "::1") { return errors.New("invalid_target") }
	return nil
}

// Only this immutable loopback destination is ever dialed. Remote peer messages
// are application ciphertext and cannot supply a second destination.
func Serve(ctx context.Context, listener net.Listener, address string) error {
	if ValidateAddress(address) != nil { return errors.New("invalid_target") }
	ctx, cancel := context.WithCancel(ctx)
	var mu sync.Mutex
	active := make(map[net.Conn]struct{})
	var workers sync.WaitGroup
	stopped := make(chan struct{})
	defer close(stopped)
	go func() {
		select { case <-ctx.Done(): case <-stopped: return }
		listener.Close()
		mu.Lock(); for conn := range active { conn.Close() }; mu.Unlock()
	}()
	slots := make(chan struct{}, 128)
	defer func() {
		cancel(); listener.Close()
		mu.Lock(); for conn := range active { conn.Close() }; mu.Unlock()
		workers.Wait()
	}()
	for {
		incoming, err := listener.Accept()
		if err != nil { if ctx.Err() != nil { return nil }; return errors.New("listener_failed") }
		select { case slots <- struct{}{}: default: incoming.Close(); continue }
		mu.Lock(); active[incoming] = struct{}{}; mu.Unlock()
		workers.Add(1)
		go func() {
			defer workers.Done(); defer func() { <-slots }(); defer incoming.Close()
			defer func() { mu.Lock(); delete(active, incoming); mu.Unlock() }()
			outgoing, err := (&net.Dialer{}).DialContext(ctx, "tcp", address)
			if err != nil { return }
			defer outgoing.Close()
			mu.Lock(); active[outgoing] = struct{}{}; mu.Unlock()
			defer func() { mu.Lock(); delete(active, outgoing); mu.Unlock() }()
			done := make(chan struct{})
			go func() { _, _ = io.CopyBuffer(outgoing, incoming, make([]byte, 32768)); closeWrite(outgoing); close(done) }()
			_, _ = io.CopyBuffer(incoming, outgoing, make([]byte, 32768)); closeWrite(incoming)
			incoming.Close(); outgoing.Close(); <-done
		}()
	}
}

func closeWrite(conn net.Conn) { if writer, ok := conn.(interface { CloseWrite() error }); ok { _ = writer.CloseWrite() } }
