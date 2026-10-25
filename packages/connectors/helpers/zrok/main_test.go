package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-openapi/runtime"
	httptransport "github.com/go-openapi/runtime/client"
	"github.com/go-openapi/strfmt"
	"github.com/openziti/zrok/v2/environment/env_core"
	"github.com/openziti/zrok/v2/rest_client_zrok"
)

type testRoot struct {
	env_core.Root
	client *rest_client_zrok.Zrok
	env    *env_core.Environment
}

func (r testRoot) Client() (*rest_client_zrok.Zrok, error) { return r.client, nil }
func (r testRoot) Environment() *env_core.Environment      { return r.env }
func (r testRoot) IsEnabled() bool                         { return true }
func TestRecoveryChecksExactCloudIdentityBeforeDeleting(t *testing.T) {
	for _, variant := range []string{"owned", "different-id", "different-owner", "private", "missing", "missing-rotated", "delete-unknown"} {
		t.Run(variant, func(t *testing.T) {
			deletes := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				if r.Header.Get("X-TOKEN") != "publisher" {
					t.Error("publisher authentication lost")
				}
				if r.Method == "DELETE" {
					deletes++
					if variant == "delete-unknown" {
						w.WriteHeader(503)
						w.Write([]byte(`{}`))
						return
					}
					w.Write([]byte(`{}`))
					return
				}
				if r.URL.Path != "/api/v2/detail/share/exact-share" {
					t.Error("lookup did not use exact receipt")
				}
				if strings.HasPrefix(variant, "missing") {
					w.WriteHeader(404)
					w.Write([]byte(`{}`))
					return
				}
				value := map[string]interface{}{"shareToken": "exact-share", "envZId": "own-env", "shareMode": "public", "backendMode": "proxy", "frontendEndpoints": []string{}}
				if variant == "different-id" {
					value["shareToken"] = "other-share"
				}
				if variant == "different-owner" {
					value["envZId"] = "foreign-env"
				}
				if variant == "private" {
					value["shareMode"] = "private"
				}
				json.NewEncoder(w).Encode(value)
			}))
			defer server.Close()
			transport := httptransport.NewWithClient(strings.TrimPrefix(server.URL, "http://"), "/api/v2", []string{"http"}, server.Client())
			transport.Producers["application/zrok.v1+json"] = runtime.JSONProducer()
			transport.Consumers["application/zrok.v1+json"] = runtime.JSONConsumer()
			root := testRoot{client: rest_client_zrok.New(transport, strfmt.Default), env: &env_core.Environment{AccountToken: "publisher", ZitiIdentity: "own-env"}}
			cfg := config{ResourceID: "exact-share", ResourceOwner: owner(root)}
			if variant == "missing-rotated" {
				cfg.ResourceOwner = strings.Repeat("0", 64) + ":own-env"
			}
			err := cleanup(root, cfg)
			if variant == "owned" || variant == "missing" {
				if err != nil {
					t.Fatal(err)
				}
			} else if err == nil {
				t.Fatal("unconfirmed or unrelated share reported retired")
			}
			if variant == "owned" || variant == "delete-unknown" {
				if deletes != 1 {
					t.Fatal("owned share was not deleted once")
				}
			} else if deletes != 0 {
				t.Fatal("unrelated or absent share was deleted")
			}
		})
	}
}
