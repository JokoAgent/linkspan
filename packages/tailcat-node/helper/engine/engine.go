package engine

import (
    "context"
    "encoding/base64"
    "encoding/json"
    "errors"
    "fmt"
    "io"
    "net"
    "net/netip"
    "sync"
    "sync/atomic"
    "time"

    "github.com/tailscale/tailcat"
    "tailscale.com/types/key"
)

const MaxBytes = 128 * 1024

type Request struct {
    ID uint64 `json:"id"`
    Method string `json:"method"`
    Args json.RawMessage `json:"args"`
    Deadline int64 `json:"deadline,omitempty"`
}
type Reply struct {
    ID uint64 `json:"id"`
    Result any `json:"result"`
    Error string `json:"error,omitempty"`
}
type Params struct {
    Handle string `json:"handle"`
    Address string `json:"address"`
    ExpectedEndpointID string `json:"expectedEndpointId"`
    Port int `json:"port"`
    ClientKey string `json:"clientKey"`
    ServerKey string `json:"serverKey"`
    PresharedKey string `json:"presharedKey"`
    AllowedClients []string `json:"allowedClients"`
    AllowPrivateAddressPairing bool `json:"allowPrivateAddressPairing"`
    DERPMapURL string `json:"derpMapUrl"`
    RegionID int `json:"regionId"`
    Data string `json:"data"`
    CancelID uint64 `json:"cancelId"`
}
type stream struct { conn net.Conn; release func() error; readMu sync.Mutex; writeMu sync.Mutex }
type listener struct { ln net.Listener; server *tailcat.Server; acceptMu sync.Mutex }
type clientLease struct {client *tailcat.Client;references int;closed bool;privateKey string;address string}
type Engine struct {
    mu sync.Mutex
    next atomic.Uint64
    streams map[string]*stream
    listeners map[string]*listener
    clients map[string]*clientLease
    cancelled map[uint64]context.CancelFunc
    closed bool
}
func New() *Engine { return &Engine{streams: map[string]*stream{}, listeners: map[string]*listener{},clients:map[string]*clientLease{}, cancelled: map[uint64]context.CancelFunc{}} }
func quiet(string, ...any) {}
func (e *Engine) handleName() string { return fmt.Sprintf("%d", e.next.Add(1)) }
func (e *Engine) addStream(s *stream) (string, error) {
    e.mu.Lock()
    if e.closed || len(e.streams) >= 128 { e.mu.Unlock();s.conn.Close(); if s.release != nil { s.release() }; return "", errors.New("resource_exhausted") }
    handle := e.handleName(); e.streams[handle] = s;e.mu.Unlock(); return handle, nil
}
func(e *Engine) borrowClient(p Params)(*tailcat.Client,func()error,error){
    name:=p.Address+"\x00"+p.ClientKey
    e.mu.Lock()
    if e.closed{e.mu.Unlock();return nil,nil,errors.New("closed")}
    selected:=e.clients[name]
    if selected==nil{
        if len(e.clients)>=128{e.mu.Unlock();return nil,nil,errors.New("resource_exhausted")}
        if p.ClientKey!=""{for _,other:=range e.clients{if other.privateKey==p.ClientKey&&other.address!=p.Address{e.mu.Unlock();return nil,nil,errors.New("invalid_argument")}}}
        client:=tailcat.NewClient(tailcat.Addr(p.Address));client.Logf=quiet;client.DERPMapURL=p.DERPMapURL
        if p.ClientKey!=""{if client.Key.UnmarshalText([]byte(p.ClientKey))!=nil||client.Key.IsZero(){e.mu.Unlock();return nil,nil,errors.New("invalid_argument")}}
        selected=&clientLease{client:client,privateKey:p.ClientKey,address:p.Address};e.clients[name]=selected
    }
    selected.references++;e.mu.Unlock()
    var once sync.Once
    release:=func()error{var err error;once.Do(func(){e.mu.Lock();selected.references--;closeNow:=selected.references==0&&!selected.closed;if closeNow{selected.closed=true;if e.clients[name]==selected{delete(e.clients,name)}};e.mu.Unlock();if closeNow{err=selected.client.Close()}});return err}
    return selected.client,release,nil
}
func (e *Engine) Close() {
    e.mu.Lock(); if e.closed { e.mu.Unlock(); return }; e.closed = true
    streams := e.streams; listeners := e.listeners; pending := e.cancelled;clients:=e.clients
    for _,client:=range clients{client.closed=true}
    e.streams = map[string]*stream{}; e.listeners = map[string]*listener{};e.clients=map[string]*clientLease{}; e.cancelled = map[uint64]context.CancelFunc{}
    e.mu.Unlock()
    for _, cancel := range pending { cancel() }
    for _, s := range streams { s.conn.Close(); if s.release != nil { s.release() } }
    for _, ln := range listeners { ln.ln.Close(); ln.server.Close() }
    for _,client:=range clients{client.client.Close()}
}
func (e *Engine) Handle(r Request) Reply {
    result, err := e.call(r)
    reply := Reply{ID:r.ID, Result:result}
    if err != nil {
        reply.Result = nil
        switch err.Error() {
        case "invalid_argument", "identity_mismatch", "resource_exhausted", "closed": reply.Error = err.Error()
        default:
            if errors.Is(err, context.DeadlineExceeded) { reply.Error = "deadline_exceeded" } else if errors.Is(err, context.Canceled) { reply.Error = "cancelled" } else { reply.Error = "transport_error" }
        }
    }
    return reply
}
func (e *Engine) call(r Request) (any, error) {
    var p Params
    if len(r.Args) > 512*1024 || json.Unmarshal(r.Args, &p) != nil { return nil, errors.New("invalid_argument") }
    if r.Method == "cancel" {
        e.mu.Lock(); cancel := e.cancelled[p.CancelID]; e.mu.Unlock(); if cancel != nil { cancel() }; return nil,nil
    }
    ctx, cancel := context.WithCancel(context.Background())
    if r.Deadline != 0 { var timed context.CancelFunc; ctx,timed = context.WithDeadline(ctx,time.UnixMilli(r.Deadline)); defer timed() }
    e.mu.Lock()
    if e.closed { e.mu.Unlock(); cancel(); return nil,errors.New("closed") }
    if len(e.cancelled) >= 256 { e.mu.Unlock(); cancel(); return nil,errors.New("resource_exhausted") }
    e.cancelled[r.ID] = cancel
    e.mu.Unlock()
    defer func() { cancel(); e.mu.Lock(); delete(e.cancelled,r.ID); e.mu.Unlock() }()
    if err := ctx.Err(); err != nil { return nil,err }
    switch r.Method {
    case "generateIdentity":
        priv := key.NewNode(); psk := tailcat.NewPresharedKey(); privateText,_ := priv.MarshalText()
        return map[string]any{"serverKey":string(privateText),"presharedKey":psk,"endpointId":priv.Public().String()}, nil
    case "connect":
        if p.Port < 1 || p.Port > 65535 || len(p.Address) > 8192 { return nil,errors.New("invalid_argument") }
        ci,err := tailcat.ParseAddr(tailcat.Addr(p.Address)); if err != nil || ci.PresharedKey.IsZero() { return nil,errors.New("invalid_argument") }
        if ci.ServerPublic.String() != p.ExpectedEndpointID { return nil,errors.New("identity_mismatch") }
        client,release,err:=e.borrowClient(p);if err!=nil{return nil,err}
        conn,err := client.DialTCPPort(ctx,uint16(p.Port)); if err != nil { release(); return nil,err }
        if err := ctx.Err(); err != nil { conn.Close(); release(); return nil,err }
        handle,err := e.addStream(&stream{conn:conn,release:release}); if err != nil { return nil,err }
        return map[string]any{"handle":handle,"remoteEndpointId":ci.ServerPublic.String()},nil
    case "listen":
        if p.Port < 0 || p.Port > 65535 || (len(p.AllowedClients) == 0 && !p.AllowPrivateAddressPairing) || len(p.AllowedClients) > 256 { return nil,errors.New("invalid_argument") }
        server := &tailcat.Server{Logf:quiet,DERPMapURL:p.DERPMapURL}
        if p.RegionID != 0 { server.RegionID = tailcatRegionID(p.RegionID) }
        if p.ServerKey != "" { if err := server.Key.UnmarshalText([]byte(p.ServerKey)); err != nil||server.Key.IsZero() { return nil,errors.New("invalid_argument") } }
        if p.PresharedKey != "" { if err := server.PresharedKey.UnmarshalText([]byte(p.PresharedKey)); err != nil||server.PresharedKey.IsZero() { return nil,errors.New("invalid_argument") } }
        for _, str := range p.AllowedClients { var pub key.NodePublic; if pub.UnmarshalText([]byte(str)) != nil { return nil,errors.New("invalid_argument") }; server.AllowedClients = append(server.AllowedClients,pub) }
        // No proxy/SSH/files/exit-node callbacks are installed. Only this one listener exists.
        ln,err := server.Listen(ctx,"tcp",fmt.Sprintf(":%d",p.Port)); if err != nil { server.Close(); return nil,err }
        address,err := server.TailcatAddr().Resolve(ctx); if err != nil { ln.Close(); server.Close(); return nil,err }
        _,port,err := net.SplitHostPort(ln.Addr().String()); if err != nil { ln.Close(); server.Close(); return nil,err }
        var portNumber int; fmt.Sscan(port,&portNumber)
        e.mu.Lock(); if e.closed || len(e.listeners) >= 8 { e.mu.Unlock(); ln.Close(); server.Close(); return nil,errors.New("resource_exhausted") }; handle := e.handleName(); e.listeners[handle] = &listener{ln:ln,server:server}; e.mu.Unlock()
        publicInfo,err := tailcat.ParseAddr(address); if err != nil { return nil,err }
        return map[string]any{"handle":handle,"address":string(address),"endpointId":publicInfo.ServerPublic.String(),"port":portNumber},nil
    case "accept":
        e.mu.Lock(); ln := e.listeners[p.Handle]; e.mu.Unlock(); if ln == nil { return nil,errors.New("closed") }
        if !ln.acceptMu.TryLock() { return nil,errors.New("invalid_argument") }; defer ln.acceptMu.Unlock()
        stop := context.AfterFunc(ctx,func(){ ln.ln.Close() }); defer stop()
        conn,err := ln.ln.Accept(); if err != nil { if ctx.Err()!=nil { return nil,ctx.Err() }; return nil,err }
        remote := ""
        ap,parseErr := netip.ParseAddrPort(conn.RemoteAddr().String())
        if parseErr == nil { for pub,peer := range ln.server.Status().Peer { for _,ip := range peer.TailscaleIPs { if ip == ap.Addr() { remote = pub.String(); break } } } }
        handle,err := e.addStream(&stream{conn:conn}); if err != nil { return nil,err }
        return map[string]any{"handle":handle,"remoteEndpointId":remote},nil
    case "closeListener":
        e.mu.Lock(); ln := e.listeners[p.Handle]; delete(e.listeners,p.Handle); e.mu.Unlock()
        if ln != nil { ln.ln.Close(); ln.server.Close() }; return nil,nil
    case "read", "write", "close", "abort":
        e.mu.Lock(); s := e.streams[p.Handle]; if r.Method == "close" || r.Method == "abort" { delete(e.streams,p.Handle) }; e.mu.Unlock()
        if s == nil { if r.Method == "close" || r.Method == "abort" { return nil,nil }; return nil,errors.New("closed") }
        if r.Method == "close" || r.Method == "abort" { s.conn.Close(); if s.release != nil { s.release() }; return nil,nil }
        if r.Method == "read" {
            if !s.readMu.TryLock() { return nil,errors.New("invalid_argument") }; defer s.readMu.Unlock()
            stop := context.AfterFunc(ctx,func(){ s.conn.SetReadDeadline(time.Now()) }); defer stop(); defer s.conn.SetReadDeadline(time.Time{})
            data := make([]byte,64*1024); n,err := s.conn.Read(data)
            if ctx.Err()!=nil { return nil,ctx.Err() }; if n > 0 { return base64.StdEncoding.EncodeToString(data[:n]),nil }; if errors.Is(err,io.EOF) { return nil,nil }; return nil,err
        }
        data,err := base64.StdEncoding.DecodeString(p.Data); if err != nil || len(data)>MaxBytes { return nil,errors.New("invalid_argument") }
        if !s.writeMu.TryLock() { return nil,errors.New("resource_exhausted") }; defer s.writeMu.Unlock()
        stop := context.AfterFunc(ctx,func(){ s.conn.SetWriteDeadline(time.Now()) }); defer stop(); defer s.conn.SetWriteDeadline(time.Time{})
        for len(data)>0 { n,err := s.conn.Write(data); if ctx.Err()!=nil { return nil,ctx.Err() }; if err != nil { return nil,err }; data=data[n:] }; return nil,nil
    default: return nil,errors.New("invalid_argument")
    }
}
