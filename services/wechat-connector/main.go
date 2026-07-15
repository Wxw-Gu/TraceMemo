package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"

	"github.com/Wxw-Gu/WechatExplorer/services/wechat-connector/api"
	"github.com/Wxw-Gu/WechatExplorer/services/wechat-connector/ilink"
	"github.com/Wxw-Gu/WechatExplorer/services/wechat-connector/messaging"
	"rsc.io/qr"
)

type loginEvent struct {
	Status        string `json:"status"`
	QRCodeDataURL string `json:"qr_code_data_url,omitempty"`
	AccountID     string `json:"account_id,omitempty"`
	WeChatUserID  string `json:"wechat_user_id,omitempty"`
}

type accountSummary struct {
	AccountID    string `json:"account_id"`
	WeChatUserID string `json:"wechat_user_id"`
}

func main() {
	if len(os.Args) < 2 {
		fatal(errors.New("expected one of: login, accounts, start"))
	}
	var err error
	switch os.Args[1] {
	case "login":
		err = runLogin(os.Args[2:])
	case "accounts":
		err = runAccounts(os.Args[2:])
	case "start":
		err = runStart(os.Args[2:])
	default:
		err = fmt.Errorf("unknown command %q", os.Args[1])
	}
	if err != nil {
		fatal(err)
	}
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}

func signalContext() (context.Context, context.CancelFunc) {
	return signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
}

func runLogin(args []string) error {
	flags := flag.NewFlagSet("login", flag.ContinueOnError)
	jsonOutput := flags.Bool("json", false, "emit JSON Lines events")
	if err := flags.Parse(args); err != nil {
		return err
	}
	ctx, cancel := signalContext()
	defer cancel()
	creds, err := login(ctx, *jsonOutput)
	if err != nil {
		return err
	}
	if !*jsonOutput {
		fmt.Printf("WeChat account %s connected.\n", creds.ILinkBotID)
	}
	return nil
}

func login(ctx context.Context, jsonOutput bool) (*ilink.Credentials, error) {
	qrResponse, err := ilink.FetchQRCode(ctx)
	if err != nil {
		return nil, err
	}
	code, err := qr.Encode(qrResponse.QRCodeImgContent, qr.L)
	if err != nil {
		return nil, fmt.Errorf("encode QR image: %w", err)
	}
	emit := func(event loginEvent) {
		if jsonOutput {
			_ = json.NewEncoder(os.Stdout).Encode(event)
		}
	}
	emit(loginEvent{Status: "qrcode", QRCodeDataURL: "data:image/png;base64," + base64.StdEncoding.EncodeToString(code.PNG())})
	lastStatus := ""
	creds, err := ilink.PollQRStatus(ctx, qrResponse.QRCode, func(status string) {
		if status != lastStatus {
			lastStatus = status
			emit(loginEvent{Status: status})
		}
	})
	if err != nil {
		return nil, err
	}
	if err := ilink.SaveCredentials(creds); err != nil {
		return nil, fmt.Errorf("save credentials: %w", err)
	}
	emit(loginEvent{Status: "active", AccountID: creds.ILinkBotID, WeChatUserID: creds.ILinkUserID})
	return creds, nil
}

func runAccounts(args []string) error {
	flags := flag.NewFlagSet("accounts", flag.ContinueOnError)
	jsonOutput := flags.Bool("json", false, "print JSON")
	if err := flags.Parse(args); err != nil {
		return err
	}
	accounts, err := ilink.LoadAllCredentials()
	if err != nil {
		return err
	}
	items := make([]accountSummary, 0, len(accounts))
	for _, account := range accounts {
		items = append(items, accountSummary{AccountID: account.ILinkBotID, WeChatUserID: account.ILinkUserID})
	}
	if *jsonOutput {
		return json.NewEncoder(os.Stdout).Encode(map[string]any{"accounts": items})
	}
	for _, item := range items {
		fmt.Printf("%s\t%s\n", item.AccountID, item.WeChatUserID)
	}
	return nil
}

func runStart(args []string) error {
	flags := flag.NewFlagSet("start", flag.ContinueOnError)
	_ = flags.Bool("foreground", false, "kept for host compatibility")
	apiAddr := flags.String("api-addr", "127.0.0.1:18011", "local send API address")
	accountID := flags.String("account-id", "", "account to start")
	if err := flags.Parse(args); err != nil {
		return err
	}
	accounts, err := ilink.LoadAllCredentials()
	if err != nil {
		return err
	}
	if len(accounts) == 0 {
		return errors.New("no connected WeChat account; scan a QR code first")
	}
	selected := accounts[len(accounts)-1]
	if *accountID != "" {
		selected = nil
		for _, account := range accounts {
			if account.ILinkBotID == *accountID {
				selected = account
				break
			}
		}
		if selected == nil {
			return fmt.Errorf("account %q not found", *accountID)
		}
	}

	ctx, cancel := signalContext()
	defer cancel()
	client := ilink.NewClient(selected)
	server := api.NewServer([]*ilink.Client{client}, *apiAddr)
	webhookURL := strings.TrimSpace(os.Getenv("WECHAT_CONNECTOR_INBOUND_WEBHOOK_URL"))
	webhook := messaging.NewInboundWebhook(webhookURL, os.Getenv("WECHAT_CONNECTOR_INBOUND_WEBHOOK_TOKEN"))

	monitor, err := ilink.NewMonitor(client, func(messageContext context.Context, source *ilink.Client, message ilink.WeixinMessage) {
		if webhookURL != "" {
			webhook.Dispatch(messageContext, source, message)
		}
	})
	if err != nil {
		return err
	}

	var wait sync.WaitGroup
	wait.Add(2)
	go func() {
		defer wait.Done()
		if err := server.Run(ctx); err != nil && ctx.Err() == nil {
			log.Printf("[api] stopped: %v", err)
			cancel()
		}
	}()
	go func() {
		defer wait.Done()
		if err := monitor.Run(ctx); err != nil && ctx.Err() == nil {
			log.Printf("[monitor] stopped: %v", err)
			cancel()
		}
	}()
	wait.Wait()
	return nil
}
