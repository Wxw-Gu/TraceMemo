package messaging

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/Wxw-Gu/WechatExplorer/services/wechat-connector/ilink"
)

const (
	webhookAttempts = 3
	webhookTimeout  = 5 * time.Second
)

type InboundWebhook struct {
	url    string
	token  string
	client *http.Client
}

type inboundWebhookPayload struct {
	AccountID   string               `json:"account_id"`
	FromUserID  string               `json:"from_user_id"`
	MessageID   int64                `json:"message_id"`
	MessageType int                  `json:"message_type"`
	Items       []inboundWebhookItem `json:"items"`
	ReceivedAt  time.Time            `json:"received_at"`
}

type inboundWebhookItem struct {
	Type int    `json:"type"`
	Text string `json:"text,omitempty"`
}

func NewInboundWebhook(url, token string) *InboundWebhook {
	return &InboundWebhook{
		url:    strings.TrimSpace(url),
		token:  token,
		client: &http.Client{Timeout: webhookTimeout},
	}
}

// Dispatch is intentionally non-blocking so webhook failures never stall iLink polling.
func (w *InboundWebhook) Dispatch(ctx context.Context, client *ilink.Client, msg ilink.WeixinMessage) {
	payload := normalizeInboundMessage(client.BotID(), msg)
	go func() {
		if err := w.deliver(ctx, payload); err != nil {
			log.Printf("[webhook] inbound delivery failed for message %d: %v", msg.MessageID, err)
		}
	}()
}

func (w *InboundWebhook) deliver(ctx context.Context, payload inboundWebhookPayload) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("encode payload: %w", err)
	}
	var lastErr error
	for attempt := 1; attempt <= webhookAttempts; attempt++ {
		if attempt > 1 {
			timer := time.NewTimer(time.Duration(attempt-1) * time.Second)
			select {
			case <-ctx.Done():
				timer.Stop()
				return ctx.Err()
			case <-timer.C:
			}
		}
		req, reqErr := http.NewRequestWithContext(ctx, http.MethodPost, w.url, bytes.NewReader(body))
		if reqErr != nil {
			return fmt.Errorf("create request: %w", reqErr)
		}
		req.Header.Set("Content-Type", "application/json")
		if w.token != "" {
			req.Header.Set("Authorization", "Bearer "+w.token)
		}
		resp, doErr := w.client.Do(req)
		if doErr != nil {
			lastErr = doErr
			continue
		}
		responseBody, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		resp.Body.Close()
		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			return nil
		}
		lastErr = fmt.Errorf("status %s: %s", resp.Status, strings.TrimSpace(string(responseBody)))
		if resp.StatusCode >= 400 && resp.StatusCode < 500 {
			break
		}
	}
	return lastErr
}

func normalizeInboundMessage(accountID string, msg ilink.WeixinMessage) inboundWebhookPayload {
	items := make([]inboundWebhookItem, 0, len(msg.ItemList))
	for _, item := range msg.ItemList {
		normalized := inboundWebhookItem{Type: item.Type}
		if item.TextItem != nil {
			normalized.Text = item.TextItem.Text
		} else if item.VoiceItem != nil {
			normalized.Text = item.VoiceItem.Text
		}
		items = append(items, normalized)
	}
	return inboundWebhookPayload{
		AccountID:   accountID,
		FromUserID:  msg.FromUserID,
		MessageID:   msg.MessageID,
		MessageType: msg.MessageType,
		Items:       items,
		ReceivedAt:  time.Now().UTC(),
	}
}
