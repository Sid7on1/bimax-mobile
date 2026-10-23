// app/remote.tsx
import { useState, useEffect } from "react";
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  TextInput,
  ScrollView,
  SafeAreaView,
  Alert,
} from "react-native";
import { useRouter } from "expo-router";
import type { AgentState } from "@bimax/protocol";
import { useRelayContext } from "../lib/session";

function getStatusBadgeColor(state: AgentState | "unknown"): {
  bg: string;
  text: string;
} {
  switch (state) {
    case "working":
      return { bg: "#dcfce7", text: "#15803d" };
    case "waiting_approval":
      return { bg: "#fef3c7", text: "#b45309" };
    case "error":
      return { bg: "#fee2e2", text: "#b91c1c" };
    case "idle":
      return { bg: "#f3f4f6", text: "#4b5563" };
    default:
      return { bg: "#f3f4f6", text: "#6b7280" };
  }
}

export default function RemoteScreen() {
  const router = useRouter();
  const {
    status,
    connectionError,
    trustedDesktop,
    sessions,
    pendingApprovals,
    agentStatus,
    remoteSessions,
    commandLog,
    sendInstruction,
    requestSessionList,
    sendKill,
    lastKillAck,
  } = useRelayContext();

  const [instructionText, setInstructionText] = useState("");
  const [composerError, setComposerError] = useState("");
  const [secondsAgo, setSecondsAgo] = useState<number | null>(null);

  useEffect(() => {
    if (status !== "idle") {
      try {
        requestSessionList();
      } catch {
        // ignore
      }
    }
  }, [status, requestSessionList]);

  useEffect(() => {
    if (!agentStatus) {
      setSecondsAgo(null);
      return;
    }
    const updateDiff = () => {
      const diff = Math.max(0, Math.floor((Date.now() - agentStatus.updatedAt) / 1000));
      setSecondsAgo(diff);
    };
    updateDiff();
    const interval = setInterval(updateDiff, 1000);
    return () => clearInterval(interval);
  }, [agentStatus]);

  const handleSendInstruction = async () => {
    setComposerError("");
    if (!instructionText.trim()) {
      setComposerError("Instruction cannot be empty.");
      return;
    }
    if (status === "idle" || sessions.length === 0) {
      setComposerError("Not connected to desktop. Connect or pair first.");
      return;
    }

    try {
      await sendInstruction(instructionText);
      setInstructionText("");
    } catch (err) {
      setComposerError(err instanceof Error ? err.message : "Failed to send instruction");
    }
  };

  const handleKillPress = () => {
    Alert.alert("Kill agent?", "This immediately stops the desktop agent.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Kill",
        style: "destructive",
        onPress: async () => {
          try {
            await sendKill("user requested from phone");
          } catch (err) {
            Alert.alert(
              "Couldn't send kill signal",
              err instanceof Error ? err.message : "Not connected",
            );
          }
        },
      },
    ]);
  };

  const agentState: AgentState | "unknown" = agentStatus?.state ?? "unknown";
  const badgeColors = getStatusBadgeColor(agentState);
  const isNoTrustedDesktop = !trustedDesktop;
  const isReconnecting = !!trustedDesktop && status !== "online";

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <Text style={styles.backButtonText}>← Back</Text>
        </TouchableOpacity>
        <View>
          <Text style={styles.headerTitle}>Bimax Remote</Text>
          <View style={styles.statusRow}>
            <View
              style={[
                styles.statusDot,
                status === "online" ? styles.statusDotOnline : styles.statusDotOffline,
              ]}
            />
            <Text style={styles.statusText}>{status}</Text>
          </View>
        </View>

        <View style={[styles.agentBadge, { backgroundColor: badgeColors.bg }]}>
          <Text style={[styles.agentBadgeText, { color: badgeColors.text }]}>
            {agentState.toUpperCase()}
          </Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {connectionError && (
          <View style={styles.pairCard}>
            <Text style={styles.cardTitle}>Secure connection needs attention</Text>
            <Text style={styles.cardBody}>{connectionError}</Text>
            <TouchableOpacity style={styles.primaryButton} onPress={() => router.push("/pair")}>
              <Text style={styles.primaryButtonText}>Scan Desktop QR</Text>
            </TouchableOpacity>
          </View>
        )}
        {isNoTrustedDesktop && (
          <View style={styles.pairCard}>
            <Text style={styles.cardTitle}>No Paired Desktop</Text>
            <Text style={styles.cardBody}>
              Pair this mobile remote with your Bimax desktop app to control agents, approve tools,
              and view live sessions.
            </Text>
            <TouchableOpacity style={styles.primaryButton} onPress={() => router.push("/pair")}>
              <Text style={styles.primaryButtonText}>Pair a Desktop</Text>
            </TouchableOpacity>
          </View>
        )}

        {isReconnecting && (
          <View style={styles.pairCard}>
            <Text style={styles.cardTitle}>Reconnecting to desktop…</Text>
            <Text style={styles.cardBody}>
              Your paired desktop is configured but unreachable. Make sure the laptop is awake and
              on the network — no need to pair again.
            </Text>
          </View>
        )}

        {pendingApprovals.length > 0 && (
          <TouchableOpacity style={styles.approvalBanner} onPress={() => router.push("/approvals")}>
            <Text style={styles.approvalBannerText}>
              ⚠️ {pendingApprovals.length} approval
              {pendingApprovals.length > 1 ? "s" : ""} waiting
            </Text>
            <Text style={styles.approvalBannerSubtext}>Tap to review →</Text>
          </TouchableOpacity>
        )}

        <View style={styles.card}>
          <View style={styles.cardHeaderRow}>
            <Text style={styles.cardTitle}>Agent Status</Text>
            {secondsAgo !== null && (
              <Text style={styles.timestampText}>Updated {secondsAgo}s ago</Text>
            )}
          </View>

          {agentStatus ? (
            <View>
              {agentStatus.sessionId && (
                <Text style={styles.sessionMetaText}>Session: {agentStatus.sessionId}</Text>
              )}
              <Text style={styles.taskSummaryText}>
                {agentStatus.taskSummary || "No active task description"}
              </Text>
            </View>
          ) : (
            <Text style={styles.cardPlaceholderText}>
              Waiting for desktop agent status report...
            </Text>
          )}
        </View>

        <View style={styles.card}>
          <View style={styles.cardHeaderRow}>
            <Text style={styles.cardTitle}>Active Sessions</Text>
            <TouchableOpacity
              style={styles.refreshButton}
              onPress={() => {
                try {
                  requestSessionList();
                } catch (err) {
                  setComposerError(err instanceof Error ? err.message : "Failed to refresh");
                }
              }}
            >
              <Text style={styles.refreshButtonText}>Refresh</Text>
            </TouchableOpacity>
          </View>

          {remoteSessions.length === 0 ? (
            <Text style={styles.cardPlaceholderText}>No active sessions reported.</Text>
          ) : (
            remoteSessions.map((s) => {
              const itemBadge = getStatusBadgeColor(s.status);
              return (
                <View key={s.sessionId} style={styles.sessionItem}>
                  <View style={styles.sessionItemMain}>
                    <Text style={styles.sessionItemTitle}>{s.title}</Text>
                    <Text style={styles.sessionItemId}>{s.sessionId}</Text>
                  </View>
                  <View style={[styles.sessionItemBadge, { backgroundColor: itemBadge.bg }]}>
                    <Text style={[styles.sessionItemBadgeText, { color: itemBadge.text }]}>
                      {s.status}
                    </Text>
                  </View>
                </View>
              );
            })
          )}
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Send Instruction</Text>
          <TextInput
            style={styles.composerInput}
            value={instructionText}
            onChangeText={(text) => {
              setInstructionText(text);
              if (composerError) setComposerError("");
            }}
            placeholder="Tell Bimax what to do..."
            placeholderTextColor="#9ca3af"
            multiline
            numberOfLines={3}
          />
          {composerError ? <Text style={styles.errorText}>{composerError}</Text> : null}
          <TouchableOpacity style={styles.primaryButton} onPress={handleSendInstruction}>
            <Text style={styles.primaryButtonText}>Send Instruction</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Recent Commands</Text>
          {commandLog.length === 0 ? (
            <Text style={styles.cardPlaceholderText}>No commands sent yet.</Text>
          ) : (
            commandLog
              .slice()
              .reverse()
              .map((cmd) => {
                const icon = cmd.status === "acked" ? "✓" : cmd.status === "failed" ? "✗" : "…";
                const iconColor =
                  cmd.status === "acked"
                    ? "#16a34a"
                    : cmd.status === "failed"
                      ? "#dc2626"
                      : "#d97706";
                return (
                  <View key={cmd.idempotencyKey} style={styles.logItem}>
                    <View style={styles.logHeader}>
                      <Text style={[styles.logIcon, { color: iconColor }]}>
                        {icon} {cmd.status.toUpperCase()}
                      </Text>
                      <Text style={styles.logTime}>{new Date(cmd.at).toLocaleTimeString()}</Text>
                    </View>
                    <Text style={styles.logInstruction}>{cmd.instruction}</Text>
                    {cmd.summary && <Text style={styles.logSummary}>{cmd.summary}</Text>}
                  </View>
                );
              })
          )}
        </View>

        <TouchableOpacity style={styles.killButton} onPress={handleKillPress}>
          <Text style={styles.killButtonText}>Kill Agent</Text>
        </TouchableOpacity>
        {lastKillAck ? (
          <Text style={[styles.killAckText, { color: lastKillAck.ok ? "#16a34a" : "#dc2626" }]}>
            {lastKillAck.ok
              ? "✓ Kill acknowledged"
              : `✗ Kill failed${lastKillAck.detail ? `: ${lastKillAck.detail}` : ""}`}
          </Text>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  killAckText: {
    fontSize: 13,
    fontWeight: "600",
    textAlign: "center",
    marginTop: 8,
  },
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
    borderBottomColor: "#e5e7eb",
  },
  backButton: {
    paddingRight: 8,
  },
  backButtonText: {
    fontSize: 14,
    color: "#007aff",
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "#111827",
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 2,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 6,
  },
  statusDotOnline: {
    backgroundColor: "#16a34a",
  },
  statusDotOffline: {
    backgroundColor: "#9ca3af",
  },
  statusText: {
    fontSize: 12,
    color: "#6b7280",
    textTransform: "capitalize",
  },
  agentBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  agentBadgeText: {
    fontSize: 12,
    fontWeight: "700",
  },
  content: {
    padding: 16,
    paddingBottom: 32,
  },
  pairCard: {
    backgroundColor: "#f9fafb",
    borderWidth: 1,
    borderColor: "#e5e7eb",
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
  },
  card: {
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "#e5e7eb",
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
    elevation: 1,
  },
  cardHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: "#111827",
    marginBottom: 6,
  },
  cardBody: {
    fontSize: 14,
    color: "#4b5563",
    lineHeight: 20,
    marginBottom: 16,
  },
  cardPlaceholderText: {
    fontSize: 14,
    color: "#9ca3af",
    fontStyle: "italic",
  },
  timestampText: {
    fontSize: 12,
    color: "#6b7280",
  },
  sessionMetaText: {
    fontSize: 12,
    fontFamily: "monospace",
    color: "#6b7280",
    marginBottom: 4,
  },
  taskSummaryText: {
    fontSize: 14,
    color: "#1f2937",
    lineHeight: 20,
  },
  approvalBanner: {
    backgroundColor: "#fef3c7",
    borderWidth: 1,
    borderColor: "#f59e0b",
    borderRadius: 10,
    padding: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 16,
  },
  approvalBannerText: {
    fontSize: 15,
    fontWeight: "700",
    color: "#92400e",
  },
  approvalBannerSubtext: {
    fontSize: 13,
    fontWeight: "600",
    color: "#b45309",
  },
  refreshButton: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    backgroundColor: "#f3f4f6",
    borderRadius: 6,
  },
  refreshButtonText: {
    fontSize: 12,
    fontWeight: "600",
    color: "#374151",
  },
  sessionItem: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#f3f4f6",
  },
  sessionItemMain: {
    flex: 1,
    marginRight: 8,
  },
  sessionItemTitle: {
    fontSize: 14,
    fontWeight: "600",
    color: "#111827",
  },
  sessionItemId: {
    fontSize: 11,
    color: "#9ca3af",
    fontFamily: "monospace",
  },
  sessionItemBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 8,
  },
  sessionItemBadgeText: {
    fontSize: 11,
    fontWeight: "600",
  },
  composerInput: {
    backgroundColor: "#f9fafb",
    borderWidth: 1,
    borderColor: "#d1d5db",
    borderRadius: 8,
    padding: 10,
    fontSize: 14,
    color: "#111827",
    minHeight: 70,
    textAlignVertical: "top",
    marginBottom: 10,
  },
  errorText: {
    color: "#dc2626",
    fontSize: 13,
    marginBottom: 8,
  },
  primaryButton: {
    backgroundColor: "#111827",
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: "center",
  },
  primaryButtonText: {
    color: "#ffffff",
    fontSize: 15,
    fontWeight: "600",
  },
  logItem: {
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#f3f4f6",
  },
  logHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 2,
  },
  logIcon: {
    fontSize: 12,
    fontWeight: "700",
  },
  logTime: {
    fontSize: 11,
    color: "#9ca3af",
  },
  logInstruction: {
    fontSize: 13,
    color: "#1f2937",
  },
  logSummary: {
    fontSize: 12,
    color: "#4b5563",
    marginTop: 2,
    fontStyle: "italic",
  },
  killButton: {
    backgroundColor: "#dc2626",
    paddingVertical: 14,
    borderRadius: 8,
    alignItems: "center",
    marginTop: 8,
    marginBottom: 16,
  },
  killButtonText: {
    color: "#ffffff",
    fontSize: 16,
    fontWeight: "700",
  },
});
