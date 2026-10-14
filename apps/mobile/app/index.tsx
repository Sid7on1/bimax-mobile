// app/index.tsx
import React, { useState, useEffect, useCallback } from "react";
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
import {
  listConversations,
  deleteConversation,
  type Conversation,
} from "../lib/chat-store";
import { getUsage, type UsageInfo } from "../lib/gateway";
import { supabase } from "../lib/supabase";

export default function ConversationListScreen() {
  const router = useRouter();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [usage, setUsage] = useState<UsageInfo | null>(null);

  const loadData = useCallback(async () => {
    try {
      const list = await listConversations();
      setConversations(list);
      const u = await getUsage();
      if (u) setUsage(u);
    } catch (_err) {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadData();
    }, [loadData])
  );

  const handleNewChat = () => {
    const newId = `conv-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
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
      {/* Top Header */}
      <View style={styles.header}>
        <View style={styles.brandRow}>
          <Text style={styles.brandTitle}>✦ Bimax Chat</Text>
        </View>

        <View style={styles.headerActions}>
          <TouchableOpacity
            style={styles.remoteBtn}
            onPress={() => router.push("/remote")}
          >
            <Text style={styles.remoteBtnText}>💻 Laptop</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.signOutBtn} onPress={handleSignOut}>
            <Text style={styles.signOutText}>Sign Out</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Main List */}
      {loading ? (
        <View style={styles.centerContainer}>
          <ActivityIndicator size="large" color="#007aff" />
        </View>
      ) : conversations.length === 0 ? (
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyIcon}>💬</Text>
          <Text style={styles.emptyTitle}>No Conversations Yet</Text>
          <Text style={styles.emptySubtitle}>
            Start a new conversation powered by DeepSeek and Qwen.
          </Text>
          <TouchableOpacity style={styles.newChatButton} onPress={handleNewChat}>
            <Text style={styles.newChatButtonText}>+ Start New Chat</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={conversations}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.listContent}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={styles.itemCard}
              onPress={() => router.push(`/chat/${item.id}`)}
              activeOpacity={0.7}
            >
              <View style={styles.itemMain}>
                <Text numberOfLines={1} style={styles.itemTitle}>
                  {item.title || "New Conversation"}
                </Text>
                <View style={styles.metaRow}>
                  <Text style={styles.modelTag}>{item.model}</Text>
                  <Text style={styles.dateText}>
                    {new Date(item.updated_at).toLocaleDateString([], {
                      month: "short",
                      day: "numeric",
                    })}
                  </Text>
                </View>
              </View>

              <TouchableOpacity
                onPress={() => handleDelete(item.id, item.title)}
                style={styles.deleteButton}
              >
                <Text style={styles.deleteIcon}>✕</Text>
              </TouchableOpacity>
            </TouchableOpacity>
          )}
        />
      )}

      {/* Floating Action Button (New Chat) */}
      {conversations.length > 0 && (
        <TouchableOpacity style={styles.fab} onPress={handleNewChat} activeOpacity={0.8}>
          <Text style={styles.fabText}>✎ New Chat</Text>
        </TouchableOpacity>
      )}

      {/* Usage Footer */}
      {usage && (
        <View style={styles.usageFooter}>
          <Text style={styles.usageText}>
            Monthly Tokens: {usage.tokensUsed.toLocaleString()} /{" "}
            {usage.tokenBudget.toLocaleString()} (
            {Math.round((usage.tokensUsed / usage.tokenBudget) * 100)}%) • Resets{" "}
            {new Date(usage.resetAt).toLocaleDateString([], { month: "short", day: "numeric" })}
          </Text>
        </View>
      )}
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
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#e5e5ea",
  },
  brandRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  brandTitle: {
    fontSize: 20,
    fontWeight: "800",
    color: "#000000",
    letterSpacing: -0.3,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  remoteBtn: {
    backgroundColor: "#f2f2f7",
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
  },
  remoteBtnText: {
    fontSize: 12,
    fontWeight: "600",
    color: "#3a3a3c",
  },
  signOutBtn: {
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  signOutText: {
    fontSize: 13,
    color: "#ff3b30",
    fontWeight: "500",
  },
  centerContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  emptyContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 32,
  },
  emptyIcon: {
    fontSize: 48,
    marginBottom: 16,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: "700",
    color: "#1c1c1e",
    marginBottom: 6,
  },
  emptySubtitle: {
    fontSize: 14,
    color: "#8e8e93",
    textAlign: "center",
    marginBottom: 24,
    lineHeight: 20,
  },
  newChatButton: {
    backgroundColor: "#007aff",
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 14,
  },
  newChatButtonText: {
    fontSize: 15,
    fontWeight: "600",
    color: "#ffffff",
  },
  listContent: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 80,
  },
  itemCard: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#f9f9fb",
    borderRadius: 14,
    padding: 14,
    marginVertical: 4,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#e5e5ea",
  },
  itemMain: {
    flex: 1,
    marginRight: 10,
  },
  itemTitle: {
    fontSize: 16,
    fontWeight: "600",
    color: "#1c1c1e",
    marginBottom: 4,
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  modelTag: {
    fontSize: 11,
    color: "#007aff",
    backgroundColor: "#e5f1ff",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    fontWeight: "500",
  },
  dateText: {
    fontSize: 12,
    color: "#8e8e93",
  },
  deleteButton: {
    padding: 6,
  },
  deleteIcon: {
    fontSize: 14,
    color: "#c7c7cc",
  },
  fab: {
    position: "absolute",
    bottom: 40,
    right: 20,
    backgroundColor: "#007aff",
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 24,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.2,
    shadowRadius: 6,
    elevation: 4,
  },
  fabText: {
    fontSize: 15,
    fontWeight: "600",
    color: "#ffffff",
  },
  usageFooter: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#e5e5ea",
    paddingVertical: 8,
    paddingHorizontal: 16,
    backgroundColor: "#f9f9fb",
  },
  usageText: {
    fontSize: 11,
    color: "#636366",
    textAlign: "center",
  },
});
