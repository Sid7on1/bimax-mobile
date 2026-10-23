import { useEffect } from "react";
import { Text } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { supabase } from "../lib/supabase";

export default function AuthCallback() {
  const { code } = useLocalSearchParams<{ code?: string }>();
  const router = useRouter();
  useEffect(() => {
    let active = true;
    void (async () => {
      if (typeof code === "string" && code.length <= 4096)
        await supabase.auth.exchangeCodeForSession(code);
      if (active) router.replace("/");
    })().catch(() => {
      if (active) router.replace("/login");
    });
    return () => {
      active = false;
    };
  }, [code, router]);
  return <Text>Completing sign-in…</Text>;
}
