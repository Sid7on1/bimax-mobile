import { colors } from "../lib/theme";
// app/login.tsx
import React, { useState, useEffect } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from "react-native";
import { useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { isRunningInExpoGo } from "expo";
import { authServiceHealth, signInWithBrowser, type AuthHealth } from "../lib/auth-flow";
import { supabase } from "../lib/supabase";

WebBrowser.maybeCompleteAuthSession();

export default function LoginScreen() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [otpCode, setOtpCode] = useState("");
  const [isOtpSent, setIsOtpSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [health, setHealth] = useState<AuthHealth>();
  const [healthAttempt, setHealthAttempt] = useState(0);
  const expoGo = isRunningInExpoGo();
  const serviceUrl = process.env.EXPO_PUBLIC_SUPABASE_URL ?? "";
  const publicKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? "";
  const canSignIn = health?.ok === true && !loading;

  useEffect(() => {
    let active = true;
    setHealth(undefined);
    void authServiceHealth(serviceUrl, publicKey).then((result) => {
      if (active) setHealth(result);
    });
    return () => {
      active = false;
    };
  }, [serviceUrl, publicKey, healthAttempt]);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) {
        router.replace("/");
      }
    });

    const { data: authListener } = supabase.auth.onAuthStateChange((event, session) => {
      if (session) {
        router.replace("/");
      }
    });

    return () => {
      authListener.subscription.unsubscribe();
    };
  }, [router]);

  const handleOAuthSignIn = async (provider: "google" | "github") => {
    setLoading(true);
    try {
      await signInWithBrowser({
        expoGo,
        redirect: process.env.EXPO_PUBLIC_AUTH_REDIRECT_URL,
        serviceUrl,
        health: () => authServiceHealth(serviceUrl, publicKey),
        authorize: async (redirectTo) => {
          const { data, error } = await supabase.auth.signInWithOAuth({
            provider,
            options: { redirectTo, skipBrowserRedirect: true },
          });
          return { url: data.url, error };
        },
        open: WebBrowser.openAuthSessionAsync,
        exchange: async (code) => {
          const { data, error } = await supabase.auth.exchangeCodeForSession(code);
          return { session: data.session, error };
        },
      });
    } catch (err: any) {
      Alert.alert("Sign In Failed", err.message || String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleSendOtp = async () => {
    if (!email.trim()) {
      Alert.alert("Invalid Email", "Please enter a valid email address.");
      return;
    }

    setLoading(true);
    try {
      const currentHealth = await authServiceHealth(serviceUrl, publicKey);
      setHealth(currentHealth);
      if (!currentHealth.ok) throw new Error(currentHealth.message);
      const { error } = await supabase.auth.signInWithOtp({
        email: email.trim(),
      });
      if (error) throw error;
      setIsOtpSent(true);
      Alert.alert("Verification Code Sent", `We've sent a 6-digit code to ${email}.`);
    } catch (err: any) {
      Alert.alert("Failed to send code", err.message || String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyOtp = async () => {
    if (otpCode.trim().length !== 6) {
      Alert.alert("Invalid Code", "Please enter the 6-digit verification code.");
      return;
    }

    setLoading(true);
    try {
      const { error } = await supabase.auth.verifyOtp({
        email: email.trim(),
        token: otpCode.trim(),
        type: "email",
      });
      if (error) throw error;
      router.replace("/");
    } catch (err: any) {
      Alert.alert("Verification Failed", err.message || String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      style={styles.container}
    >
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.brandBox}>
          <Text style={styles.logo}>Bimax</Text>
          <Text style={styles.tagline}>Think, write, and build with Bimax.</Text>
        </View>

        {health === undefined ? (
          <Text style={styles.otpNotice} accessibilityRole="status">
            Checking sign-in availability…
          </Text>
        ) : !health.ok ? (
          <View style={styles.emailBox}>
            <Text style={styles.otpNotice} accessibilityRole="alert">
              {health.message}
            </Text>
            <TouchableOpacity
              style={styles.oauthButton}
              disabled={loading}
              onPress={() => setHealthAttempt((attempt) => attempt + 1)}
            >
              <Text style={styles.oauthText}>Try sign-in service again</Text>
            </TouchableOpacity>
          </View>
        ) : null}
        {/* OAuth is available only with the installed app's verified return link. */}
        {!expoGo && process.env.EXPO_PUBLIC_AUTH_REDIRECT_URL && (
          <View style={styles.oauthContainer}>
            <TouchableOpacity
              style={styles.oauthButton}
              onPress={() => handleOAuthSignIn("google")}
              disabled={!canSignIn}
              activeOpacity={0.8}
            >
              <Text style={styles.oauthText}>Continue with Google</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.oauthButton, styles.githubButton]}
              onPress={() => handleOAuthSignIn("github")}
              disabled={!canSignIn}
              activeOpacity={0.8}
            >
              <Text style={styles.githubText}>Continue with GitHub</Text>
            </TouchableOpacity>
          </View>
        )}
        <View style={styles.dividerRow}>
          <View style={styles.dividerLine} />
          <Text style={styles.dividerText}>
            {expoGo ? "Sign in with email" : "or continue with email"}
          </Text>
          <View style={styles.dividerLine} />
        </View>

        {/* Email + OTP Section */}
        {!isOtpSent ? (
          <View style={styles.emailBox}>
            <TextInput
              keyboardAppearance="dark"
              style={styles.input}
              placeholder="Enter your email"
              placeholderTextColor={colors.muted}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              value={email}
              onChangeText={setEmail}
            />
            <TouchableOpacity
              style={[
                styles.primaryButton,
                (!canSignIn || !email.trim()) && styles.primaryButtonDisabled,
              ]}
              onPress={handleSendOtp}
              disabled={!canSignIn || !email.trim()}
              activeOpacity={0.8}
            >
              {loading ? (
                <ActivityIndicator color={colors.text} />
              ) : (
                <Text
                  style={[
                    styles.primaryButtonText,
                    (!canSignIn || !email.trim()) && styles.disabledButtonText,
                  ]}
                >
                  Send Login Code
                </Text>
              )}
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.otpBox}>
            <Text style={styles.otpNotice}>
              Enter the 6-digit code sent to{"\n"}
              <Text style={{ fontWeight: "700" }}>{email}</Text>
            </Text>

            <TextInput
              keyboardAppearance="dark"
              style={[styles.input, styles.otpInput]}
              placeholder="000000"
              placeholderTextColor={colors.muted}
              keyboardType="number-pad"
              maxLength={6}
              value={otpCode}
              onChangeText={setOtpCode}
            />

            <TouchableOpacity
              style={[
                styles.primaryButton,
                (!canSignIn || otpCode.trim().length !== 6) && styles.primaryButtonDisabled,
              ]}
              onPress={handleVerifyOtp}
              disabled={!canSignIn || otpCode.trim().length !== 6}
              activeOpacity={0.8}
            >
              {loading ? (
                <ActivityIndicator color={colors.text} />
              ) : (
                <Text
                  style={[
                    styles.primaryButtonText,
                    (!canSignIn || otpCode.trim().length !== 6) && styles.disabledButtonText,
                  ]}
                >
                  Verify &amp; Sign In
                </Text>
              )}
            </TouchableOpacity>

            <TouchableOpacity onPress={() => setIsOtpSent(false)} style={styles.backButton}>
              <Text style={styles.backButtonText}>Use a different email</Text>
            </TouchableOpacity>
          </View>
        )}
        {expoGo && (
          <Text style={styles.runtimeNote}>
            Google and GitHub sign-in require a Bimax development build.
          </Text>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  scroll: {
    flexGrow: 1,
    justifyContent: "center",
    paddingHorizontal: 24,
    paddingVertical: 40,
  },
  brandBox: {
    alignItems: "center",
    marginBottom: 40,
  },
  logo: {
    fontSize: 34,
    fontWeight: "800",
    color: colors.text,
    letterSpacing: -0.5,
  },
  tagline: {
    fontSize: 16,
    color: colors.secondary,
    marginTop: 6,
  },
  oauthContainer: {
    gap: 12,
  },
  oauthButton: {
    backgroundColor: colors.surface,
    paddingVertical: 14,
    borderRadius: 14,
    alignItems: "center",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  oauthText: {
    fontSize: 16,
    fontWeight: "600",
    color: colors.text,
  },
  githubButton: {
    backgroundColor: "#24292e",
    borderColor: "#24292e",
  },
  githubText: {
    fontSize: 16,
    fontWeight: "600",
    color: colors.text,
  },
  dividerRow: {
    flexDirection: "row",
    alignItems: "center",
    marginVertical: 28,
  },
  dividerLine: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
  },
  dividerText: {
    marginHorizontal: 12,
    fontSize: 13,
    color: colors.muted,
    fontWeight: "500",
  },
  emailBox: {
    gap: 12,
  },
  otpBox: {
    gap: 14,
  },
  otpNotice: {
    fontSize: 15,
    color: colors.secondary,
    textAlign: "center",
    lineHeight: 22,
  },
  input: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 16,
    color: colors.text,
  },
  otpInput: {
    textAlign: "center",
    fontSize: 24,
    letterSpacing: 8,
    fontWeight: "700",
  },
  primaryButton: {
    backgroundColor: colors.button,
    paddingVertical: 15,
    borderRadius: 14,
    alignItems: "center",
  },
  primaryButtonDisabled: {
    backgroundColor: colors.raised,
  },
  disabledButtonText: { color: colors.muted },
  primaryButtonText: {
    fontSize: 16,
    fontWeight: "600",
    color: colors.buttonText,
  },
  runtimeNote: {
    color: colors.muted,
    fontSize: 12,
    lineHeight: 18,
    textAlign: "center",
    marginTop: 24,
  },
  backButton: {
    alignItems: "center",
    marginTop: 8,
  },
  backButtonText: {
    fontSize: 14,
    color: colors.text,
  },
});
