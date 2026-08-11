package ilink

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestSaveCredentialsKeepsOnlyLatestAccount(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	old := &Credentials{ILinkBotID: "bot-old@im.bot", BotToken: "old-token"}
	latest := &Credentials{ILinkBotID: "bot-new@im.bot", BotToken: "new-token"}
	if err := SaveCredentials(old); err != nil {
		t.Fatal(err)
	}
	dir, err := AccountsDir()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, NormalizeAccountID(old.ILinkBotID)+".sync.json"), []byte(`{}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := SaveCredentials(latest); err != nil {
		t.Fatal(err)
	}
	accounts, err := LoadAllCredentials()
	if err != nil {
		t.Fatal(err)
	}
	if len(accounts) != 1 || accounts[0].ILinkBotID != latest.ILinkBotID {
		t.Fatalf("accounts = %#v", accounts)
	}
	if _, err := os.Stat(filepath.Join(dir, NormalizeAccountID(old.ILinkBotID)+".sync.json")); !os.IsNotExist(err) {
		t.Fatalf("old sync state still exists: %v", err)
	}
}

func TestAccountsDirUsesTraceMemoIdentity(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	dir, err := AccountsDir()
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(home, ".tracememo", "wechat-connector", "accounts")
	if dir != want {
		t.Fatalf("AccountsDir() = %q, want %q", dir, want)
	}
}

func TestLoadAllCredentialsFallsBackToLegacyDirectory(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	legacyDir, err := LegacyAccountsDir()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(legacyDir, 0o700); err != nil {
		t.Fatal(err)
	}
	legacy := &Credentials{ILinkBotID: "legacy@im.bot", BotToken: "legacy-token"}
	data, err := json.Marshal(legacy)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(legacyDir, NormalizeAccountID(legacy.ILinkBotID)+".json"), data, 0o600); err != nil {
		t.Fatal(err)
	}
	accounts, err := LoadAllCredentials()
	if err != nil {
		t.Fatal(err)
	}
	if len(accounts) != 1 || accounts[0].BotToken != legacy.BotToken {
		t.Fatalf("accounts = %#v", accounts)
	}
	if _, err := os.Stat(legacyDir); err != nil {
		t.Fatalf("legacy directory changed or removed: %v", err)
	}
}
