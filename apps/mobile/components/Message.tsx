// components/Message.tsx
import React, { useState, useMemo } from "react";
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from "react-native";
import * as Clipboard from "expo-clipboard";

export interface MessageProps {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  reasoning?: string | null;
  isStreaming?: boolean;
  isFailed?: boolean;
  onRetry?: () => void;
  timestamp?: number;
}

const CODE_KEYWORDS = new Set([
  "const",
  "let",
  "var",
  "function",
  "return",
  "if",
  "else",
  "for",
  "while",
  "import",
  "export",
  "from",
  "default",
  "class",
  "async",
  "await",
  "try",
  "catch",
  "finally",
  "throw",
  "new",
  "typeof",
  "instanceof",
  "def",
  "self",
  "None",
  "True",
  "False",
  "print",
  "echo",
  "SELECT",
  "FROM",
  "WHERE",
  "INSERT",
  "UPDATE",
  "DELETE",
  "func",
  "package",
  "pub",
  "fn",
  "mut",
  "impl",
  "struct",
]);

const CODE_TOKEN_REGEX =
  /(\/\/.*$|#.*$|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b\d+(?:\.\d+)?\b|\b[A-Za-z_][A-Za-z0-9_]*\b)/gm;

// Simple syntax colorizer for code blocks
function highlightCode(code: string): React.ReactNode[] {
  const lines = code.split("\n");

  return lines.map((line, lineIdx) => {
    const tokens = line.split(CODE_TOKEN_REGEX);
    return (
      <View key={lineIdx} style={styles.codeLine}>
        <Text style={styles.lineNumber}>{lineIdx + 1}</Text>
        <Text style={styles.codeText}>
          {tokens.map((token, tokIdx) => {
            if (!token) return null;
            let color = "#e6edf3";
            if (token.startsWith("//") || token.startsWith("#")) {
              color = "#8b949e"; // Comment
            } else if (
              (token.startsWith('"') && token.endsWith('"')) ||
              (token.startsWith("'") && token.endsWith("'"))
            ) {
              color = "#a5d6ff"; // String
            } else if (CODE_KEYWORDS.has(token)) {
              color = "#ff7b72"; // Keyword
            } else if (/^\d+(?:\.\d+)?$/.test(token)) {
              color = "#79c0ff"; // Number
            }
            return (
              <Text key={tokIdx} style={{ color }}>
                {token}
              </Text>
            );
          })}
        </Text>
      </View>
    );
  });
}

function CodeBlock({ code, language }: { code: string; language: string }) {
  const [copied, setCopied] = useState(false);
  const highlighted = useMemo(() => highlightCode(code), [code]);

  const handleCopy = async () => {
    await Clipboard.setStringAsync(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <View style={styles.codeBlockContainer}>
      <View style={styles.codeHeader}>
        <Text style={styles.languageLabel}>{language || "text"}</Text>
        <TouchableOpacity onPress={handleCopy} style={styles.copyButton} activeOpacity={0.7}>
          <Text style={styles.copyButtonText}>{copied ? "✓ Copied" : "Copy"}</Text>
        </TouchableOpacity>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={true} style={styles.codeScroll}>
        <View style={styles.codeBody}>{highlighted}</View>
      </ScrollView>
    </View>
  );
}

// Markdown parser rendering headers, code blocks, lists, quotes, inline code
function renderMarkdown(content: string): React.ReactNode[] {
  const elements: React.ReactNode[] = [];
  const parts = content.split(/(```[\s\S]*?```)/g);

  parts.forEach((part, partIdx) => {
    if (part.startsWith("```") && part.endsWith("```")) {
      const match = part.match(/^```(\w+)?\n([\s\S]*?)```$/);
      const lang = match ? match[1] || "" : "";
      const code = match ? match[2] || "" : part.slice(3, -3);
      elements.push(<CodeBlock key={`code-${partIdx}`} code={code.trimEnd()} language={lang} />);
      return;
    }

    const lines = part.split("\n");
    lines.forEach((line, lineIdx) => {
      const trimmed = line.trim();
      if (!trimmed) {
        elements.push(<View key={`empty-${partIdx}-${lineIdx}`} style={styles.spacing} />);
        return;
      }

      // Heading 1
      if (line.startsWith("# ")) {
        elements.push(
          <Text key={`h1-${partIdx}-${lineIdx}`} style={styles.heading1}>
            {line.slice(2)}
          </Text>,
        );
        return;
      }

      // Heading 2
      if (line.startsWith("## ")) {
        elements.push(
          <Text key={`h2-${partIdx}-${lineIdx}`} style={styles.heading2}>
            {line.slice(3)}
          </Text>,
        );
        return;
      }

      // Heading 3
      if (line.startsWith("### ")) {
        elements.push(
          <Text key={`h3-${partIdx}-${lineIdx}`} style={styles.heading3}>
            {line.slice(4)}
          </Text>,
        );
        return;
      }

      // Bullet List
      if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
        elements.push(
          <View key={`bullet-${partIdx}-${lineIdx}`} style={styles.bulletRow}>
            <Text style={styles.bulletSymbol}>•</Text>
            <Text style={styles.bulletText}>{trimmed.slice(2)}</Text>
          </View>,
        );
        return;
      }

      // Blockquote
      if (trimmed.startsWith("> ")) {
        elements.push(
          <View key={`quote-${partIdx}-${lineIdx}`} style={styles.blockquote}>
            <Text style={styles.quoteText}>{trimmed.slice(2)}</Text>
          </View>,
        );
        return;
      }

      // Standard paragraph
      elements.push(
        <Text key={`p-${partIdx}-${lineIdx}`} style={styles.paragraph}>
          {line}
        </Text>,
      );
    });
  });

  return elements;
}

export const Message = React.memo(function Message({
  role,
  content,
  reasoning,
  isStreaming,
  isFailed,
  onRetry,
  timestamp,
}: MessageProps) {
  const [isThinkingOpen, setIsThinkingOpen] = useState(false);
  const isUser = role === "user";
  const renderedMarkdown = useMemo(
    () => (isUser ? null : renderMarkdown(content)),
    [isUser, content],
  );

  return (
    <View style={[styles.container, isUser ? styles.userContainer : styles.assistantContainer]}>
      {/* Reasoning block if present */}
      {reasoning && !isUser && (
        <View style={styles.reasoningBox}>
          <TouchableOpacity
            style={styles.reasoningHeader}
            onPress={() => setIsThinkingOpen(!isThinkingOpen)}
            activeOpacity={0.7}
          >
            <Text style={styles.reasoningTitle}>
              {isStreaming ? "Thinking..." : "Thought process"}
            </Text>
            <Text style={styles.chevron}>{isThinkingOpen ? "▲" : "▼"}</Text>
          </TouchableOpacity>
          {isThinkingOpen && (
            <View style={styles.reasoningContent}>
              <Text style={styles.reasoningText}>{reasoning}</Text>
            </View>
          )}
        </View>
      )}

      {/* Main message bubble */}
      <View style={[styles.bubble, isUser ? styles.userBubble : styles.assistantBubble]}>
        {isUser ? (
          <Text style={styles.userText}>{content}</Text>
        ) : (
          <View style={styles.assistantTextContainer}>
            {renderedMarkdown}
            {isStreaming && <View style={styles.cursor} />}
          </View>
        )}
      </View>

      {/* Timestamp & Retry button if failed */}
      <View style={styles.metaRow}>
        {timestamp && (
          <Text style={styles.timestamp}>
            {new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </Text>
        )}
        {isFailed && onRetry && (
          <TouchableOpacity onPress={onRetry} style={styles.retryButton}>
            <Text style={styles.retryText}>Retry ↺</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    marginVertical: 6,
    paddingHorizontal: 16,
    width: "100%",
  },
  userContainer: {
    alignItems: "flex-end",
  },
  assistantContainer: {
    alignItems: "flex-start",
  },
  bubble: {
    maxWidth: "88%",
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  userBubble: {
    backgroundColor: "#007aff", // Apple blue
    borderBottomRightRadius: 4,
  },
  assistantBubble: {
    backgroundColor: "#f2f2f7", // Apple system gray
    borderBottomLeftRadius: 4,
  },
  userText: {
    fontSize: 16,
    lineHeight: 24,
    color: "#ffffff",
  },
  assistantTextContainer: {
    width: "100%",
  },
  paragraph: {
    fontSize: 16,
    lineHeight: 24,
    color: "#1c1c1e",
    marginBottom: 4,
  },
  heading1: {
    fontSize: 22,
    fontWeight: "700",
    color: "#000",
    marginTop: 8,
    marginBottom: 6,
  },
  heading2: {
    fontSize: 19,
    fontWeight: "600",
    color: "#000",
    marginTop: 6,
    marginBottom: 4,
  },
  heading3: {
    fontSize: 17,
    fontWeight: "600",
    color: "#1c1c1e",
    marginTop: 4,
    marginBottom: 4,
  },
  bulletRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    marginBottom: 3,
  },
  bulletSymbol: {
    fontSize: 16,
    color: "#3a3a3c",
    marginRight: 6,
  },
  bulletText: {
    fontSize: 16,
    lineHeight: 22,
    color: "#1c1c1e",
    flex: 1,
  },
  blockquote: {
    borderLeftWidth: 3,
    borderLeftColor: "#8e8e93",
    paddingLeft: 10,
    marginVertical: 4,
  },
  quoteText: {
    fontSize: 15,
    fontStyle: "italic",
    color: "#3a3a3c",
  },
  spacing: {
    height: 6,
  },
  reasoningBox: {
    maxWidth: "88%",
    backgroundColor: "#e5e5ea",
    borderRadius: 12,
    marginBottom: 6,
    overflow: "hidden",
  },
  reasoningHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  reasoningTitle: {
    fontSize: 13,
    fontWeight: "600",
    color: "#636366",
  },
  chevron: {
    fontSize: 11,
    color: "#8e8e93",
  },
  reasoningContent: {
    paddingHorizontal: 12,
    paddingBottom: 8,
    borderTopWidth: 1,
    borderTopColor: "#d1d1d6",
  },
  reasoningText: {
    fontSize: 13,
    lineHeight: 18,
    color: "#48484a",
    fontStyle: "italic",
  },
  codeBlockContainer: {
    backgroundColor: "#0d1117",
    borderRadius: 10,
    marginVertical: 8,
    overflow: "hidden",
  },
  codeHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: "#161b22",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: "#30363d",
  },
  languageLabel: {
    fontSize: 12,
    color: "#8b949e",
    fontWeight: "600",
    textTransform: "lowercase",
  },
  copyButton: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
    backgroundColor: "#21262d",
  },
  copyButtonText: {
    fontSize: 11,
    color: "#c9d1d9",
    fontWeight: "500",
  },
  codeScroll: {
    width: "100%",
  },
  codeBody: {
    padding: 12,
  },
  codeLine: {
    flexDirection: "row",
    alignItems: "center",
  },
  lineNumber: {
    width: 24,
    fontSize: 12,
    color: "#484f58",
    textAlign: "right",
    marginRight: 12,
    fontFamily: "Courier",
  },
  codeText: {
    fontSize: 13,
    fontFamily: "Courier",
    lineHeight: 19,
  },
  cursor: {
    width: 8,
    height: 16,
    backgroundColor: "#007aff",
    marginTop: 4,
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 3,
  },
  timestamp: {
    fontSize: 11,
    color: "#8e8e93",
    marginHorizontal: 4,
  },
  retryButton: {
    marginLeft: 8,
  },
  retryText: {
    fontSize: 12,
    color: "#ff3b30",
    fontWeight: "600",
  },
});
