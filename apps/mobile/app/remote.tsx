import React, { useState } from "react";
import {
  Alert,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { ChatDrawer } from "../components/ChatDrawer";
import { colors } from "../lib/theme";
import { useRelayContext } from "../lib/session";
/** Connection controls live here. Mac conversations live in the drawer's Mac tab. */
export default function RemoteScreen() {
  const router = useRouter();
  const {
    status,
    trustedDesktop,
    sessions,
    connectionRoute,
    pendingApprovals,
    sendKill,
    lastKillAck,
    cloudError,
    retryCloud,
    connectionError,
    dropSession,
  } = useRelayContext();
  const [error, setError] = useState("");
  const ready =
    status === "online" && sessions.some((s) => s.peerDeviceId === trustedDesktop?.deviceId);
  const cloudConfigured = trustedDesktop?.relayUrl.startsWith("wss:") === true;
  const stop = () =>
    Alert.alert(
      "Stop all Mac activity?",
      "This stops all running Bimax conversations on your Mac.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Stop all",
          style: "destructive",
          onPress: () => {
            setError("");
            void sendKill("User stopped Mac activity").catch(() =>
              setError("Could not confirm Stop. Your Mac may be offline."),
            );
          },
        },
      ],
    );
  return (
    <SafeAreaView style={styles.page}>
      <View style={styles.header}>
        <ChatDrawer />
        <Text style={styles.title}>Mac connection</Text>
        <View style={{ width: 44 }} />
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.card}>
          <Text style={styles.cardTitle}>
            {ready
              ? "Your Mac is connected"
              : trustedDesktop
                ? "Your Mac is not connected"
                : "Connect your Mac"}
          </Text>
          <Text style={styles.detail}>
            {ready
              ? "Continue your conversations from Chat history → Mac."
              : trustedDesktop
                ? "Keep Bimax open on your Mac, with the Mac awake and online."
                : "Pair once in Mac Settings → Phone connection to continue your chats here."}
          </Text>
          <View style={styles.row}>
            <Text style={styles.label}>Current connection</Text>
            <Text style={styles.value}>
              {ready
                ? connectionRoute === "cloud"
                  ? "Cloudflare"
                  : connectionRoute === "lan"
                    ? "Local network"
                    : "Checking…"
                : "Offline"}
            </Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Access away from home</Text>
            <Text style={styles.value}>{cloudConfigured ? "Configured" : "Not set up"}</Text>
          </View>
          {!!trustedDesktop && (
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel="Reconnect to Mac"
              style={styles.button}
              onPress={() => {
                setError("");
                dropSession(trustedDesktop.deviceId);
              }}
            >
              <Text style={styles.buttonText}>Reconnect</Text>
            </TouchableOpacity>
          )}
        </View>
        {!!(error || connectionError || cloudError) && (
          <Text accessibilityRole="alert" style={styles.error}>
            {error || connectionError || cloudError}
          </Text>
        )}
        {!!trustedDesktop && (!cloudConfigured || !!cloudError) && (
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="Enable access away from home"
            style={styles.button}
            onPress={retryCloud}
          >
            <Text style={styles.buttonText}>
              {cloudConfigured ? "Retry internet setup" : "Enable access away from home"}
            </Text>
          </TouchableOpacity>
        )}
        <Text style={styles.section}>USING YOUR PHONE AWAY FROM HOME</Text>
        <View style={styles.card}>
          <Text style={styles.detail}>
            When Current connection shows Cloudflare, Mac chats can work over cellular data or
            another Wi-Fi network. Your Mac must stay awake, online, and running Bimax. Messages
            remain encrypted between your devices.
          </Text>
          <Text style={styles.detail}>
            Local network needs both devices on the same network. “Configured” means internet access
            has been set up; check the current connection before relying on it away from home.
          </Text>
          <Text style={styles.detail}>
            In this Expo Go development version, opening or reloading Bimax still needs the app’s
            development server on your Mac. The current server uses your home Wi-Fi. An installed
            app build is needed for reliable opening away from home.
          </Text>
        </View>
        <Text style={styles.section}>MAC CONTROLS</Text>
        <View style={styles.card}>
          <Text style={styles.detail}>
            Your Mac owns its models, workspace, tools, and system permissions. Change those
            settings in Bimax on your Mac. Review requested actions here on your phone.
          </Text>
          {pendingApprovals.length > 0 && (
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel="Review Mac actions"
              style={styles.button}
              onPress={() => router.push("/approvals")}
            >
              <Text style={styles.buttonText}>Review actions ({pendingApprovals.length})</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            accessibilityRole="button"
            style={styles.button}
            onPress={() => router.push("/pair")}
          >
            <Text style={styles.buttonText}>
              {trustedDesktop ? "Pair a different Mac" : "Pair your Mac"}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="Stop all Mac activity"
            disabled={!ready}
            style={[styles.button, !ready && { opacity: 0.4 }]}
            onPress={stop}
          >
            <Text style={[styles.buttonText, { color: colors.danger }]}>Stop all Mac activity</Text>
          </TouchableOpacity>
          {!!lastKillAck && (
            <Text accessibilityRole="text" style={styles.detail}>
              {lastKillAck.ok ? "Your Mac acknowledged the last Stop request." : "Your Mac could not stop all activity. Check Bimax on your Mac."}
            </Text>
          )}
        </View>
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
  title: { fontSize: 17, fontWeight: "600", color: colors.text },
  content: { padding: 20, paddingBottom: 40, gap: 16 },
  card: { padding: 18, borderRadius: 16, backgroundColor: colors.surface, gap: 16 },
  cardTitle: { fontSize: 21, lineHeight: 28, color: colors.text, fontWeight: "600" },
  section: {
    fontSize: 11,
    letterSpacing: 1,
    color: colors.muted,
    fontWeight: "600",
    marginTop: 12,
  },
  detail: { fontSize: 14, lineHeight: 22, color: colors.secondary },
  row: { flexDirection: "row", justifyContent: "space-between", flexWrap: "wrap", gap: 10 },
  label: { color: colors.secondary, fontSize: 13 },
  value: { color: colors.text, fontSize: 13 },
  button: {
    minHeight: 48,
    padding: 12,
    borderRadius: 12,
    backgroundColor: colors.background,
    justifyContent: "center",
  },
  buttonText: { color: colors.text, fontSize: 15, fontWeight: "500", textAlign: "center" },
  error: { color: colors.danger, lineHeight: 22, fontSize: 14 },
});
