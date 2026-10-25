// This file is installed into the fixed upstream websocket package at build time.
package websocket

import (
	"encoding/json"
	"strconv"
	"strings"
)

// LinkspanCarrierTarget is set once by the trusted host wrapper before startup.
// Platform messages and process environment cannot change it.
var LinkspanCarrierTarget string

// Selected once by the wrapper; a server cannot enable a second protocol.
var LinkspanCarrierProtocol = "tcp"

func restrictLinkspanHandler(messageType string, handler MessageHandler) MessageHandler {
	if LinkspanCarrierTarget == "" {
		return handler
	}
	switch messageType {
	case "newt/wg/connect", "newt/error", "newt/wg/reconnect", "newt/wg/terminate", "newt/ping/exitNodes", "newt/sync":
	case "newt/tcp/add", "newt/tcp/remove":
		if LinkspanCarrierProtocol != "tcp" {
			return nil
		}
	case "newt/udp/add", "newt/udp/remove":
		if LinkspanCarrierProtocol != "udp" {
			return nil
		}
	default:
		return nil
	}
	return func(message WSMessage) {
		encoded, err := json.Marshal(message.Data)
		if err != nil || len(encoded) > 1024*1024 {
			return
		}
		var data map[string]interface{}
		if json.Unmarshal(encoded, &data) != nil {
			return
		}
		for _, key := range []string{"healthCheckTargets", "browserGatewayTargets", "remoteExitNodeSubnets", "peers", "clientTargets", "certs", "clientIdentities"} {
			data[key] = []interface{}{}
		}
		for _, key := range []string{"targets", "proxyTargets"} {
			if targets, ok := data[key].(map[string]interface{}); ok {
				other := "udp"
				if LinkspanCarrierProtocol == "udp" {
					other = "tcp"
				}
				targets[other] = []interface{}{}
				targets[LinkspanCarrierProtocol] = fixedLinkspanTargets(targets[LinkspanCarrierProtocol])
				data[key] = targets
			}
		}
		if messageType == "newt/tcp/add" || messageType == "newt/tcp/remove" || messageType == "newt/udp/add" || messageType == "newt/udp/remove" {
			data["targets"] = fixedLinkspanTargets(data["targets"])
		}
		message.Data = data
		handler(message)
	}
}

func fixedLinkspanTargets(value interface{}) []interface{} {
	result := []interface{}{}
	targets, ok := value.([]interface{})
	if !ok || len(targets) > 64 {
		return result
	}
	for _, target := range targets {
		text, ok := target.(string)
		if !ok || len(text) > 1024 {
			continue
		}
		split := strings.IndexByte(text, ':')
		if split < 1 {
			continue
		}
		port, err := strconv.Atoi(text[:split])
		if err != nil || port < 1 || port > 65535 {
			continue
		}
		result = append(result, strconv.Itoa(port)+":"+LinkspanCarrierTarget)
	}
	return result
}
