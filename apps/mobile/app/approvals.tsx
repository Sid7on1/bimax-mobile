import { useState, useEffect } from "react";
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  ScrollView,
  SafeAreaView,
  ActivityIndicator,
} from "react-native";
import { useRouter } from "expo-router";
import type { ToolApprovalRequest } from "@bimax/protocol";
import { useRelayContext } from "../lib/session/provider";

function ApprovalCard({
  item,
  onApprove,
  onDeny,
}: {
  item: ToolApprovalRequest;
  onApprove: (id: string) => Promise<void>;
  onDeny: (id: string, reason?: "not_me" | "mistake") => Promise<void>;
}) {
  const [secondsLeft, setSecondsLeft] = useState<number>(() =>
    Math.max(0, Math.floor((item.expiresAt - Date.now()) / 1000)),
  );
  const [showDenyOptions, setShowDenyOptions] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    const timer = setInterval(() => {
      const left = Math.max(0, Math.floor((item.expiresAt - Date.now()) / 1000));
      setSecondsLeft(left);
    }, 1000);
    return () => clearInterval(timer);
  }, [item.expiresAt]);

  const handleApprove = async () => {
    setLoading(true);
    setErrorMsg("");
    try {
      await onApprove(item.approvalId);
    } catch {
      setErrorMsg("Authentication failed");
    } finally {
      setLoading(false);
    }
  };

  const handleDeny = async (reason?: "not_me" | "mistake") => {
    setLoading(true);
    setErrorMsg("");
    try {
      await onDeny(item.approvalId, reason);
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : "Failed to record denial",
      );
    } finally {
      setLoading(false);
    }
  };

  const isExpired = secondsLeft <= 0;

  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <Text style={styles.toolName}>{item.tool}</Text>
        <Text style={[styles.timer, isExpired && styles.timerExpired]}>
          {isExpired ? "Expired" : `Expires in ${secondsLeft}s`}
        </Text>
      </View>

      <Text style={styles.summaryText}>{item.summary}</Text>

      <View style={styles.detailBox}>
        <ScrollView style={styles.detailScroll} nestedScrollEnabled>
          <Text style={styles.detailText}>{item.detail}</Text>
        </ScrollView>
      </View>

      <Text style={styles.metaText}>Session: {item.sessionId}</Text>
      {item.cwd ? (
        <Text style={styles.metaText}>CWD: {item.cwd}</Text>
      ) : null}

      {errorMsg ? (
        <Text style={styles.cardError}>{errorMsg}</Text>
      ) : null}

      {loading ? (
        <ActivityIndicator style={{ marginVertical: 12 }} color="#111827" />
      ) : isExpired ? null : showDenyOptions ? (
        <View style={styles.denyOptionsContainer}>
          <Text style={styles.denyOptionsTitle}>Select denial reason:</Text>
          <TouchableOpacity
            style={styles.denyOptionButton}
            onPress={() => handleDeny("not_me")}
          >
            <Text style={styles.denyOptionButtonText}>
              {"It wasn't me (Alert)"}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.denyOptionButton}
            onPress={() => handleDeny("mistake")}
          >
            <Text style={styles.denyOptionButtonText}>Mistake</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.denyOptionButton}
            onPress={() => handleDeny(undefined)}
          >
            <Text style={styles.denyOptionButtonText}>Plain Deny</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.cancelOptionButton}
            onPress={() => setShowDenyOptions(false)}
          >
            <Text style={styles.cancelOptionButtonText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View style={styles.actionRow}>
          <TouchableOpacity
            style={styles.approveButton}
            onPress={handleApprove}
          >
            <Text style={styles.approveButtonText}>Approve</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.denyButton}
            onPress={() => setShowDenyOptions(true)}
          >
            <Text style={styles.denyButtonText}>Deny</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

export default function ApprovalsScreen() {
  const router = useRouter();
  const { pendingApprovals, approve, deny } = useRelayContext();

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backButton}
        >
          <Text style={styles.backButtonText}>Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Approvals</Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {pendingApprovals.length === 0 ? (
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyText}>No pending approvals.</Text>
          </View>
        ) : (
          pendingApprovals.map((req) => (
            <ApprovalCard
              key={req.approvalId}
              item={req}
              onApprove={approve}
              onDeny={deny}
            />
          ))
        )}
      </ScrollView>
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
    borderBottomColor: "#e5e7eb",
  },
  backButton: {
    paddingVertical: 6,
    paddingHorizontal: 8,
  },
  backButtonText: {
    fontSize: 16,
    color: "#2563eb",
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: "600",
    color: "#111827",
  },
  headerSpacer: {
    width: 60,
  },
  content: {
    padding: 16,
    flexGrow: 1,
  },
  emptyContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 80,
  },
  emptyText: {
    fontSize: 16,
    color: "#6b7280",
  },
  card: {
    backgroundColor: "#f9fafb",
    borderWidth: 1,
    borderColor: "#e5e7eb",
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
  },
  cardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },
  toolName: {
    fontSize: 18,
    fontWeight: "700",
    color: "#111827",
  },
  timer: {
    fontSize: 13,
    fontWeight: "600",
    color: "#059669",
  },
  timerExpired: {
    color: "#dc2626",
  },
  summaryText: {
    fontSize: 15,
    color: "#374151",
    marginBottom: 12,
    lineHeight: 20,
  },
  detailBox: {
    backgroundColor: "#1f2937",
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
    maxHeight: 160,
  },
  detailScroll: {
    maxHeight: 136,
  },
  detailText: {
    color: "#f3f4f6",
    fontFamily: "monospace",
    fontSize: 13,
    lineHeight: 18,
  },
  metaText: {
    fontSize: 12,
    color: "#6b7280",
    marginBottom: 4,
  },
  cardError: {
    color: "#dc2626",
    fontSize: 13,
    marginVertical: 8,
    fontWeight: "500",
  },
  actionRow: {
    flexDirection: "row",
    gap: 12,
    marginTop: 12,
  },
  approveButton: {
    flex: 1,
    backgroundColor: "#16a34a",
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: "center",
  },
  approveButtonText: {
    color: "#ffffff",
    fontWeight: "600",
    fontSize: 15,
  },
  denyButton: {
    flex: 1,
    backgroundColor: "#dc2626",
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: "center",
  },
  denyButtonText: {
    color: "#ffffff",
    fontWeight: "600",
    fontSize: 15,
  },
  denyOptionsContainer: {
    marginTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#d1d5db",
    paddingTop: 12,
  },
  denyOptionsTitle: {
    fontSize: 13,
    color: "#4b5563",
    fontWeight: "600",
    marginBottom: 8,
  },
  denyOptionButton: {
    backgroundColor: "#fee2e2",
    paddingVertical: 10,
    borderRadius: 6,
    alignItems: "center",
    marginBottom: 6,
  },
  denyOptionButtonText: {
    color: "#991b1b",
    fontSize: 14,
    fontWeight: "500",
  },
  cancelOptionButton: {
    paddingVertical: 8,
    alignItems: "center",
  },
  cancelOptionButtonText: {
    color: "#6b7280",
    fontSize: 14,
  },
});
