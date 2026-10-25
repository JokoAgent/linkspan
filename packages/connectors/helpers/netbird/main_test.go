package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestUnsafePersistedPeerCapabilitiesAreRejectedBeforeStart(t *testing.T) {
	for _, field := range []string{"ServerSSHAllowed", "RemoteJobsAllowed", "LocalMetricsEnabled"} {
		t.Run(field, func(t *testing.T) {
			cfg := config{RequestID: "original-test", ManagementURL: "https://api.netbird.io", SetupKey: "test-no-account", StateDirectory: t.TempDir()}
			peer, err := restrictedPeer(cfg)
			if err != nil {
				t.Fatal(err)
			}
			observed, err := peer.GetConfig()
			if err != nil {
				t.Fatal(err)
			}
			content, err := json.Marshal(observed)
			if err != nil {
				t.Fatal(err)
			}
			var value map[string]interface{}
			if json.Unmarshal(content, &value) != nil {
				t.Fatal("config encoding failed")
			}
			value[field] = true
			content, err = json.Marshal(value)
			if err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(cfg.StateDirectory, "config.json")
			if os.WriteFile(path, content, 0600) != nil {
				t.Fatal("config preparation failed")
			}
			if _, err := restrictedPeer(cfg); err == nil {
				t.Fatal("unsafe persisted capability was accepted")
			}
			after, _ := os.ReadFile(path)
			var actual map[string]interface{}
			json.Unmarshal(after, &actual)
			if actual[field] != true {
				t.Fatalf("the wrapper repaired unrelated state instead of refusing it: %s", field)
			}
		})
	}
}
