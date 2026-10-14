// app/chat/[id].tsx
import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  SafeAreaView,
  View,
  Text,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import {
  getConversation,
  createConversation,
  updateConversation,
  listMessages,
  addMessage,
  updateMessageContent,
  type ChatMessageRow,
} from "../../lib/chat-store";
import { streamChat, type ChatMessageParam } from "../../lib/gateway";
import { Message } from "../../components/Message";
import { Composer, AVAILABLE_MODELS } from "../../components/Composer";
import type { AttachedFile } from "../../lib/attachments";

export default function ChatScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const conversationId = String(id);

  const [messages, setMessages] = useState<ChatMessageRow[]>([]);
  const [model, setModel] = useState<string>("deepseek-chat");
  const [title, setTitle] = useState<string>("New Chat");
  const [loading, setLoading] = useState(true);
  const [isStreaming, setIsStreaming] = useState(false);
  const [showScrollBottom, setShowScrollBottom] = useState(false);

  const abortControllerRef = useRef<AbortController | null>(null);
  const flatListRef = useRef<FlatList>(null);
  const streamingMsgIdRef = useRef<string | null>(null);

  useEffect(() => {
    async function init() {
      try {
        let conv = await getConversation(conversationId);
        if (!conv) {
          conv = await createConversation(conversationId, "New Conversation", model);
        } else {
          setModel(conv.model || "deepseek-chat");
          setTitle(conv.title || "Chat");
        }

        const msgs = await listMessages(conversationId);
        setMessages(msgs);
      } catch (err) {
        Alert.alert("Error", "Could not load conversation history");
      } finally {
        setLoading(false);
      }
    }
    init();
  }, [conversationId]);

  const scrollToBottom = () => {
    flatListRef.current?.scrollToEnd({ animated: true });
    setShowScrollBottom(false);
  };

  const handleStop = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setIsStreaming(false);
  };

  const handleSend = async (
    inputText: string,
    selectedModel: string,
    attachments: AttachedFile[]
  ) => {
    if (isStreaming) return;

    // Build user message content including inlined text attachments
    let fullPrompt = inputText;
    if (attachments.length > 0) {
      const inlinedParts: string[] = [];
      const referenceParts: string[] = [];

      attachments.forEach((att) => {
        if (att.inlinedContent) {
          inlinedParts.push(`\n--- File: ${att.name} ---\n${att.inlinedContent}\n--- End File ---`);
        } else {
          referenceParts.push(`[Attached ${att.isImage ? "Image" : "Document"}: ${att.name} (${Math.round(att.size / 1024)} KB)]`);
        }
      });

      if (inlinedParts.length > 0) {
        fullPrompt = `${fullPrompt}\n\n${inlinedParts.join("\n")}`;
      }
      if (referenceParts.length > 0) {
        fullPrompt = `${fullPrompt}\n\n${referenceParts.join("\n")}`;
      }
    }

    const now = Date.now();
    const userMsgId = `user-${now}`;
    const userRow: ChatMessageRow = {
      id: userMsgId,
      conversation_id: conversationId,
      role: "user",
      content: fullPrompt,
      created_at: now,
    };

    // Save and render user message
    await addMessage(userRow);
    const updatedMessages = [...messages, userRow];
    setMessages(updatedMessages);

    // Update conversation title if first message
    if (messages.length === 0) {
      const newTitle = inputText.slice(0, 30) || attachments[0]?.name || "New Chat";
      setTitle(newTitle);
      await updateConversation(conversationId, newTitle, selectedModel);
    }

    // Prepare assistant placeholder row
    const assistantMsgId = `asst-${Date.now()}`;
    streamingMsgIdRef.current = assistantMsgId;
    const assistantRow: ChatMessageRow = {
      id: assistantMsgId,
      conversation_id: conversationId,
      role: "assistant",
      content: "",
      reasoning: "",
      created_at: Date.now(),
    };

    setMessages([...updatedMessages, assistantRow]);
    setIsStreaming(true);
    setTimeout(scrollToBottom, 100);

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    // Convert history into OpenAI chat completion messages
    const apiMessages: ChatMessageParam[] = updatedMessages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    let accumulatedContent = "";
    let accumulatedReasoning = "";

    try {
      const result = await streamChat({
        model: selectedModel,
        messages: apiMessages,
        signal: abortController.signal,
        onDelta: ({ content, reasoning }) => {
          if (content) accumulatedContent += content;
          if (reasoning) accumulatedReasoning += reasoning;

          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === assistantMsgId
                ? {
                    ...msg,
                    content: accumulatedContent,
                    reasoning: accumulatedReasoning || null,
                  }
                : msg
            )
          );
        },
      });

      // Finalize message in SQLite
      await addMessage({
        id: assistantMsgId,
        conversation_id: conversationId,
        role: "assistant",
        content: result.fullContent || accumulatedContent,
        reasoning: result.fullReasoning || accumulatedReasoning || null,
        created_at: Date.now(),
      });
    } catch (err: any) {
      if (abortController.signal.aborted) {
        // User stopped generation: save partial output
        if (accumulatedContent || accumulatedReasoning) {
          await addMessage({
            id: assistantMsgId,
            conversation_id: conversationId,
            role: "assistant",
            content: accumulatedContent,
            reasoning: accumulatedReasoning || null,
            created_at: Date.now(),
          });
        }
      } else {
        // Real generation failure
        Alert.alert("Streaming Error", err.message || String(err));
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === assistantMsgId
              ? {
                  ...msg,
                  content: accumulatedContent || "Failed to receive response from model.",
                }
              : msg
          )
        );
      }
    } finally {
      setIsStreaming(false);
      abortControllerRef.current = null;
      streamingMsgIdRef.current = null;
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      {/* Top Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <Text style={styles.backButtonText}>←</Text>
        </TouchableOpacity>

        <View style={styles.headerCenter}>
          <Text numberOfLines={1} style={styles.headerTitle}>
            {title}
          </Text>
          <Text style={styles.headerSubtitle}>{model}</Text>
        </View>

        <View style={styles.headerRightPlaceholder} />
      </View>

      {/* Main Messages List */}
      <KeyboardAvoidingView
        style={styles.keyboardContainer}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={Platform.OS === "ios" ? 8 : 0}
      >
        {loading ? (
          <View style={styles.centerContainer}>
            <ActivityIndicator size="large" color="#007aff" />
          </View>
        ) : (
          <FlatList
            ref={flatListRef}
            data={messages}
            keyExtractor={(item) => item.id}
            contentContainerStyle={styles.messagesList}
            onScroll={(e) => {
              const { layoutMeasurement, contentOffset, contentSize } = e.nativeEvent;
              const isCloseToBottom =
                layoutMeasurement.height + contentOffset.y >= contentSize.height - 100;
              setShowScrollBottom(!isCloseToBottom);
            }}
            scrollEventThrottle={100}
            renderItem={({ item }) => (
              <Message
                id={item.id}
                role={item.role}
                content={item.content}
                reasoning={item.reasoning}
                isStreaming={isStreaming && item.id === streamingMsgIdRef.current}
                timestamp={item.created_at}
              />
            )}
          />
        )}

        {/* Jump to Latest Floating Pill */}
        {showScrollBottom && (
          <TouchableOpacity
            style={styles.jumpPill}
            onPress={scrollToBottom}
            activeOpacity={0.8}
          >
            <Text style={styles.jumpPillText}>↓ Jump to latest</Text>
          </TouchableOpacity>
        )}

        {/* Input Composer */}
        <Composer
          selectedModel={model}
          onModelChange={(newModel) => {
            setModel(newModel);
            updateConversation(conversationId, title, newModel);
          }}
          isStreaming={isStreaming}
          onStop={handleStop}
          onSend={handleSend}
        />
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#ffffff",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#e5e5ea",
  },
  backButton: {
    padding: 6,
  },
  backButtonText: {
    fontSize: 22,
    color: "#007aff",
    fontWeight: "600",
  },
  headerCenter: {
    flex: 1,
    alignItems: "center",
    paddingHorizontal: 12,
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: "#1c1c1e",
  },
  headerSubtitle: {
    fontSize: 11,
    color: "#8e8e93",
    marginTop: 2,
    textTransform: "lowercase",
  },
  headerRightPlaceholder: {
    width: 32,
  },
  keyboardContainer: {
    flex: 1,
  },
  centerContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  messagesList: {
    paddingVertical: 12,
  },
  jumpPill: {
    position: "absolute",
    bottom: 80,
    alignSelf: "center",
    backgroundColor: "#ffffff",
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#d1d1d6",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 4,
    elevation: 3,
  },
  jumpPillText: {
    fontSize: 12,
    fontWeight: "600",
    color: "#007aff",
  },
});
