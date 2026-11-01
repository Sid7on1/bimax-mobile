import { StatusBar } from "expo-status-bar";
import { colors } from "../lib/theme";
import { removeLegacyDeviceKeys } from "../lib/crypto/secure-store";
import { sealLegacyHistory } from "../lib/chat-store";
import * as ExpoCrypto from "expo-crypto";
import { configureRandomBytes } from "../lib/crypto/keys";
import React, { useEffect, useState } from "react";
import { Slot, useRouter, useSegments } from "expo-router";
import { View, ActivityIndicator, StyleSheet, Appearance } from "react-native";
import { PhonePreferencesProvider } from "../lib/preferences-context";
import { RelayProvider } from "../lib/session/provider";
import type { Session } from "@supabase/supabase-js";
import { setActiveAccount } from "../lib/account-scope";
import { clearApprovals } from "../lib/approvals/approvals";
import { supabase } from "../lib/supabase";

Appearance.setColorScheme("dark");
configureRandomBytes((length) => ExpoCrypto.getRandomBytes(length));

export default function RootLayout() {
  const [initializing, setInitializing] = useState(true);
  const [session, setSession] = useState<Session | null>(null);
  const router = useRouter();
  const segments = useSegments();

  useEffect(() => {
    let active = true,
      receivedAuthEvent = false;
    Promise.all([supabase.auth.getSession(), removeLegacyDeviceKeys(), sealLegacyHistory()])
      .then(([{ data }]) => {
        if (!active || receivedAuthEvent) return;
        setActiveAccount(data.session?.user.id ?? null);
        setSession(data.session);
        setInitializing(false);
      })
      .catch(() => {
        if (active) {
          setActiveAccount(null);
          setSession(null);
          setInitializing(false);
        }
      });

    const { data: authListener } = supabase.auth.onAuthStateChange((_event, currentSession) => {
      if (!active) return;
      receivedAuthEvent = true;
      if (setActiveAccount(currentSession?.user.id ?? null)) clearApprovals();
      setSession(currentSession);
      setInitializing(false);
    });

    return () => {
      active = false;
      authListener.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (initializing) return;

    const inLogin = segments[0] === "login";
    if (segments[0] === "auth-callback") return;

    if (!session && !inLogin) {
      router.replace("/login");
    } else if (session && inLogin) {
      router.replace("/");
    }
  }, [session, initializing, segments, router]);

  if (initializing) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={colors.text} />
      </View>
    );
  }

  // Unmount transport, sessions, and account UI immediately on sign-out.
  if (!session)
    return ["login", "auth-callback"].includes(segments[0]) ? (
      <>
        <StatusBar style="light" />
        <Slot />
      </>
    ) : null;
  return (
    <RelayProvider key={session.user.id}>
      <PhonePreferencesProvider>
        <>
          <StatusBar style="light" />
          <Slot />
        </>
      </PhonePreferencesProvider>
    </RelayProvider>
  );
}

const styles = StyleSheet.create({
  loadingContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: colors.background,
  },
});
