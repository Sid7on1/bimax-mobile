import { colors } from "../lib/theme";
import { useEffect } from "react";
import { Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { exchangeLoginCode } from "../lib/auth-flow";
import { supabase } from "../lib/supabase";

export default function AuthCallback() {
  const { code } = useLocalSearchParams<{ code?: string }>();
  const router = useRouter();
  useEffect(() => {
    let active = true;
    void (async () => {
      await exchangeLoginCode(code, async (value) => {
        const { data, error } = await supabase.auth.exchangeCodeForSession(value);
        return { session: data.session, error };
      });
      if (active) router.replace("/");
    })().catch(() => {
      if (active) router.replace("/login");
    });
    return () => {
      active = false;
    };
  }, [code, router]);
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: colors.background,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text style={{ color: colors.text }}>Completing sign-in…</Text>
    </View>
  );
}
