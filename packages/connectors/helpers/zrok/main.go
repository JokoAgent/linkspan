package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/go-openapi/runtime"
	httptransport "github.com/go-openapi/runtime/client"
	"github.com/go-openapi/strfmt"

	"github.com/openziti/sdk-golang/ziti"
	"github.com/openziti/transport/v2"
	"github.com/openziti/transport/v2/tcp"
	"github.com/openziti/transport/v2/udp"
	"github.com/openziti/zrok/v2/environment"
	"github.com/openziti/zrok/v2/environment/env_core"
	"github.com/openziti/zrok/v2/rest_client_zrok"
	"github.com/openziti/zrok/v2/rest_client_zrok/metadata"
	"github.com/openziti/zrok/v2/sdk/golang/sdk"
)

type boundedRoot struct {
	env_core.Root
	mu     sync.Mutex
	client *rest_client_zrok.Zrok
}
type boundedTransport struct{ transport *http.Transport }

func (b boundedTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	response, err := b.transport.RoundTrip(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 256*1024+1))
	if err != nil || len(body) > 256*1024 {
		return nil, errors.New("bounded_response_failed")
	}
	response.Body = io.NopCloser(bytes.NewReader(body))
	return response, nil
}
func (b *boundedRoot) Client() (*rest_client_zrok.Zrok, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.client != nil {
		return b.client, nil
	}
	endpoint, _ := b.ApiEndpoint()
	u, err := url.Parse(endpoint)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" {
		return nil, errors.New("invalid_api_endpoint")
	}
	httpClient := &http.Client{Timeout: 2 * time.Second, Transport: boundedTransport{&http.Transport{Proxy: nil, MaxResponseHeaderBytes: 16384, MaxConnsPerHost: 2}}, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return errors.New("redirect_refused") }}
	transport := httptransport.NewWithClient(u.Host, "/api/v2", []string{"https"}, httpClient)
	transport.Producers["application/zrok.v1+json"] = runtime.JSONProducer()
	transport.Consumers["application/zrok.v1+json"] = runtime.JSONConsumer()
	client := rest_client_zrok.New(transport, strfmt.Default)
	params := metadata.NewClientVersionCheckParams()
	params.Body.ClientVersion = "v2.0.8"
	if _, err := client.Metadata.ClientVersionCheck(params); err != nil {
		return nil, errors.New("version_check_failed")
	}
	b.client = client
	return client, nil
}

type config struct {
	Action        string `json:"action"`
	RequestID     string `json:"requestId"`
	LocalAddress  string `json:"localAddress"`
	Mode          string `json:"mode"`
	NameSelection string `json:"nameSelection"`
	ResourceID    string `json:"resourceId"`
	ResourceOwner string `json:"resourceOwner"`
}

