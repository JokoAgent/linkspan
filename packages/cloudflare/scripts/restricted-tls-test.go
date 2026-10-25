package ingress

import (
	"encoding/pem"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"

	"github.com/rs/zerolog"
)

func TestLinkspanRestrictedFixedHTTPSOrigin(t *testing.T) {
	allowedCalls, forbiddenCalls := 0, 0
	allowed := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { allowedCalls++; w.WriteHeader(http.StatusNoContent) }))
	defer allowed.Close()
	forbidden := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { forbiddenCalls++; w.WriteHeader(http.StatusNoContent) }))
	defer forbidden.Close()
	certificate := filepath.Join(t.TempDir(), "origin.pem")
	if err := os.WriteFile(certificate, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: allowed.Certificate().Raw}), 0600); err != nil { t.Fatal(err) }
	localURL, err := url.Parse(allowed.URL)
	if err != nil { t.Fatal(err) }
	log := zerolog.Nop()
	shutdown := make(chan struct{})
	defer close(shutdown)
	configuration := OriginRequestConfig{CAPool: certificate, OriginServerName: allowed.Certificate().DNSNames[0]}
	service := &httpService{url: localURL}
	if err := service.start(&log, shutdown, configuration); err != nil { t.Fatal(err) }
	defer service.transport.CloseIdleConnections()
	for _, method := range []string{http.MethodGet, http.MethodConnect} {
		request := httptest.NewRequest(method, forbidden.URL + "/chosen-by-edge", nil)
		request.Host = "host-chosen-by-edge.invalid"
		response, err := service.RoundTrip(request)
		if err != nil { t.Fatal(err) }
		_, _ = io.Copy(io.Discard, response.Body); _ = response.Body.Close()
		if request.URL.Host != localURL.Host || request.URL.Scheme != "https" { t.Fatal("The edge replaced the configured target") }
	}
	if allowedCalls != 2 || forbiddenCalls != 0 { t.Fatalf("target escaped the configured origin: allowed=%d forbidden=%d", allowedCalls, forbiddenCalls) }
	for _, configuration := range []OriginRequestConfig{
		{CAPool: certificate, OriginServerName: "wrong-server-name.invalid"},
		{OriginServerName: allowed.Certificate().DNSNames[0]},
	} {
		service := &httpService{url: localURL}
		if err := service.start(&log, shutdown, configuration); err != nil { t.Fatal(err) }
		request := httptest.NewRequest(http.MethodGet, forbidden.URL, nil)
		response, err := service.RoundTrip(request)
		if response != nil { _ = response.Body.Close() }
		service.transport.CloseIdleConnections()
		if err == nil { t.Fatal("An untrusted CA or conflicting origin server name was accepted") }
	}
	if allowedCalls != 2 || forbiddenCalls != 0 { t.Fatal("Certificate verification dispatched HTTP before authentication") }
}
