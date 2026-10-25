package connectorbridge

import (
	"context"
	"net"
	"testing"
	"time"
)

func TestPacketsKeepPeerIdentityAndBoundaries(t *testing.T) {
	target, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer target.Close()
	go func() {
		b := make([]byte, 4096)
		for {
			n, remote, err := target.ReadFrom(b)
			if err != nil {
				return
			}
			target.WriteTo(append([]byte("reply:"), b[:n]...), remote)
		}
	}()
	listener, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ended := make(chan error, 1)
	go func() {
		ended <- ServePacket(ctx, listener, target.LocalAddr().String(), PacketLimits{MaximumDatagramBytes: 1024, MaximumPeers: 2, IdleTimeout: time.Second, MaximumBytes: 65536})
	}()
	for _, message := range []string{"first", "second"} {
		client, err := net.Dial("udp", listener.LocalAddr().String())
		if err != nil {
			t.Fatal(err)
		}
		client.SetDeadline(time.Now().Add(2 * time.Second))
		client.Write([]byte(message))
		b := make([]byte, 1024)
		n, err := client.Read(b)
		client.Close()
		if err != nil || string(b[:n]) != "reply:"+message {
			t.Fatalf("packet identity changed: %q %v", b[:n], err)
		}
	}
	cancel()
	select {
	case err := <-ended:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("owned packet sockets did not close")
	}
}
