import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { ChatDrawer } from "../components/ChatDrawer";
import { useRelayContext } from "../lib/session";
import { randomId } from "../lib/crypto/keys";
import { colors } from "../lib/theme";
export default function NewMacChat() {
  const router = useRouter();
  const {
    remoteWorkspaces,
    canCreateSessions,
    createMacSession,
    requestSessionList,
    status,
    trustedDesktop,
    sessions,
  } = useRelayContext();
  const [selected, setSelected] = useState<string | null>(null),
    [creating, setCreating] = useState(false),
    [error, setError] = useState("");
  const intent = useRef<{ workspace: string; id: string } | null>(null),
    controller = useRef<AbortController | null>(null),
    busy = useRef(false),
    alive = useRef(true);
  const ready =
    status === "online" && sessions.some((s) => s.peerDeviceId === trustedDesktop?.deviceId);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      controller.current?.abort();
    };
  }, []);
  useFocusEffect(
    useCallback(() => {
      if (ready) requestSessionList();
      return () => controller.current?.abort();
    }, [ready, requestSessionList]),
  );
  const create = async () => {
    if (!selected || !ready || busy.current) return;
    busy.current = true;
    setCreating(true);
    setError("");
    if (intent.current?.workspace !== selected)
      intent.current = { workspace: selected, id: randomId("create") };
    const abort = new AbortController();
    controller.current = abort;
    try {
      const id = await createMacSession(selected, intent.current.id, abort.signal);
      if (alive.current && !abort.signal.aborted)
        router.replace({ pathname: "/desktop-chat/[id]", params: { id } });
    } catch (e) {
      if (alive.current && !abort.signal.aborted)
        setError(e instanceof Error ? e.message : "Could not create chat");
    } finally {
      busy.current = false;
      if (alive.current) setCreating(false);
    }
  };
  return (
    <SafeAreaView style={styles.page}>
      <View style={styles.header}>
        <ChatDrawer selectedSource="mac" />
        <Text style={styles.heading}>New Mac chat</Text>
        <View style={{ width: 44 }} />
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Choose a folder</Text>
        <Text style={styles.detail}>
          This chat will stay with the folder you choose, even while your Mac is on Home. Existing
          chats keep their own folders.
        </Text>
        {!ready && (
          <Text accessibilityRole="alert" style={styles.detail}>
            Connect to your Mac before starting a Mac chat.
          </Text>
        )}
        {ready && !canCreateSessions && (
          <Text accessibilityRole="alert" style={styles.detail}>
            Waiting for folder support. Use the updated Bimax build on your Mac, then refresh.
          </Text>
        )}
        {ready && canCreateSessions && !remoteWorkspaces.length && (
          <Text style={styles.detail}>
            No folders yet. Open a project folder in Bimax on your Mac first.
          </Text>
        )}
        {remoteWorkspaces.map((workspace) => (
          <TouchableOpacity
            key={workspace.id}
            accessibilityRole="radio"
            accessibilityLabel={`Use folder ${workspace.name}`}
            accessibilityState={{ checked: selected === workspace.id, disabled: creating }}
            aria-checked={selected === workspace.id}
            disabled={creating}
            onPress={() => {
              setSelected(workspace.id);
              setError("");
            }}
            style={[styles.folder, selected === workspace.id && styles.selected]}
          >
            <Text style={styles.folderName}>{workspace.name}</Text>
            <Text style={styles.detail}>{workspace.location}</Text>
          </TouchableOpacity>
        ))}
        {!!error && (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        )}
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="Create Mac chat"
          disabled={!ready || !canCreateSessions || !selected || creating}
          onPress={() => void create()}
          style={[
            styles.create,
            (!ready || !canCreateSessions || !selected || creating) && { opacity: 0.4 },
          ]}
        >
          {creating ? (
            <ActivityIndicator color={colors.buttonText} />
          ) : (
            <Text style={styles.createText}>Start new chat</Text>
          )}
        </TouchableOpacity>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="Refresh Mac folders"
          disabled={!ready || creating}
          onPress={requestSessionList}
          style={styles.refresh}
        >
          <Text style={styles.detail}>Refresh folders</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}
const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.background },
  header: {
    minHeight: 64,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  heading: { fontSize: 17, fontWeight: "600", color: colors.text },
  content: { padding: 24, gap: 18 },
  title: {
    fontSize: 30,
    lineHeight: 37,
    fontWeight: "600",
    color: colors.text,
    letterSpacing: -0.8,
  },
  detail: { fontSize: 15, lineHeight: 23, color: colors.secondary },
  folder: { padding: 18, borderRadius: 16, borderWidth: 1, borderColor: colors.border, gap: 4 },
  selected: { borderColor: colors.text, backgroundColor: colors.surface },
  folderName: { fontSize: 17, fontWeight: "600", color: colors.text },
  create: {
    minHeight: 52,
    borderRadius: 26,
    backgroundColor: colors.button,
    alignItems: "center",
    justifyContent: "center",
  },
  createText: { fontSize: 16, fontWeight: "600", color: colors.buttonText },
  refresh: { minHeight: 44, alignItems: "center", justifyContent: "center" },
  error: { fontSize: 14, lineHeight: 22, color: colors.danger },
});
