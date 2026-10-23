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
import { makeRedirectUri } from "expo-auth-session";
import { supabase } from "../lib/supabase";

WebBrowser.maybeCompleteAuthSession();

export default function LoginScreen() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [otpCode, setOtpCode] = useState("");
  const [isOtpSent, setIsOtpSent] = useState(false);
  const [loading, setLoading] = useState(false);

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
      const configuredRedirect = process.env.EXPO_PUBLIC_AUTH_REDIRECT_URL;
      if (!configuredRedirect && !__DEV__) throw new Error("Use email sign-in for this build");
      const redirectUri = configuredRedirect || makeRedirectUri({ scheme: "bimax" });

      const { data, error } = await supabase.auth.signInWithOAuth({
        provider,
        options: {
          redirectTo: redirectUri,
          skipBrowserRedirect: true,
        },
      });

      if (error) throw error;
      if (data?.url) {
        const result = await WebBrowser.openAuthSessionAsync(data.url, redirectUri);
        if (result.type === "success" && result.url) {
          const url = new URL(result.url);
          const expected = new URL(redirectUri);
          if (
            url.origin !== expected.origin ||
            url.pathname !== expected.pathname ||
            url.protocol !== expected.protocol
          )
            throw new Error("Unexpected sign-in callback");
          // PKCE flow: code in query string, must be exchanged for a session
          const code = url.searchParams.get("code");
          if (code) {
            const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
            if (exchangeError) throw exchangeError;
          } else {
            throw new Error("Sign-in did not return an authorization code. Please try again.");
          }
        }
      }
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
          <Text style={styles.logo}>✦ Bimax</Text>
          <Text style={styles.tagline}>Intelligent standalone mobile chat</Text>
        </View>

        {/* OAuth Buttons */}
        {(__DEV__ || process.env.EXPO_PUBLIC_AUTH_REDIRECT_URL) && (
          <View style={styles.oauthContainer}>
            <TouchableOpacity
              style={styles.oauthButton}
              onPress={() => handleOAuthSignIn("google")}
              disabled={loading}
              activeOpacity={0.8}
            >
              <Text style={styles.oauthText}>Continue with Google</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.oauthButton, styles.githubButton]}
              onPress={() => handleOAuthSignIn("github")}
              disabled={loading}
              activeOpacity={0.8}
            >
              <Text style={styles.githubText}>Continue with GitHub</Text>
            </TouchableOpacity>
          </View>
        )}
        <View style={styles.dividerRow}>
          <View style={styles.dividerLine} />
          <Text style={styles.dividerText}>or continue with email</Text>
          <View style={styles.dividerLine} />
        </View>

        {/* Email + OTP Section */}
        {!isOtpSent ? (
          <View style={styles.emailBox}>
            <TextInput
              style={styles.input}
              placeholder="Enter your email"
              placeholderTextColor="#8e8e93"
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              value={email}
              onChangeText={setEmail}
            />
            <TouchableOpacity
              style={[styles.primaryButton, !email.trim() && styles.primaryButtonDisabled]}
              onPress={handleSendOtp}
              disabled={loading || !email.trim()}
              activeOpacity={0.8}
            >
              {loading ? (
                <ActivityIndicator color="#ffffff" />
              ) : (
                <Text style={styles.primaryButtonText}>Send Login Code</Text>
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
              style={[styles.input, styles.otpInput]}
              placeholder="000000"
              placeholderTextColor="#8e8e93"
              keyboardType="number-pad"
              maxLength={6}
              value={otpCode}
              onChangeText={setOtpCode}
            />

            <TouchableOpacity
              style={[
                styles.primaryButton,
                otpCode.trim().length !== 6 && styles.primaryButtonDisabled,
              ]}
              onPress={handleVerifyOtp}
              disabled={loading || otpCode.trim().length !== 6}
              activeOpacity={0.8}
            >
              {loading ? (
                <ActivityIndicator color="#ffffff" />
              ) : (
                <Text style={styles.primaryButtonText}>Verify & Sign In</Text>
              )}
            </TouchableOpacity>

            <TouchableOpacity onPress={() => setIsOtpSent(false)} style={styles.backButton}>
              <Text style={styles.backButtonText}>Use a different email</Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#ffffff",
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
    color: "#000000",
    letterSpacing: -0.5,
  },
  tagline: {
    fontSize: 16,
    color: "#636366",
    marginTop: 6,
  },
  oauthContainer: {
    gap: 12,
  },
  oauthButton: {
    backgroundColor: "#f2f2f7",
    paddingVertical: 14,
    borderRadius: 14,
    alignItems: "center",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#d1d1d6",
  },
  oauthText: {
    fontSize: 16,
    fontWeight: "600",
    color: "#000000",
  },
  githubButton: {
    backgroundColor: "#24292e",
    borderColor: "#24292e",
  },
  githubText: {
    fontSize: 16,
    fontWeight: "600",
    color: "#ffffff",
  },
  dividerRow: {
    flexDirection: "row",
    alignItems: "center",
    marginVertical: 28,
  },
  dividerLine: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    backgroundColor: "#c6c6c8",
  },
  dividerText: {
    marginHorizontal: 12,
    fontSize: 13,
    color: "#8e8e93",
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
    color: "#3a3a3c",
    textAlign: "center",
    lineHeight: 22,
  },
  input: {
    backgroundColor: "#f2f2f7",
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 16,
    color: "#000000",
  },
  otpInput: {
    textAlign: "center",
    fontSize: 24,
    letterSpacing: 8,
    fontWeight: "700",
  },
  primaryButton: {
    backgroundColor: "#007aff",
    paddingVertical: 15,
    borderRadius: 14,
    alignItems: "center",
  },
  primaryButtonDisabled: {
    backgroundColor: "#b0b0b8",
  },
  primaryButtonText: {
    fontSize: 16,
    fontWeight: "600",
    color: "#ffffff",
  },
  backButton: {
    alignItems: "center",
    marginTop: 8,
  },
  backButtonText: {
    fontSize: 14,
    color: "#007aff",
  },
});
