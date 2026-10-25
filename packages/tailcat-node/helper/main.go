//go:build !js

package main

import (
    "bufio"
    "encoding/json"
    "os"
    "sync"
    "github.com/JokoAgent/linkspan/tailcat-helper/engine"
)

func main() {
    backend := engine.New(); defer backend.Close()
    var output sync.Mutex
    encoder := json.NewEncoder(os.Stdout)
    scanner := bufio.NewScanner(os.Stdin); scanner.Buffer(make([]byte,4096),512*1024)
    active := make(chan struct{},256)
    for scanner.Scan() {
        var request engine.Request
        if json.Unmarshal(scanner.Bytes(),&request)!=nil { return }
        select { case active <- struct{}{}: default: return }
        go func() {
            defer func(){ <-active }()
            reply := backend.Handle(request)
            output.Lock(); defer output.Unlock(); encoder.Encode(reply)
        }()
    }
}
