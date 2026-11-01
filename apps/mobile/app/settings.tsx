import React from "react";
import {
  Alert,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import Constants from "expo-constants";
import { ChatDrawer } from "../components/ChatDrawer";
import { colors } from "../lib/theme";
import { useRelayContext } from "../lib/session";
import { usePhonePreferences } from "../lib/preferences-context";
import { supabase } from "../lib/supabase";
export default function SettingsScreen() {
  const router = useRouter(),
    { trustedDesktop, sessions, status } = useRelayContext();
  const { preferences, setPreference, ready, error } = usePhonePreferences();
  const connected =
    status === "online" && sessions.some((s) => s.peerDeviceId === trustedDesktop?.deviceId);
  const signOut = () =>
    Alert.alert("Sign out of Bimax?", "Your saved chats stay on this phone.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Sign out",
        style: "destructive",
        onPress: () => {
          void supabase.auth
            .signOut()
            .then(({ error }) => {
              if (error) Alert.alert("Could not sign out", error.message);
              else router.replace("/login");
            })
            .catch(() => Alert.alert("Could not sign out", "Please try again."));
        },
      },
    ]);
  return (
    <SafeAreaView style={styles.page}>
      <View style={styles.header}>
        <ChatDrawer />
        <Text style={styles.title}>Settings</Text>
        <View style={{ width: 44 }} />
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.section}>APPEARANCE</Text>
        <View style={styles.group}>
          <View style={styles.row}>
            <Text style={styles.label}>Appearance</Text>
            <Text style={styles.value}>Dark</Text>
          </View>
          <View style={styles.row}>
            <View style={{ flex: 1 }}>
              <Text style={styles.label}>Chat text size</Text>
              <Text style={styles.detail}>Reading size on this phone. Your Mac’s text size stays unchanged.</Text>
            </View>
            <View style={{ flexDirection: "row", gap: 8 }}>
              {(["comfortable", "large"] as const).map((size) => (
                <TouchableOpacity
                  key={size}
                  accessibilityRole="radio"
                  accessibilityLabel={`${size} chat text`}
                  accessibilityState={{ checked: preferences.textSize === size }}
                  aria-checked={preferences.textSize === size}
                  disabled={!ready}
                  onPress={() => setPreference("textSize", size)}
                  style={{
                    minHeight: 44,
                    minWidth: 44,
                    padding: 8,
                    justifyContent: "center",
                    borderWidth: 1,
                    borderRadius: 10,
                    borderColor: preferences.textSize === size ? colors.text : colors.border,
                  }}
                >
                  <Text style={{ color: colors.text, fontSize: size === "large" ? 19 : 15 }}>
                    Aa
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        </View>
        <Text style={styles.section}>GENERAL</Text>
        <View style={styles.group}>
          {(
            [
              [
                "reduceMotion",
                "Reduce motion",
                "Simpler transitions and steady thinking text. Your iPhone’s Reduce Motion setting is always respected.",
              ],
              [
                "showThinking",
                "Show thinking details",
                "Show available reasoning while working and in completed replies.",
              ],
              [
                "followReplies",
                "Follow new replies",
                "Follow the latest response when you’re near the bottom of a chat. Scroll up to read earlier messages.",
              ],
            ] as const
          ).map(([key, label, detail]) => (
            <View key={key} style={styles.row}>
              <View style={{ flex: 1 }}>
                <Text style={styles.label}>{label}</Text>
                <Text style={styles.detail}>{detail}</Text>
              </View>
              <Switch
                accessibilityLabel={label}
                value={preferences[key]}
                disabled={!ready}
                thumbColor={colors.text}
                trackColor={{ false: colors.border, true: colors.secondary }}
                onValueChange={(value) => setPreference(key, value)}
              />
            </View>
          ))}
        </View>
        {!!error && (
          <Text accessibilityRole="alert" style={styles.detail}>
            {error}
          </Text>
        )}
        <Text style={styles.section}>YOUR MAC</Text>
        <View style={styles.group}>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="Open Mac connection"
            style={styles.row}
            onPress={() => router.push("/remote")}
          >
            <View>
              <Text style={styles.label}>
                {trustedDesktop ? "Mac connection" : "Connect your Mac"}
              </Text>
              <Text style={styles.detail}>
                {connected
                  ? "Connected"
                  : trustedDesktop
                    ? "Paired · not connected"
                    : "Continue your Mac chats on this phone"}
              </Text>
            </View>
            <Text style={styles.value}>Open</Text>
          </TouchableOpacity>
        </View>
        <Text style={styles.section}>ACCOUNT</Text>
        <View style={styles.group}>
          <TouchableOpacity accessibilityRole="button" style={styles.row} onPress={signOut}>
            <Text style={[styles.label, { color: colors.danger }]}>Sign out</Text>
          </TouchableOpacity>
        </View>
        <Text style={styles.about}>Bimax {Constants.expoConfig?.version ?? ""}</Text>
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
  content: { padding: 20, paddingBottom: 40 },
  section: {
    fontSize: 11,
    letterSpacing: 1,
    fontWeight: "600",
    color: colors.muted,
    marginTop: 24,
    marginBottom: 10,
    paddingHorizontal: 4,
  },
  group: { borderRadius: 14, backgroundColor: colors.surface, overflow: "hidden" },
  row: {
    minHeight: 62,
    padding: 18,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  label: { fontSize: 15, color: colors.text },
  value: { fontSize: 13, color: colors.secondary },
  detail: { lineHeight: 19, fontSize: 12, color: colors.secondary, marginTop: 6 },
  about: { fontSize: 12, color: colors.muted, textAlign: "center", marginTop: 36 },
});
