package messaging

import (
	"regexp"
	"strings"
)

var (
	// Code blocks: strip fences, keep code content
	reCodeBlock = regexp.MustCompile("(?s)```[^\n]*\n?(.*?)```")
	// Inline code: strip backticks, keep content
	reInlineCode = regexp.MustCompile("`([^`]+)`")
	// Images: remove entirely
	reImage = regexp.MustCompile(`!\[[^\]]*\]\([^)]*\)`)
	// Links: keep display text only
	reLink = regexp.MustCompile(`\[([^\]]+)\]\([^)]*\)`)
	// Table separator rows: remove
	reTableSep = regexp.MustCompile(`(?m)^\|[\s:|\-]+\|$`)
	// Table rows: convert pipe-delimited to space-delimited
	reTableRow = regexp.MustCompile(`(?m)^\|(.+)\|$`)
	// Headers: remove # prefix
	reHeader = regexp.MustCompile(`(?m)^#{1,6}\s+`)
	// Bold: **text** or __text__
	reBold = regexp.MustCompile(`\*\*(.+?)\*\*|__(.+?)__`)
	// Italic: *text* or _text_
	reItalic = regexp.MustCompile(`(?:^|[^*])\*([^*]+)\*(?:[^*]|$)|(?:^|[^_])_([^_]+)_(?:[^_]|$)`)
	// Strikethrough: ~~text~~
	reStrike = regexp.MustCompile(`~~(.+?)~~`)
	// Blockquote: > prefix
	reBlockquote = regexp.MustCompile(`(?m)^>\s?`)
	// Horizontal rule
	reHR = regexp.MustCompile(`(?m)^[-*_]{3,}\s*$`)
	// Unordered list markers: -, *, +
	reUL = regexp.MustCompile(`(?m)^(\s*)[-*+]\s+`)
)

// MarkdownToPlainText converts markdown to readable plain text for WeChat.
func MarkdownToPlainText(text string) string {
	result := text

	// Code blocks: strip fences, keep code content
	result = reCodeBlock.ReplaceAllStringFunc(result, func(match string) string {
		parts := reCodeBlock.FindStringSubmatch(match)
		if len(parts) > 1 {
			return strings.TrimSpace(parts[1])
		}
		return match
	})

	// Images: remove entirely
	result = reImage.ReplaceAllString(result, "")

	// Links: keep display text only
	result = reLink.ReplaceAllString(result, "$1")

	// Table separator rows: remove
	result = reTableSep.ReplaceAllString(result, "")

	// Table rows: pipe-delimited to space-delimited
	result = reTableRow.ReplaceAllStringFunc(result, func(match string) string {
		parts := reTableRow.FindStringSubmatch(match)
		if len(parts) > 1 {
			cells := strings.Split(parts[1], "|")
			for i := range cells {
				cells[i] = strings.TrimSpace(cells[i])
			}
			return strings.Join(cells, "  ")
		}
		return match
	})

	// Headers: remove # prefix
	result = reHeader.ReplaceAllString(result, "")

	// Bold
	result = reBold.ReplaceAllStringFunc(result, func(match string) string {
		parts := reBold.FindStringSubmatch(match)
		if parts[1] != "" {
			return parts[1]
		}
		return parts[2]
	})

	// Strikethrough
	result = reStrike.ReplaceAllString(result, "$1")

	// Blockquote
	result = reBlockquote.ReplaceAllString(result, "")

	// Horizontal rule -> empty line
	result = reHR.ReplaceAllString(result, "")

	// Unordered list: replace markers with "• "
	result = reUL.ReplaceAllString(result, "${1}• ")

	// Inline code: strip backticks (do after code blocks)
	result = reInlineCode.ReplaceAllString(result, "$1")

	// Clean up excessive blank lines
	result = regexp.MustCompile(`\n{3,}`).ReplaceAllString(result, "\n\n")

	return strings.TrimSpace(result)
}
