import { ChatDrawer } from "../../components/ChatDrawer";
import { Icon } from "../../components/Icon";
import { colors } from "../../lib/theme";
import { buildAttachmentPrompt } from "../../lib/attachments";
import { randomId } from "../../lib/crypto/keys";
import { isActiveAccount, requireActiveAccount } from "../../lib/account-scope";
// app/chat/[id].tsx
import React, { useState, useEffect, useRef } from "react";
import {
  SafeAreaView,
  View,
  Text,
  TouchableOpacity,
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
  type ChatMessageRow,
} from "../../lib/chat-store";
import { streamChat, type ChatMessageParam } from "../../lib/gateway";
import { SharedTranscript } from "../../components/SharedTranscript";
import { Composer } from "../../components/Composer";
import type { AttachedFile } from "../../lib/attachments";

export default function ChatScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <ChatOwner key={String(id)} conversationId={String(id)} />;
}
function ChatOwner({ conversationId }: { conversationId: string }) {
  const router = useRouter();

  const [messages, setMessages] = useState<ChatMessageRow[]>([]);
  const [model, setModel] = useState<string>("openai/gpt-oss-20b");
  const [title, setTitle] = useState<string>("New Chat");
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<{
    id: string;
    history: ChatMessageRow[];
    model: string;
  } | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);

  const owner = requireActiveAccount();
  const sendingRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const streamingMsgIdRef = useRef<string | null>(null);

  useEffect(() => {
    let retired = false;
    async function init() {
      try {
        let conv = await getConversation(conversationId);
        if (retired || !isActiveAccount(owner)) return;
        if (!conv) {
          conv = await createConversation(conversationId, "New Conversation", "openai/gpt-oss-20b");
        } else {
          if (!retired) {
            setModel(conv.model || "openai/gpt-oss-20b");
            setTitle(conv.title || "Chat");
          }
        }

        if (retired || !isActiveAccount(owner)) return;
        const msgs = await listMessages(conversationId);
        if (!retired) setMessages(msgs);
      } catch {
        if (!retired) Alert.alert("Error", "Could not load conversation history");
      } finally {
        if (!retired) setLoading(false);
      }
    }
    void init();
    return () => {
      retired = true;
      abortControllerRef.current?.abort();
    };
  }, [conversationId, owner]);

  useEffect(() => () => abortControllerRef.current?.abort(), []);

  const handleStop = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
  };

  const handleSend = async (
    inputText: string,
    selectedModel: string,
    attachments: AttachedFile[],
    retryHistory?: ChatMessageRow[],
  ) => {
    if (sendingRef.current || !isActiveAccount(owner)) return;
    sendingRef.current = true;
    setIsStreaming(true);
    setFailure(null);
    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    try {
      const fullPrompt = buildAttachmentPrompt(inputText, attachments);

      const now = Date.now();
      const userMsgId = randomId("user");
      const userRow: ChatMessageRow = {
        id: userMsgId,
        conversation_id: conversationId,
        role: "user",
        content: fullPrompt,
        created_at: now,
      };

      let updatedMessages: ChatMessageRow[];
      if (retryHistory) {
        updatedMessages = retryHistory;
      } else {
        await addMessage(userRow);
        if (abortController.signal.aborted || !isActiveAccount(owner)) return;
        updatedMessages = [...messages.filter((message) => message.id !== failure?.id), userRow];
        if (messages.length === 0) {
          const newTitle = inputText.slice(0, 30) || attachments[0]?.name || "New chat";
          setTitle(newTitle);
          await updateConversation(conversationId, newTitle, selectedModel);
        }
      }
      setMessages(updatedMessages);
      if (abortController.signal.aborted) return;

      // Prepare assistant placeholder row
      const assistantMsgId = randomId("asst");
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

      // Bound history sent to the provider; local history remains available.
      const apiMessages: ChatMessageParam[] = updatedMessages.slice(-100).map((m) => ({
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
                  : msg,
              ),
            );
          },
        });

        // Do not save an old account's in-flight response into the new account.
        if (requireActiveAccount() !== owner) return;
        // A stopped empty placeholder is not a completed answer.
        if (result.stopped && !result.fullContent && !result.fullReasoning) {
          setMessages((prev) => prev.filter((message) => message.id !== assistantMsgId));
          return;
        }
        // Finalize message in SQLite
        await addMessage({
          id: assistantMsgId,
          conversation_id: conversationId,
          role: "assistant",
          content: result.fullContent || accumulatedContent,
          reasoning: result.fullReasoning || accumulatedReasoning || null,
          created_at: Date.now(),
        });
      } catch (error) {
        if (abortController.signal.aborted) {
          // User stopped generation: save partial output
          if (requireActiveAccount() === owner && (accumulatedContent || accumulatedReasoning)) {
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
          const message =
            error instanceof Error
              ? error.message
              : "The response could not complete. Please retry.";
          setFailure({ id: assistantMsgId, history: updatedMessages, model: selectedModel });
          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === assistantMsgId
                ? {
                    ...msg,
                    content: accumulatedContent ? `${accumulatedContent}\n\n${message}` : message,
                  }
                : msg,
            ),
          );
        }
      } finally {
        setIsStreaming(false);
        abortControllerRef.current = null;
        streamingMsgIdRef.current = null;
      }
    } catch {
      Alert.alert("Could not save message", "Your message could not be saved. Please try again.");
    } finally {
      sendingRef.current = false;
      abortControllerRef.current = null;
      streamingMsgIdRef.current = null;
      setIsStreaming(false);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      {/* Top Header */}
      <View style={styles.header}>
        <ChatDrawer selectedId={conversationId} selectedSource="phone" />

        <View style={styles.headerCenter}>
          <Text numberOfLines={1} style={styles.headerTitle}>
            {messages.length === 0 ? "Bimax" : title}
          </Text>
        </View>

        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="Connect your Mac"
          style={styles.backButton}
          onPress={() => router.push("/remote")}
        >
          <Icon name="monitor" />
        </TouchableOpacity>
      </View>

      {/* Main Messages List */}
      <KeyboardAvoidingView
        style={styles.keyboardContainer}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={Platform.OS === "ios" ? 8 : 0}
      >
        {loading ? (
          <View style={styles.centerContainer}>
            <ActivityIndicator size="large" color={colors.text} />
          </View>
        ) : (
          <SharedTranscript
            conversationKey={conversationId}
            messages={messages.map((m) => ({
              ...m,
              streaming: isStreaming && m.id === streamingMsgIdRef.current,
            }))}
            failedId={failure?.id}
            onRetry={() => {
              if (failure) void handleSend("", failure.model, [], failure.history);
            }}
          />
        )}

        {/* Input Composer */}
        <Composer
          selectedModel={model}
          onModelChange={(newModel) => {
            setModel(newModel);
            void updateConversation(conversationId, title, newModel).catch(() => {});
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
    backgroundColor: colors.background,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  backButton: {
    width: 44,
    height: 44,
    justifyContent: "center",
    alignItems: "center",
  },
  backButtonText: {
    fontSize: 22,
    color: colors.text,
    fontWeight: "600",
  },
  headerCenter: {
    flex: 1,
    alignItems: "center",
    paddingHorizontal: 12,
  },
  emptyTitle: {
    color: colors.text,
    fontSize: 27,
    fontWeight: "600",
    letterSpacing: -0.8,
    textAlign: "center",
    padding: 24,
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: colors.text,
  },
  headerSubtitle: {
    fontSize: 11,
    color: colors.muted,
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
    backgroundColor: colors.background,
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    shadowColor: colors.text,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 4,
    elevation: 3,
  },
  jumpPillText: {
    fontSize: 12,
    fontWeight: "600",
    color: colors.text,
  },
});