func emit(kind string, values map[string]string) {
	values["type"] = kind
	_ = json.NewEncoder(os.Stdout).Encode(values)
}
func code(err error) int {
	var coded interface{ Code() int }
	if errors.As(err, &coded) {
		return coded.Code()
	}
	return 0
}
func owned(root env_core.Root, cfg config) bool {
	parts := strings.SplitN(cfg.ResourceOwner, ":", 2)
	return cfg.ResourceID != "" && len(parts) == 2 && len(parts[0]) == 64 && root.Environment().ZitiIdentity == parts[1]
}
func owner(root env_core.Root) string {
	hash := sha256.Sum256([]byte(root.Environment().AccountToken))
	return hex.EncodeToString(hash[:]) + ":" + root.Environment().ZitiIdentity
}
func cleanup(root env_core.Root, cfg config) error {
	if !owned(root, cfg) {
		return errors.New("identity_mismatch")
	}
	detail, err := sdk.GetShareDetail(root, cfg.ResourceID)
	if err != nil {
		if code(err) == 404 && cfg.ResourceOwner == owner(root) {
			emit("retired", map[string]string{"resourceId": cfg.ResourceID})
			return nil
		}
		return errors.New("outcome_unknown")
	}
	if detail == nil || detail.ShareToken != cfg.ResourceID || detail.EnvZID != root.Environment().ZitiIdentity || detail.ShareMode != string(sdk.PublicShareMode) || detail.BackendMode != string(sdk.ProxyBackendMode) {
		return errors.New("identity_mismatch")
	}
	if sdk.DeleteShare(root, &sdk.Share{Token: cfg.ResourceID}) != nil {
		return errors.New("outcome_unknown")
	}
	emit("retired", map[string]string{"resourceId": cfg.ResourceID})
	return nil
}
func serve(ctx context.Context, root env_core.Root, cfg config) error {
	host, port, err := net.SplitHostPort(cfg.LocalAddress)
	if err != nil || host != "127.0.0.1" || port == "" {
		return errors.New("invalid_config")
	}
	request := &sdk.ShareRequest{BackendMode: sdk.ProxyBackendMode, ShareMode: sdk.PublicShareMode, PermissionMode: sdk.OpenPermissionMode, Target: "http://" + cfg.LocalAddress}
	selection := "public"
	if cfg.Mode == "reserved" {
		selection = cfg.NameSelection
	}
	nss, err := sdk.ParseNameSelection(selection)
	if err != nil {
		return errors.New("invalid_config")
	}
	request.NameSelections = []sdk.NameSelection{nss}
	share, err := sdk.CreateShare(root, request)
	if err != nil {
		if code(err) == 401 || code(err) == 403 {
			return errors.New("authentication_failed")
		}
		return errors.New("outcome_unknown")
	}
	cfg.ResourceID = share.Token
	cfg.ResourceOwner = owner(root)
	emit("resource", map[string]string{"resourceId": cfg.ResourceID, "resourceOwner": cfg.ResourceOwner})
	retired := false
	defer func() {
		if !retired {
			if cleanup(root, cfg) != nil {
				emit("error", map[string]string{"code": "outcome_unknown"})
			}
		}
	}()
	identity, err := root.ZitiIdentityNamed(root.EnvironmentIdentityName())
	if err != nil {
		return errors.New("connection_failed")
	}
	zcfg, err := ziti.NewConfigFromFile(identity)
	if err != nil {
		return errors.New("connection_failed")
	}
	peer, err := ziti.NewContext(zcfg)
	if err != nil {
		return errors.New("connection_failed")
	}
	defer peer.Close()
	go func() { <-ctx.Done(); peer.Close() }()
	listener, err := peer.ListenWithOptions(share.Token, &ziti.ListenOptions{ConnectTimeout: 25 * time.Second, WaitForNEstablishedListeners: 1})
	if err != nil {
		return errors.New("connection_failed")
	}
	defer listener.Close()
	target, _ := url.Parse("http://" + cfg.LocalAddress)
	proxy := httputil.NewSingleHostReverseProxy(target)
	proxy.Transport = &http.Transport{Proxy: nil, DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
		return (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, "tcp", cfg.LocalAddress)
	}, MaxConnsPerHost: 128, ResponseHeaderTimeout: 30 * time.Second}
	proxy.ErrorLog = log.New(io.Discard, "", 0)
	proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, _ error) { w.WriteHeader(http.StatusBadGateway) }
	server := &http.Server{Handler: proxy, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 120 * time.Second, MaxHeaderBytes: 16384, ErrorLog: log.New(io.Discard, "", 0)}
	ended := make(chan error, 1)
	go func() { ended <- server.Serve(&boundedListener{Listener: listener, slots: make(chan struct{}, 128)}) }()
	public := ""
	for _, endpoint := range share.FrontendEndpoints {
		if strings.HasPrefix(endpoint, "https://") {
			public = endpoint
			break
		}
	}
	if public == "" {
		return errors.New("connection_failed")
	}
	emit("ready", map[string]string{"publicOrigin": public, "resourceId": cfg.ResourceID, "resourceOwner": cfg.ResourceOwner})
	select {
	case <-ctx.Done():
	case <-ended:
	}
	_ = server.Close()
	_ = listener.Close()
	peer.Close()
	if cleanup(root, cfg) != nil {
		return errors.New("outcome_unknown")
	}
	retired = true
	return nil
}

type boundedListener struct {
	net.Listener
	slots chan struct{}
}
type boundedConnection struct {
	net.Conn
	once    sync.Once
	release func()
}

func (c *boundedConnection) Close() error { err := c.Conn.Close(); c.once.Do(c.release); return err }
func (l *boundedListener) Accept() (net.Conn, error) {
	for {
		conn, err := l.Listener.Accept()
		if err != nil {
			return nil, err
		}
		select {
		case l.slots <- struct{}{}:
			return &boundedConnection{Conn: conn, release: func() { <-l.slots }}, nil
		default:
			conn.Close()
		}
	}
}
func main() {
	log.SetOutput(io.Discard)
	transport.AddAddressParser(tcp.AddressParser{})
	transport.AddAddressParser(udp.AddressParser{})
	path := flag.String("config", "", "private configuration file")
	flag.Parse()
	var cfg config
	if !filepath.IsAbs(*path) || flag.NArg() != 0 {
		fail("invalid_config")
	}
	file, err := os.Open(*path)
	if err != nil {
		fail("invalid_config")
	}
	decoder := json.NewDecoder(io.LimitReader(file, 65537))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&cfg) != nil {
		file.Close()
		fail("invalid_config")
	}
	file.Close()
	environmentRoot, err := environment.LoadRoot()
	if err != nil || !environmentRoot.IsEnabled() {
		fail("invalid_config")
	}
	root := &boundedRoot{Root: environmentRoot}
	if cfg.Action == "cleanup" {
		if cleanup(root, cfg) != nil {
			fail("outcome_unknown")
		}
		return
	}
	if cfg.Action != "serve" || cfg.RequestID == "" || (cfg.Mode != "public" && cfg.Mode != "reserved") {
		fail("invalid_config")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() { _, _ = io.Copy(io.Discard, os.Stdin); stop() }()
	if err := serve(ctx, root, cfg); err != nil {
		fail(err.Error())
	}
}
func fail(code string) { emit("error", map[string]string{"code": code}); os.Exit(1) }
