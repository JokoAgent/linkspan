package connectorbridge

import (
	"context"
	"errors"
	"net"
	"sync"
	"sync/atomic"
	"time"
)

type PacketLimits struct {
	MaximumDatagramBytes int
	MaximumPeers         int
	IdleTimeout          time.Duration
	MaximumBytes         int64
}

func (l PacketLimits) Validate() error {
	if l.MaximumDatagramBytes < 256 || l.MaximumDatagramBytes > 65507 || l.MaximumPeers < 1 || l.MaximumPeers > 64 || l.IdleTimeout < time.Second || l.IdleTimeout > 120*time.Second || l.MaximumBytes < 1024 {
		return errors.New("invalid_packet_limits")
	}
	return nil
}

type packetPeer struct {
	conn   *net.UDPConn
	remote net.Addr
}

// ServePacket preserves datagram boundaries and maps each upstream tuple to a
// distinct connected socket at the one immutable loopback bridge. It exposes
// no TUN, general route, DNS resolver, or arbitrary remote-selected target.
func ServePacket(ctx context.Context, listener net.PacketConn, address string, limit PacketLimits) error {
	if ValidateAddress(address) != nil || limit.Validate() != nil {
		return errors.New("invalid_packet_target")
	}
	target, err := net.ResolveUDPAddr("udp", address)
	if err != nil {
		return errors.New("invalid_packet_target")
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var mu sync.Mutex
	peers := map[string]*packetPeer{}
	var workers sync.WaitGroup
	var total atomic.Int64
	closePeers := func() {
		mu.Lock()
		defer mu.Unlock()
		for key, peer := range peers {
			peer.conn.Close()
			delete(peers, key)
		}
	}
	done := make(chan struct{})
	defer close(done)
	go func() {
		select {
		case <-ctx.Done():
			listener.Close()
			closePeers()
		case <-done:
		}
	}()
	defer func() { cancel(); listener.Close(); closePeers(); workers.Wait() }()
	count := func(n int) bool {
		if total.Add(int64(n)) > limit.MaximumBytes {
			cancel()
			return false
		}
		return n <= limit.MaximumDatagramBytes
	}
	buffer := make([]byte, limit.MaximumDatagramBytes+1)
	for {
		n, remote, err := listener.ReadFrom(buffer)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return errors.New("packet_listener_failed")
		}
		if !count(n) {
			continue
		}
		key := remote.String()
		if len(key) > 256 {
			continue
		}
		mu.Lock()
		peer := peers[key]
		if peer == nil {
			if len(peers) >= limit.MaximumPeers {
				mu.Unlock()
				continue
			}
			conn, err := net.DialUDP("udp", nil, target)
			if err != nil {
				mu.Unlock()
				continue
			}
			peer = &packetPeer{conn: conn, remote: remote}
			peers[key] = peer
			_ = conn.SetReadDeadline(time.Now().Add(limit.IdleTimeout))
			workers.Add(1)
			go func(key string, owned *packetPeer) {
				defer workers.Done()
				defer owned.conn.Close()
				defer func() {
					mu.Lock()
					if peers[key] == owned {
						delete(peers, key)
					}
					mu.Unlock()
				}()
				reply := make([]byte, limit.MaximumDatagramBytes+1)
				for {
					n, err := owned.conn.Read(reply)
					if err != nil {
						return
					}
					if !count(n) {
						continue
					}
					_ = owned.conn.SetReadDeadline(time.Now().Add(limit.IdleTimeout))
					if _, err := listener.WriteTo(reply[:n], owned.remote); err != nil {
						return
					}
				}
			}(key, peer)
		}
		mu.Unlock()
		_ = peer.conn.SetWriteDeadline(time.Now().Add(time.Second))
		_ = peer.conn.SetReadDeadline(time.Now().Add(limit.IdleTimeout))
		_, _ = peer.conn.Write(buffer[:n])
	}
}
