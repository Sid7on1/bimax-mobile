import React, { useEffect, useState } from "react";
import { Slot, useRouter, useSegments } from "expo-router";
import { View, ActivityIndicator, StyleSheet } from "react-native";
import { RelayProvider } from "../lib/session/provider";
import { supabase } from "../lib/supabase";

export default function RootLayout() {
  const [initializing, setInitializing] = useState(true);
  const [session, setSession] = useState<unknown>(null);
  const router = useRouter();
  const segments = useSegments();

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setInitializing(false);
    });

    const { data: authListener } = supabase.auth.onAuthStateChange(
      (_event, currentSession) => {
        setSession(currentSession);
        setInitializing(false);
      }
    );

    return () => {
      authListener.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (initializing) return;

    const inLogin = segments[0] === "login";

    if (!session && !inLogin) {
      router.replace("/login");
    } else if (session && inLogin) {
      router.replace("/");
    }
  }, [session, initializing, segments]);

  if (initializing) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#007aff" />
      </View>
    );
  }

  return (
    <RelayProvider>
      <Slot />
    </RelayProvider>
  );
}

const styles = StyleSheet.create({
  loadingContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#ffffff",
  },
});
