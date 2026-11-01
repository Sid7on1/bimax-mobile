import { ChatDrawer } from "../../components/ChatDrawer";
import React, { useCallback, useRef, useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  SafeAreaView,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import type { RemoteConversation } from "@bimax/protocol";
import { useRelayContext } from "../../lib/session";
import { SharedTranscript } from "../../components/SharedTranscript";
import { Composer } from "../../components/Composer";
import { colors } from "../../lib/theme";
export default function DesktopChat() {
  const params = useLocalSearchParams<{ id: string }>();
  const id = Array.isArray(params.id) ? params.id[0] : params.id;
  return <DesktopChatOwner key={id} id={id} />;
}
function DesktopChatOwner({ id }: { id: string }) {
  const router = useRouter();
  const {
    remoteSessions,
    watchConversation,
    sendRemoteChat,
    sendKill,
    status,
    trustedDesktop,
    sessions,
    pendingApprovals,
  } = useRelayContext();
  const desktopId = trustedDesktop?.deviceId;
  const connected = status === "online" && sessions.some((session) => session.peerDeviceId === desktopId);
  const [conversation, setConversation] = useState<RemoteConversation | null>(null);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [revision, refresh] = useState(0);
  const busy = useRef(false),
    generation = useRef(0);

  useFocusEffect(
    useCallback(() => {
      const epoch = ++generation.current;
      const controller = new AbortController();
      setError("");
      // Retain this chat during transport recovery. A different id mounts a fresh owner.
      const close =
        connected && desktopId
          ? watchConversation(
              id,
              (snapshot) => {
                if (
                  generation.current === epoch &&
                  !controller.signal.aborted &&
                  snapshot.sessionId === id
                )
                  setConversation(snapshot);
              },
              (e) => {
                if (generation.current === epoch && !controller.signal.aborted) setError(e.message);
              },
              controller.signal,
            )
          : () => {};
      if (!connected) setError("Reconnecting to your Mac…");
      return () => {
        controller.abort();
        close();
        ++generation.current;
      };
      // revision deliberately restarts the subscription after manual Retry.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [id, connected, desktopId, watchConversation, revision]),
  );
  const send = async (text: string) => {
    if (busy.current || !text.trim() || !conversation || !connected) return;
    const epoch = generation.current;
    busy.current = true;
    setSending(true);
    setError("");
    try {
      // Always address the selected conversation; never fall back to the Mac's active one.
      const done = await sendRemoteChat({ sessionId: id, text });
      if (generation.current !== epoch) return;
      if (!done.ok || done.sessionId !== id)
        throw Error(done.error || "The Mac could not complete this response");
      // Live updates carry the authoritative result; no history polling or second request.
    } catch (e) {
      if (generation.current === epoch) setError(e instanceof Error ? e.message : "Message failed");
    } finally {
      busy.current = false;
      setSending(false);
    }
  };
  const workspace = remoteSessions.find((session) => session.sessionId === id)?.workspace;
  const approval = pendingApprovals.find((request) => request.sessionId === id);
  const messages = conversation
    ? [
        ...conversation.messages,
        ...(conversation.streaming ||
        conversation.thinking ||
        sending ||
        conversation.status === "working" ||
        conversation.status === "waiting_approval"
          ? [
              {
                id: "live-response",
                role: "assistant",
                content: conversation.streaming,
                reasoning: conversation.thinking,
                streaming: true,
                status:
                  conversation.status === "waiting_approval"
                    ? "Waiting for your decision"
                    : undefined,
              },
            ]
          : []),
      ]
    : [];
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: 16,
          paddingVertical: 10,
        }}
      >
        <ChatDrawer selectedId={id} selectedSource="mac" />
        <View style={{ flex: 1, paddingHorizontal: 12 }}>
          <Text numberOfLines={1} style={{ color: colors.text, fontSize: 16, fontWeight: "600" }}>
            {conversation?.title || "Mac conversation"}
          </Text>
          <Text style={{ color: colors.secondary, fontSize: 12 }}>
            {workspace ? `${workspace.name} · ${workspace.location}` : "On your Mac"}
            {sending ? " · Waiting for response" : ""}
          </Text>
        </View>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="Refresh conversation"
          onPress={() => refresh((v) => v + 1)}
          style={{ padding: 10 }}
        >
          <Text style={{ color: colors.secondary }}>Refresh</Text>
        </TouchableOpacity>
      </View>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={{ flex: 1 }}
      >
        {!!error && (
          <View style={{ padding: 16 }}>
            <Text accessibilityRole="alert" style={{ color: colors.danger }}>
              {error}
            </Text>
            <TouchableOpacity onPress={() => refresh((v) => v + 1)} style={{ paddingVertical: 12 }}>
              <Text style={{ color: colors.text }}>Try again</Text>
            </TouchableOpacity>
          </View>
        )}
        {approval && (
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="Review Mac action"
            onPress={() =>
              router.push({ pathname: "/approve/[id]", params: { id: approval.approvalId } })
            }
            style={{ padding: 16, backgroundColor: colors.surface }}
          >
            <Text style={{ color: colors.text, fontWeight: "600" }}>
              Review action on your phone
            </Text>
            <Text style={{ color: colors.secondary, marginTop: 4 }}>
              Your Mac is waiting for your decision.
            </Text>
          </TouchableOpacity>
        )}
        <SharedTranscript
          key={`desktop:${id}`}
          conversationKey={`desktop:${id}`}
          messages={messages}
          empty={
            error
              ? "Conversation unavailable"
              : conversation
                ? "What would you like to work on?"
                : "Loading conversation…\nConnecting to your paired Mac."
          }
        />
        {conversation && (
          <Composer
            selectedModel="On your Mac"
            onModelChange={() => {}}
            allowAttachments={false}
            allowModelChange={false}
            disabled={!connected || (!sending && conversation.status !== "idle")}
            isStreaming={
              sending ||
              conversation.status === "working" ||
              conversation.status === "waiting_approval"
            }
            onSend={(text) => void send(text)}
            onStop={() =>
              Alert.alert(
                "Stop all Mac activity?",
                "This emergency action stops all running Bimax conversations on your Mac.",
                [
                  { text: "Cancel", style: "cancel" },
                  {
                    text: "Stop all",
                    style: "destructive",
                    onPress: () =>
                      void sendKill("User requested emergency Stop from Mac chat").catch(() =>
                        setError("Could not confirm Stop. Check your Mac."),
                      ),
                  },
                ],
              )
            }
          />
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
