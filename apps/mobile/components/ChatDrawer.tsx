import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Alert,
  Modal,
  KeyboardAvoidingView,
  Platform,
  Keyboard,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from "react-native";
import { useRouter } from "expo-router";
import { useRelayContext } from "../lib/session";
import { listConversations, deleteConversation, type Conversation } from "../lib/chat-store";
import { randomId } from "../lib/crypto/keys";
import { isActiveAccount, requireActiveAccount } from "../lib/account-scope";
import { usePhonePreferences } from "../lib/preferences-context";
import { colors } from "../lib/theme";
import { Icon } from "./Icon";
export function ChatDrawer({
  selectedId,
  selectedSource,
}: {
  selectedId?: string;
  selectedSource?: "phone" | "mac";
}) {
  const router = useRouter(),
    { width } = useWindowDimensions();
  const { remoteSessions, trustedDesktop, status, sessions } = useRelayContext();
  const [source, setSource] = useState<"phone" | "mac">(selectedSource ?? "phone");
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState(""),
    [chats, setChats] = useState<Conversation[]>([]),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  const { reduceMotion } = usePhonePreferences();
  const listOpacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    listOpacity.stopAnimation();
    if (reduceMotion || !open) {
      listOpacity.setValue(1);
      return;
    }
    listOpacity.setValue(0.35);
    const animation = Animated.timing(listOpacity, {
      toValue: 1,
      duration: 160,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [source, open, reduceMotion, listOpacity]);
  const owner = requireActiveAccount();
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await listConversations();
      if (isActiveAccount(owner)) setChats(data);
    } catch {
      if (isActiveAccount(owner))
        setError("Could not load phone chats. Close and reopen history to retry.");
    } finally {
      if (isActiveAccount(owner)) setLoading(false);
    }
  }, [owner]);
  const show = () => {
    Keyboard.dismiss();
    setQuery("");
    setOpen(true);
    void load();
  };
  const navigate = (id: string, source: "phone" | "mac") => {
    Keyboard.dismiss();
    setOpen(false);
    if (id === selectedId && source === selectedSource) return;
    router.replace({
      pathname: source === "mac" ? "/desktop-chat/[id]" : "/chat/[id]",
      params: { id },
    });
  };
  const remove = (chat: Conversation) =>
    Alert.alert("Delete phone chat?", `Delete “${chat.title || "New chat"}” from this phone?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          if (!isActiveAccount(owner)) return;
          void deleteConversation(chat.id)
            .then(() => {
              if (!isActiveAccount(owner)) return;
              if (chat.id === selectedId && selectedSource === "phone") {
                setOpen(false);
                router.replace("/");
              } else void load();
            })
            .catch(() => setError("Could not delete this chat."));
        },
      },
    ]);
  const needle = query.trim().toLocaleLowerCase();
  const local = chats.filter((c) => (c.title || "New chat").toLocaleLowerCase().includes(needle)),
    mac = remoteSessions.filter((c) =>
      `${c.title} ${c.workspace?.name ?? ""} ${c.workspace?.location ?? ""}`
        .toLocaleLowerCase()
        .includes(needle),
    );
  const ready =
    status === "online" && sessions.some((s) => s.peerDeviceId === trustedDesktop?.deviceId);
  return (
    <>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel="Chat history"
        onPress={show}
        style={styles.icon}
      >
        <Icon name="menu" />
      </TouchableOpacity>
      <Modal
        visible={open}
        transparent
        animationType={reduceMotion ? "none" : "fade"}
        onRequestClose={() => setOpen(false)}
      >
        <View style={styles.overlay}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close chat history"
            onPress={() => setOpen(false)}
            style={StyleSheet.absoluteFill}
          />
          <KeyboardAvoidingView
            behavior={Platform.OS === "ios" ? "padding" : undefined}
            style={[styles.panel, { width: Math.min(340, width - 40) }]}
          >
            <SafeAreaView accessibilityViewIsModal style={{ flex: 1 }}>
              <View style={styles.heading}>
                <Text style={styles.brand}>Bimax</Text>
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel="Close drawer"
                  onPress={() => setOpen(false)}
                  style={styles.icon}
                >
                  <Icon name="close" size={19} />
                </TouchableOpacity>
              </View>
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel={source === "mac" ? "New Mac chat" : "New phone chat"}
                style={styles.newChat}
                onPress={() => {
                  if (source === "phone") navigate(randomId("conv"), "phone");
                  else {
                    Keyboard.dismiss();
                    setOpen(false);
                    router.replace("/desktop-new");
                  }
                }}
              >
                <Icon name="edit" size={19} />
                <Text style={styles.newText}>{source === "mac" ? "New Mac chat" : "New chat"}</Text>
              </TouchableOpacity>
              <View accessibilityRole="tablist" style={styles.sourceSwitch}>
                {(["phone", "mac"] as const).map((device) => (
                  <TouchableOpacity
                    key={device}
                    accessibilityRole="tab"
                    accessibilityLabel={device === "phone" ? "Phone chats" : "Mac chats"}
                    aria-selected={source === device}
                    accessibilityState={{ selected: source === device }}
                    onPress={() => setSource(device)}
                    style={[styles.sourceTab, source === device && styles.sourceActive]}
                  >
                    <Text style={[styles.sourceText, source === device && styles.sourceTextActive]}>
                      {device === "phone" ? "Phone" : "Mac"}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
              <TextInput
                accessibilityLabel="Search chats"
                placeholder="Search chats"
                placeholderTextColor={colors.muted}
                keyboardAppearance="dark"
                autoCorrect={false}
                value={query}
                onChangeText={setQuery}
                maxLength={256}
                style={styles.search}
              />
              <Animated.ScrollView
                style={{ opacity: listOpacity }}
                keyboardShouldPersistTaps="handled"
                contentContainerStyle={styles.list}
              >
                {!!error && (
                  <Text accessibilityRole="alert" style={styles.note}>
                    {error}
                  </Text>
                )}
                {source === "mac" && (
                  <>
                    <Text style={styles.section}>On your Mac</Text>
                    {mac.map((chat) => (
                      <TouchableOpacity
                        accessibilityRole="button"
                        accessibilityLabel={`Open Mac chat ${chat.title}`}
                        aria-selected={selectedSource === "mac" && selectedId === chat.sessionId}
                        accessibilityState={{
                          selected: selectedSource === "mac" && selectedId === chat.sessionId,
                        }}
                        key={"mac:" + chat.sessionId}
                        style={[
                          styles.row,
                          selectedSource === "mac" &&
                            selectedId === chat.sessionId &&
                            styles.selected,
                        ]}
                        onPress={() => navigate(chat.sessionId, "mac")}
                      >
                        <View style={{ flex: 1, gap: 4 }}>
                          <Text style={styles.title} numberOfLines={1}>
                            {chat.title || "Untitled"}
                          </Text>
                          <Text numberOfLines={1} style={styles.connection}>
                            {chat.workspace
                              ? `${chat.workspace.name} · ${chat.workspace.location}`
                              : "Folder unavailable"}
                          </Text>
                        </View>
                        {chat.status === "working" && <View style={styles.dot} />}
                      </TouchableOpacity>
                    ))}
                    {!mac.length && (
                      <Text style={styles.note}>
                        {query
                          ? "No matching Mac chats"
                          : trustedDesktop
                            ? ready
                              ? "No Mac chats yet"
                              : "Mac chats appear when connected"
                            : "Connect your Mac to see its chats"}
                      </Text>
                    )}
                  </>
                )}
                {source === "phone" && (
                  <>
                    <Text style={styles.section}>On this phone</Text>
                    {loading && <ActivityIndicator color={colors.secondary} />}
                    {local.map((chat) => (
                      <View
                        key={"phone:" + chat.id}
                        style={[
                          styles.row,
                          selectedSource === "phone" && selectedId === chat.id && styles.selected,
                        ]}
                      >
                        <TouchableOpacity
                          accessibilityRole="button"
                          accessibilityLabel={`Open phone chat ${chat.title}`}
                          aria-selected={selectedSource === "phone" && selectedId === chat.id}
                          accessibilityState={{
                            selected: selectedSource === "phone" && selectedId === chat.id,
                          }}
                          style={styles.rowMain}
                          onPress={() => navigate(chat.id, "phone")}
                          onLongPress={() => remove(chat)}
                        >
                          <Text style={styles.title} numberOfLines={1}>
                            {chat.title || "New chat"}
                          </Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          accessibilityRole="button"
                          accessibilityLabel={`Delete phone chat ${chat.title}`}
                          onPress={() => remove(chat)}
                          style={styles.delete}
                        >
                          <Icon name="close" size={13} color={colors.muted} />
                        </TouchableOpacity>
                      </View>
                    ))}
                    {!loading && !local.length && (
                      <Text style={styles.note}>
                        {query ? "No matching phone chats" : "Your phone chats will appear here"}
                      </Text>
                    )}
                  </>
                )}
              </Animated.ScrollView>
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel="Mac connection"
                onPress={() => {
                  Keyboard.dismiss();
                  setOpen(false);
                  router.push("/remote");
                }}
                style={styles.footer}
              >
                <Icon name="monitor" size={19} />
                <View>
                  <Text style={styles.newText}>Your Mac</Text>
                  <Text style={styles.connection}>
                    {ready ? "Connected" : trustedDesktop ? "Not connected" : "Set up connection"}
                  </Text>
                </View>
              </TouchableOpacity>
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel="Settings"
                onPress={() => {
                  Keyboard.dismiss();
                  setOpen(false);
                  router.push("/settings");
                }}
                style={[styles.footer, { minHeight: 56, borderTopWidth: 0 }]}
              >
                <Icon name="settings" size={19} />
                <Text style={styles.newText}>Settings</Text>
              </TouchableOpacity>
            </SafeAreaView>
          </KeyboardAvoidingView>
        </View>
      </Modal>
    </>
  );
}
const styles = StyleSheet.create({
  sourceSwitch: {
    marginHorizontal: 14,
    marginTop: 10,
    padding: 4,
    borderRadius: 12,
    backgroundColor: colors.background,
    flexDirection: "row",
  },
  sourceTab: {
    flex: 1,
    minHeight: 38,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 9,
  },
  sourceActive: { backgroundColor: colors.border },
  sourceText: { fontSize: 14, fontWeight: "500", color: colors.secondary },
  sourceTextActive: { color: colors.text },

  icon: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,.55)" },
  panel: { height: "100%", backgroundColor: colors.surface },
  heading: {
    height: 62,
    paddingLeft: 22,
    paddingRight: 8,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  brand: { fontSize: 21, fontWeight: "600", color: colors.text, letterSpacing: -0.5 },
  newChat: {
    marginHorizontal: 12,
    minHeight: 48,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  newText: { fontSize: 15, fontWeight: "500", color: colors.text },
  search: {
    margin: 14,
    paddingHorizontal: 14,
    height: 44,
    borderRadius: 12,
    backgroundColor: colors.background,
    color: colors.text,
    fontSize: 15,
  },
  list: { paddingHorizontal: 12, paddingBottom: 20 },
  section: {
    fontSize: 12,
    fontWeight: "600",
    color: colors.muted,
    paddingHorizontal: 12,
    marginTop: 22,
    marginBottom: 8,
  },
  row: {
    minHeight: 48,
    paddingHorizontal: 12,
    borderRadius: 9,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  selected: { backgroundColor: colors.border },
  title: { fontSize: 15, color: colors.text, flex: 1 },
  rowMain: { flex: 1, minHeight: 48, justifyContent: "center" },
  delete: { minWidth: 36, minHeight: 44, alignItems: "center", justifyContent: "center" },
  note: { fontSize: 13, color: colors.secondary, lineHeight: 20, padding: 12 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.success },
  footer: {
    minHeight: 72,
    paddingHorizontal: 24,
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  connection: { fontSize: 12, color: colors.secondary, marginTop: 3 },
});
