import {ChatDrawer} from '../components/ChatDrawer';
import { colors } from "../lib/theme";
import { Icon } from "../components/Icon";
import { randomId } from "../lib/crypto/keys";
// app/index.tsx
import React, { useState, useCallback } from "react";
import {
  SafeAreaView,
  View,
  Text,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  ActivityIndicator,
  Alert,
} from "react-native";
import { useRouter, useFocusEffect } from "expo-router";
import { listConversations, deleteConversation, type Conversation } from "../lib/chat-store";
import { supabase } from "../lib/supabase";

export default function ConversationListScreen() {
  const router = useRouter();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    try {
      const list = await listConversations();
      setConversations(list);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadData();
    }, [loadData]),
  );

  const handleNewChat = () => {
    const newId = randomId("conv");
    router.push(`/chat/${newId}`);
  };

  const handleDelete = (id: string, title: string) => {
    Alert.alert("Delete Conversation", `Delete "${title}"?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          await deleteConversation(id);
          loadData();
        },
      },
    ]);
  };

  const handleSignOut = async () => {
    Alert.alert("Sign Out", "Are you sure you want to sign out?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Sign Out",
        style: "destructive",
        onPress: async () => {
          await supabase.auth.signOut();
          router.replace("/login");
        },
      },
    ]);
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.header}>
        <View style={{flexDirection:"row",alignItems:"center",gap:8}}><ChatDrawer/><Text style={styles.brandTitle}>Bimax</Text></View>
        <View style={styles.headerActions}>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="Connect your Mac"
            style={styles.iconButton}
            onPress={() => router.push("/remote")}
          >
            <Icon name="monitor" />
          </TouchableOpacity>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="New chat"
            style={styles.iconButton}
            onPress={handleNewChat}
          >
            <Icon name="edit" />
          </TouchableOpacity>
        </View>
      </View>
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.text} />
        </View>
      ) : conversations.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.emptyTitle}>How can I help?</Text>
          <Text style={styles.subtitle}>A fresh space for your next idea.</Text>
          <TouchableOpacity
            accessibilityRole="button"
            style={styles.newChat}
            onPress={handleNewChat}
          >
            <Text style={styles.newChatText}>Start a conversation</Text>
          </TouchableOpacity>
          <TouchableOpacity
            accessibilityRole="button"
            style={styles.connect}
            onPress={() => router.push("/remote")}
          >
            <Text style={styles.subtitle}>Connect your Mac</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={conversations}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          ListHeaderComponent={<Text style={styles.label}>Your chats</Text>}
          renderItem={({ item }) => (
            <View style={styles.row}>
              <TouchableOpacity
                accessibilityRole="button"
                style={styles.conversation}
                onPress={() => router.push(`/chat/${item.id}`)}
              >
                <Text numberOfLines={1} style={styles.itemTitle}>
                  {item.title || "New conversation"}
                </Text>
                <Text style={styles.date}>
                  {new Date(item.updated_at).toLocaleDateString([], {
                    month: "short",
                    day: "numeric",
                  })}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel={`Delete ${item.title}`}
                style={styles.iconButton}
                onPress={() => handleDelete(item.id, item.title)}
              >
                <Icon name="close" size={16} color={colors.muted} />
              </TouchableOpacity>
            </View>
          )}
        />
      )}
      <View style={styles.footer}>
        <TouchableOpacity accessibilityRole="button" onPress={handleSignOut} style={styles.signOut}>
          <Text style={styles.footerText}>Sign out</Text>
        </TouchableOpacity>

      </View>
    </SafeAreaView>
  );
}
const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingVertical: 8,
  },
  brandTitle: { fontSize: 23, fontWeight: "600", color: colors.text, letterSpacing: -0.7 },
  headerActions: { flexDirection: "row", gap: 8 },
  iconButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  center: { flex: 1, justifyContent: "center", alignItems: "center", padding: 28 },
  emptyTitle: {
    fontSize: 29,
    fontWeight: "600",
    color: colors.text,
    letterSpacing: -0.8,
    textAlign: "center",
  },
  subtitle: {
    color: colors.secondary,
    fontSize: 15,
    lineHeight: 23,
    textAlign: "center",
    marginTop: 10,
  },
  newChat: {
    marginTop: 30,
    backgroundColor: colors.button,
    borderRadius: 28,
    paddingVertical: 16,
    paddingHorizontal: 24,
  },
  newChatText: { color: colors.buttonText, fontSize: 16, fontWeight: "600" },
  connect: { padding: 12, marginTop: 10 },
  list: { padding: 16 },
  label: { fontSize: 13, color: colors.muted, margin: 12 },
  row: { flexDirection: "row", alignItems: "center", borderRadius: 14, marginVertical: 2 },
  conversation: { flex: 1, padding: 14 },
  itemTitle: { fontSize: 17, color: colors.text, marginBottom: 6 },
  date: { fontSize: 12, color: colors.muted },
  footer: {
    paddingHorizontal: 20,
    paddingBottom: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  signOut: { minHeight: 44, justifyContent: "center" },
  footerText: { color: colors.muted, fontSize: 12 },
});
