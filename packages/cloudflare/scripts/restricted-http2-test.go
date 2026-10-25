package connection

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/rs/zerolog"
	"github.com/cloudflare/cloudflared/tracing"
	"github.com/cloudflare/cloudflared/tunnelrpc/pogs"
)

type linkspanRestrictedProbe struct {
	configurationUpdates int
	tcpRequests int
	httpRequests int
}

func (p *linkspanRestrictedProbe) GetConfigJSON() ([]byte, error) { return []byte(`{}`), nil }
func (p *linkspanRestrictedProbe) GetOriginProxy() (OriginProxy, error) { return p, nil }
func (p *linkspanRestrictedProbe) UpdateConfig(version int32, config []byte) *pogs.UpdateConfigurationResponse {
	p.configurationUpdates++
	return &pogs.UpdateConfigurationResponse{LastAppliedVersion: version}
}
func (p *linkspanRestrictedProbe) ProxyTCP(context.Context, ReadWriteAcker, *TCPRequest) error {
	p.tcpRequests++
	return nil
}
func (p *linkspanRestrictedProbe) ProxyHTTP(w ResponseWriter, tr *tracing.TracedHTTPRequest, websocket bool) error {
	p.httpRequests++
	return w.WriteRespHeaders(http.StatusOK, http.Header{})
}

// Exercise the actual edge HTTP/2 handler, including forged internal headers.
// Rejecting before dispatch proves neither the new ingress nor arbitrary TCP
// destination can reach an origin dialer. Ordinary HTTP/WSS dispatch remains.
func TestLinkspanRestrictedHTTP2Carrier(t *testing.T) {
	for _, test := range []struct { name, header, value string } {
		{"remote ingress", InternalUpgradeHeader, ConfigurationUpdate},
		{"arbitrary TCP", InternalTCPProxySrcHeader, "warp"},
	} {
		t.Run(test.name, func(t *testing.T) {
			probe := &linkspanRestrictedProbe{}
			log := zerolog.Nop()
			connection := &HTTP2Connection{orchestrator: probe, log: &log}
			request := httptest.NewRequest(http.MethodPut, "http://169.254.169.254/latest/meta-data", strings.NewReader(`{"version":999,"config":{"ingress":[{"service":"http://169.254.169.254"}]}}`))
			request.Header.Set(test.header, test.value)
			response := httptest.NewRecorder()
			connection.ServeHTTP(response, request)
			if response.Code != http.StatusBadGateway || probe.configurationUpdates != 0 || probe.tcpRequests != 0 || probe.httpRequests != 0 {
				t.Fatalf("forbidden edge request reached dispatch: response=%d probe=%+v", response.Code, probe)
			}
		})
	}
	for _, websocket := range []bool{false, true} {
		probe := &linkspanRestrictedProbe{}
		log := zerolog.Nop()
		connection := &HTTP2Connection{orchestrator: probe, log: &log}
		request := httptest.NewRequest(http.MethodGet, "http://published.example/linkspan", nil)
		if websocket { request.Header.Set(InternalUpgradeHeader, WebsocketUpgrade) }
		response := httptest.NewRecorder()
		connection.ServeHTTP(response, request)
		if response.Code != http.StatusOK || probe.httpRequests != 1 { t.Fatalf("ordinary carrier request did not dispatch: %d", response.Code) }
	}
}
