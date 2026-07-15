package api

import (
	"testing"

	"github.com/Wxw-Gu/WechatExplorer/services/wechat-connector/ilink"
)

func TestClientForAccountSelectsMatchingBot(t *testing.T) {
	oldClient := ilink.NewClient(&ilink.Credentials{ILinkBotID: "bot-old"})
	newClient := ilink.NewClient(&ilink.Credentials{ILinkBotID: "bot-new"})
	server := NewServer([]*ilink.Client{oldClient, newClient}, "")

	if got := server.clientForAccount("bot-new"); got != newClient {
		t.Fatal("clientForAccount did not select the requested account")
	}
	if got := server.clientForAccount("missing"); got != nil {
		t.Fatal("clientForAccount should reject an unknown account")
	}
}
