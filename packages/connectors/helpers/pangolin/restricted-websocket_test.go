package websocket

import (
	"github.com/fosrl/newt/internal/telemetry"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCarrierRejectsRemoteCapabilitiesAndTargets(t *testing.T) {
	LinkspanCarrierTarget = "127.0.0.1:43210"
	LinkspanCarrierProtocol = "tcp"
	defer func() { LinkspanCarrierTarget = "" }()
	for _, name := range []string{"newt/udp/add", "newt/healthcheck/add", "newt/wg/subnets/add", "newt/pam/connection", "newt/browsergateway/add", "newt/socket/fetch", "newt/wg/restart"} {
		if restrictLinkspanHandler(name, func(WSMessage) {}) != nil {
			t.Fatalf("unexpected remote capability %s", name)
		}
	}
	called := false
	handler := restrictLinkspanHandler("newt/wg/connect", func(message WSMessage) {
		called = true
		data := message.Data.(map[string]interface{})
		targets := data["targets"].(map[string]interface{})
		if len(targets["udp"].([]interface{})) != 0 || len(data["healthCheckTargets"].([]interface{})) != 0 {
			t.Fatal("remote UDP/healthcheck survived")
		}
		tcp := targets["tcp"].([]interface{})
		if len(tcp) != 1 || tcp[0] != "443:127.0.0.1:43210" {
			t.Fatalf("unrestricted target: %v", tcp)
		}
	})
	handler(WSMessage{Data: map[string]interface{}{"targets": map[string]interface{}{"tcp": []string{"443:169.254.169.254:80"}, "udp": []string{"53:127.0.0.1:53"}}, "healthCheckTargets": []string{"http://metadata"}}})
	if !called {
		t.Fatal("carrier lifecycle handler was not called")
	}
}

func TestCarrierUDPIsExclusiveAndKeepsTheOneOwnedTarget(t *testing.T) {
	LinkspanCarrierTarget = "127.0.0.1:43210"
	LinkspanCarrierProtocol = "udp"
	defer func() { LinkspanCarrierTarget = ""; LinkspanCarrierProtocol = "tcp" }()
	if restrictLinkspanHandler("newt/tcp/add", func(WSMessage) {}) != nil {
		t.Fatal("UDP carrier enabled TCP")
	}
	for _, name := range []string{"newt/sync", "newt/udp/add"} {
		called := false
		handler := restrictLinkspanHandler(name, func(message WSMessage) {
			called = true
			data := message.Data.(map[string]interface{})
			var targets []interface{}
			if name == "newt/sync" {
				all := data["proxyTargets"].(map[string]interface{})
				if len(all["tcp"].([]interface{})) != 0 {
					t.Fatal("TCP survived UDP sync")
				}
				targets = all["udp"].([]interface{})
			} else {
				targets = data["targets"].([]interface{})
			}
			if len(targets) != 1 || targets[0] != "12345:127.0.0.1:43210" {
				t.Fatalf("UDP target escaped fixed bridge: %v", targets)
			}
		})
		value := map[string]interface{}{"proxyTargets": map[string]interface{}{"tcp": []string{"22:10.0.0.1:22"}, "udp": []string{"12345:169.254.169.254:53"}}, "targets": []string{"12345:169.254.169.254:53"}}
		handler(WSMessage{Data: value})
		if !called {
			t.Fatal("UDP handler missing")
		}
	}
}

func TestCarrierAuthDoesNotFollowRedirectsOrReadUnboundedBodies(t *testing.T) {
	if err := telemetry.EnsureInstruments(); err != nil {
		t.Fatal(err)
	}
	for _, variant := range []string{"valid", "oversized", "redirect"} {
		t.Run(variant, func(t *testing.T) {
			redirected := 0
			other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				redirected++
				w.Write([]byte(`{"success":true,"data":{"token":"foreign"}}`))
			}))
			defer other.Close()
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if variant == "redirect" {
					http.Redirect(w, r, other.URL, http.StatusTemporaryRedirect)
					return
				}
				if variant == "oversized" {
					w.Write([]byte(strings.Repeat("x", 65537)))
					return
				}
				w.Write([]byte(`{"success":true,"data":{"token":"own-token"}}`))
			}))
			defer server.Close()
			client := &Client{baseURL: server.URL, config: &Config{ID: "dedicated-site", Secret: "test-only"}, clientType: "newt"}
			token, err := client.getToken()
			if variant == "valid" {
				if err != nil || token != "own-token" {
					t.Fatal("valid fixed-site token rejected", err)
				}
			} else if err == nil {
				t.Fatal("unbounded or redirected auth accepted")
			}
			if redirected != 0 {
				t.Fatal("provider redirect received a credential-bearing request")
			}
		})
	}
}
