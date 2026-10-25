package proxy

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/rs/zerolog"
	"github.com/cloudflare/cloudflared/ingress"
	"github.com/cloudflare/cloudflared/tracing"
)

type linkspanCountingOrigin struct { calls int }
func (o *linkspanCountingOrigin) RoundTrip(req *http.Request) (*http.Response, error) {
	o.calls++
	return &http.Response{StatusCode: http.StatusOK, Header: http.Header{}, Body: io.NopCloser(strings.NewReader("allowed"))}, nil
}

func TestLinkspanRestrictedManagementOrigin(t *testing.T) {
	origin := &linkspanCountingOrigin{}
	service := ingress.MockOriginHTTPService{Transport: origin}
	rules := ingress.Ingress{
		InternalRules: []ingress.Rule{{Hostname: "management.argotunnel.com", Service: service}},
		Rules: []ingress.Rule{{Service: service}},
	}
	log := zerolog.Nop()
	proxy := NewOriginProxy(rules, nil, nil, nil, &log)
	for _, path := range []string{"/logs", "/host_details", "/ping", "/metrics", "/debug/pprof/heap"} {
		request := httptest.NewRequest(http.MethodGet, "https://management.argotunnel.com" + path, nil)
		err := proxy.ProxyHTTP(newMockHTTPRespWriter(), tracing.NewTracedHTTPRequest(request, 0, &log), false)
		if err == nil || origin.calls != 0 { t.Fatalf("internal management route dispatched: %s %v", path, err) }
	}
	request := httptest.NewRequest(http.MethodGet, "https://published.example/linkspan", nil)
	if err := proxy.ProxyHTTP(newMockHTTPRespWriter(), tracing.NewTracedHTTPRequest(request, 0, &log), false); err != nil || origin.calls != 1 {
		t.Fatalf("normal fixed-origin carrier did not dispatch: %v, calls=%d", err, origin.calls)
	}
}
