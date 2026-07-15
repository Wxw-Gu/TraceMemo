package messaging

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/Wxw-Gu/WechatExplorer/services/wechat-connector/ilink"
)

func TestInboundWebhookDeliversNormalizedPayload(t *testing.T) {
	var got inboundWebhookPayload
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer secret" {
			t.Errorf("authorization = %q", r.Header.Get("Authorization"))
		}
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Errorf("decode: %v", err)
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	webhook := NewInboundWebhook(server.URL, "secret")
	err := webhook.deliver(context.Background(), normalizeInboundMessage("bot-new", ilink.WeixinMessage{
		MessageID: 7, FromUserID: "user-1", MessageType: ilink.MessageTypeUser,
		ItemList: []ilink.MessageItem{{Type: ilink.ItemTypeText, TextItem: &ilink.TextItem{Text: "最近5条消息"}}},
	}))
	if err != nil {
		t.Fatalf("deliver: %v", err)
	}
	if got.AccountID != "bot-new" || got.MessageID != 7 || len(got.Items) != 1 || got.Items[0].Text != "最近5条消息" {
		t.Fatalf("payload = %#v", got)
	}
}

func TestInboundWebhookRetriesServerErrors(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if calls.Add(1) < 3 {
			http.Error(w, "temporary", http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	webhook := NewInboundWebhook(server.URL, "")
	if err := webhook.deliver(context.Background(), inboundWebhookPayload{}); err != nil {
		t.Fatalf("deliver: %v", err)
	}
	if calls.Load() != 3 {
		t.Fatalf("calls = %d, want 3", calls.Load())
	}
}

func TestInboundWebhookDoesNotRetryClientErrors(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		http.Error(w, "unauthorized", http.StatusUnauthorized)
	}))
	defer server.Close()

	webhook := NewInboundWebhook(server.URL, "")
	if err := webhook.deliver(context.Background(), inboundWebhookPayload{}); err == nil {
		t.Fatal("deliver error = nil")
	}
	if calls.Load() != 1 {
		t.Fatalf("calls = %d, want 1", calls.Load())
	}
}
