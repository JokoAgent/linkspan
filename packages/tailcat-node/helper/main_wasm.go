//go:build js && wasm

package main

import (
    "encoding/json"
    "syscall/js"
    "github.com/JokoAgent/linkspan/tailcat-helper/engine"
)

func main() {
    backend := engine.New()
    handler := js.FuncOf(func(this js.Value,args []js.Value) any {
        if len(args)!=1 { return js.Global().Get("Promise").Call("reject","invalid_argument") }
        text := args[0].String()
        if len(text)>512*1024 { return js.Global().Get("Promise").Call("reject","resource_exhausted") }
        var executor js.Func
        executor = js.FuncOf(func(this js.Value,callbacks []js.Value) any {
            resolve := callbacks[0]
            go func() {
                var request engine.Request
                if json.Unmarshal([]byte(text),&request)!=nil { resolve.Invoke(`{"error":"invalid_argument","result":null}`); return }
                reply := backend.Handle(request)
                result,_ := json.Marshal(reply)
                resolve.Invoke(string(result))
            }()
            return nil
        })
        promise := js.Global().Get("Promise").New(executor); executor.Release(); return promise
    })
    js.Global().Set("linkspanTailcatRequest",handler)
    select{}
}
