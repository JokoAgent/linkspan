package connectorbridge

import (
	"context"
	"io"
	"net"
	"testing"
	"time"
)

func TestFixedLoopbackOnly(t *testing.T) {
	for _, address := range []string{"metadata.internal:80", "169.254.169.254:80", "127.0.0.1:0", "127.0.0.1:65536", "localhost:443", "127.0.0.1:80/path"} {
		if ValidateAddress(address) == nil { t.Fatal("accepted non-fixed target", address) }
	}
	if ValidateAddress("127.0.0.1:12345") != nil { t.Fatal("rejected loopback target") }
}

func TestBytesAndCancellation(t *testing.T) {
	origin, err := net.Listen("tcp", "127.0.0.1:0"); if err != nil { t.Fatal(err) }; defer origin.Close()
	go func() { conn, err := origin.Accept(); if err != nil { return }; defer conn.Close(); _, _ = io.Copy(conn, conn) }()
	ingress, err := net.Listen("tcp", "127.0.0.1:0"); if err != nil { t.Fatal(err) }; defer ingress.Close()
	ctx, cancel := context.WithCancel(context.Background()); defer cancel()
	done := make(chan error, 1); go func() { done <- Serve(ctx, ingress, origin.Addr().String()) }()
	client, err := net.Dial("tcp", ingress.Addr().String()); if err != nil { t.Fatal(err) }; defer client.Close()
	_ = client.SetDeadline(time.Now().Add(3*time.Second)); _, _ = client.Write([]byte("ciphertext"))
	value := make([]byte, 10); if _, err := io.ReadFull(client, value); err != nil || string(value) != "ciphertext" { t.Fatal("byte mismatch", err) }
	cancel()
	select { case err := <-done: if err != nil { t.Fatal(err) }; case <-time.After(3*time.Second): t.Fatal("cancellation did not drain connections") }
}
