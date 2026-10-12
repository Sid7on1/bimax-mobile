import { useState, useEffect, useRef } from "react";
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  SafeAreaView,
  ScrollView,
} from "react-native";
import { useRouter } from "expo-router";
import { CameraView, useCameraPermissions } from "expo-camera";
import type { PairingAdvertisement } from "@bimax/protocol";
import { parseAdvertisement, saveTrustedDesktop } from "../lib/crypto";
import {
  formatVerificationCode,
  type EstablishedSession,
} from "../lib/session";
import { useRelayContext } from "../lib/session/provider";

type PairingStep =
  | "idle"
  | "scanning"
  | "manual"
  | "confirming"
  | "pairing"
  | "verifying"
  | "done"
  | "error";

export default function PairScreen() {
  const router = useRouter();
  const { pairWithDesktop } = useRelayContext();
  const [step, setStep] = useState<PairingStep>("idle");
  const [advert, setAdvert] = useState<PairingAdvertisement | null>(null);
  const [manualText, setManualText] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [scanInlineError, setScanInlineError] = useState("");
  const [session, setSession] = useState<EstablishedSession | null>(null);

  const [permission, requestPermission] = useCameraPermissions();
  const isScanningActiveRef = useRef(false);

  // Request camera permissions if entering scanning step
  useEffect(() => {
    if (step === "scanning" && !permission?.granted) {
      requestPermission();
    }
  }, [step, permission, requestPermission]);

  const handleQrScanned = (data: string) => {
    if (!isScanningActiveRef.current) return;
    try {
      const parsed = parseAdvertisement(data);
      isScanningActiveRef.current = false;
      setAdvert(parsed);
      setScanInlineError("");
      setStep("confirming");
    } catch (err) {
      setScanInlineError(
        err instanceof Error ? err.message : "Invalid QR code advertisement",
      );
    }
  };

  const handleManualSubmit = () => {
    try {
      const parsed = parseAdvertisement(manualText);
      setAdvert(parsed);
      setErrorMessage("");
      setStep("confirming");
    } catch (err) {
      setErrorMessage(
        err instanceof Error
          ? err.message
          : "Invalid pairing advertisement JSON",
      );
    }
  };

  const startPairingFlow = async () => {
    if (!advert) return;
    setStep("pairing");
    setErrorMessage("");
    try {
      const established = await pairWithDesktop(advert);
      setSession(established);
      setStep("verifying");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Pairing failed");
      setStep("error");
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backButton}
        >
          <Text style={styles.backButtonText}>Cancel</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Pair Device</Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {step === "idle" && (
          <View style={styles.stepContainer}>
            <Text style={styles.title}>Pair with Bimax Desktop</Text>
            <Text style={styles.description}>
              Scan the QR code shown on your desktop screen to establish a
              secure, end-to-end encrypted companion channel.
            </Text>

            <TouchableOpacity
              style={styles.primaryButton}
              onPress={() => {
                isScanningActiveRef.current = true;
                setScanInlineError("");
                setStep("scanning");
              }}
            >
              <Text style={styles.primaryButtonText}>Scan desktop QR</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.secondaryButton}
              onPress={() => {
                setErrorMessage("");
                setStep("manual");
              }}
            >
              <Text style={styles.secondaryButtonText}>Enter code manually</Text>
            </TouchableOpacity>
          </View>
        )}

        {step === "scanning" && (
          <View style={styles.scannerWrapper}>
            {!permission?.granted ? (
              <View style={styles.stepContainer}>
                <Text style={styles.title}>Camera Permission Required</Text>
                <Text style={styles.description}>
                  Camera access is needed to scan the desktop pairing QR code.
                </Text>
                <TouchableOpacity
                  style={styles.primaryButton}
                  onPress={requestPermission}
                >
                  <Text style={styles.primaryButtonText}>Grant Permission</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.secondaryButton}
                  onPress={() => setStep("manual")}
                >
                  <Text style={styles.secondaryButtonText}>
                    Enter code manually instead
                  </Text>
                </TouchableOpacity>
              </View>
            ) : (
              <View style={styles.cameraContainer}>
                <CameraView
                  style={StyleSheet.absoluteFillObject}
                  barcodeScannerSettings={{
                    barcodeTypes: ["qr"],
                  }}
                  onBarcodeScanned={({ data }) => handleQrScanned(data)}
                />
                <View style={styles.overlay}>
                  <View style={styles.scanTarget} />
                  {scanInlineError ? (
                    <Text style={styles.scanInlineError}>
                      {scanInlineError}
                    </Text>
                  ) : (
                    <Text style={styles.overlayText}>
                      Point your camera at the QR code on your desktop
                    </Text>
                  )}
                  <TouchableOpacity
                    style={styles.scanManualLink}
                    onPress={() => {
                      isScanningActiveRef.current = false;
                      setStep("manual");
                    }}
                  >
                    <Text style={styles.scanManualLinkText}>
                      Enter code manually
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}
          </View>
        )}

        {step === "manual" && (
          <View style={styles.stepContainer}>
            <Text style={styles.title}>Enter Advertisement JSON</Text>
            <Text style={styles.description}>
              Paste the pairing advertisement data from your desktop:
            </Text>
            <TextInput
              style={styles.textArea}
              multiline
              numberOfLines={6}
              value={manualText}
              onChangeText={setManualText}
              placeholder='{"relayUrl":"...","ref":"...","desktopDeviceId":"...","desktopPublicKey":"...","app":"bimax"}'
              placeholderTextColor="#9ca3af"
              autoCapitalize="none"
              autoCorrect={false}
            />
            {errorMessage ? (
              <Text style={styles.errorText}>{errorMessage}</Text>
            ) : null}
            <TouchableOpacity
              style={styles.primaryButton}
              onPress={handleManualSubmit}
            >
              <Text style={styles.primaryButtonText}>Continue</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.secondaryButton}
              onPress={() => {
                isScanningActiveRef.current = true;
                setStep("scanning");
              }}
            >
              <Text style={styles.secondaryButtonText}>Back to Scanner</Text>
            </TouchableOpacity>
          </View>
        )}

        {step === "confirming" && advert && (
          <View style={styles.stepContainer}>
            <Text style={styles.title}>Confirm Desktop Device</Text>
            <View style={styles.card}>
              <Text style={styles.cardLabel}>Desktop Device ID:</Text>
              <Text style={styles.cardValue}>{advert.desktopDeviceId}</Text>

              <Text style={[styles.cardLabel, { marginTop: 12 }]}>
                Relay URL:
              </Text>
              <Text style={styles.cardValue}>{advert.relayUrl}</Text>
            </View>

            <TouchableOpacity
              style={styles.primaryButton}
              onPress={startPairingFlow}
            >
              <Text style={styles.primaryButtonText}>Pair with this device</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.secondaryButton}
              onPress={() => {
                setAdvert(null);
                isScanningActiveRef.current = true;
                setStep("scanning");
              }}
            >
              <Text style={styles.secondaryButtonText}>Rescan</Text>
            </TouchableOpacity>
          </View>
        )}

        {step === "pairing" && (
          <View style={styles.stepContainer}>
            <ActivityIndicator size="large" color="#2563eb" />
            <Text style={[styles.title, { marginTop: 24 }]}>
              Waiting for desktop approval…
            </Text>
            <Text style={styles.description}>
              Please confirm the pairing request on your Bimax desktop app.
            </Text>
          </View>
        )}

        {step === "verifying" && session && (
          <View style={styles.stepContainer}>
            <Text style={styles.title}>Safety Verification</Text>
            <Text style={styles.description}>
              Compare this code with the one displayed on your desktop screen:
            </Text>

            <View style={styles.codeContainer}>
              <Text style={styles.verificationCode}>
                {formatVerificationCode(session.handshakeHash)}
              </Text>
            </View>

            <TouchableOpacity
              style={styles.primaryButton}
              onPress={async () => {
                if (advert) {
                  try {
                    await saveTrustedDesktop({
                      deviceId: advert.desktopDeviceId,
                      staticPublicKeyB64: advert.desktopPublicKey,
                      relayUrl: advert.relayUrl,
                      lanRelayUrl: advert.lanRelayUrl,
                    });
                  } catch {
                    // ignore
                  }
                }
                setStep("done");
                router.back();
              }}
            >
              <Text style={styles.primaryButtonText}>Codes match — Done</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.dangerButton}
              onPress={() => {
                setErrorMessage(
                  "Verification code mismatch! The connection may be intercepted. Please rescan.",
                );
                setStep("error");
              }}
            >
              <Text style={styles.dangerButtonText}>{"Doesn't match"}</Text>
            </TouchableOpacity>
          </View>
        )}

        {step === "done" && (
          <View style={styles.stepContainer}>
            <Text style={styles.title}>Pairing Complete!</Text>
            <Text style={styles.description}>
              Your device is paired and end-to-end encrypted.
            </Text>
            <TouchableOpacity
              style={styles.primaryButton}
              onPress={() => router.back()}
            >
              <Text style={styles.primaryButtonText}>Done</Text>
            </TouchableOpacity>
          </View>
        )}

        {step === "error" && (
          <View style={styles.stepContainer}>
            <Text style={[styles.title, { color: "#dc2626" }]}>
              Pairing Error
            </Text>
            <Text style={styles.description}>{errorMessage}</Text>
            <TouchableOpacity
              style={styles.primaryButton}
              onPress={() => {
                setErrorMessage("");
                setStep("idle");
              }}
            >
              <Text style={styles.primaryButtonText}>Retry</Text>
            </TouchableOpacity>
          </View>
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
    flexGrow: 1,
    padding: 20,
    justifyContent: "center",
  },
  stepContainer: {
    alignItems: "center",
    width: "100%",
  },
  title: {
    fontSize: 22,
    fontWeight: "700",
    color: "#111827",
    textAlign: "center",
    marginBottom: 8,
  },
  description: {
    fontSize: 15,
    color: "#4b5563",
    textAlign: "center",
    marginBottom: 24,
    lineHeight: 22,
  },
  primaryButton: {
    backgroundColor: "#111827",
    width: "100%",
    paddingVertical: 14,
    borderRadius: 8,
    alignItems: "center",
    marginBottom: 12,
  },
  primaryButtonText: {
    color: "#ffffff",
    fontSize: 16,
    fontWeight: "600",
  },
  secondaryButton: {
    backgroundColor: "#f3f4f6",
    width: "100%",
    paddingVertical: 14,
    borderRadius: 8,
    alignItems: "center",
    marginBottom: 12,
  },
  secondaryButtonText: {
    color: "#111827",
    fontSize: 16,
    fontWeight: "600",
  },
  dangerButton: {
    backgroundColor: "#fef2f2",
    width: "100%",
    paddingVertical: 14,
    borderRadius: 8,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#fca5a5",
  },
  dangerButtonText: {
    color: "#dc2626",
    fontSize: 16,
    fontWeight: "600",
  },
  card: {
    backgroundColor: "#f9fafb",
    borderWidth: 1,
    borderColor: "#e5e7eb",
    borderRadius: 8,
    padding: 16,
    width: "100%",
    marginBottom: 24,
  },
  cardLabel: {
    fontSize: 13,
    color: "#6b7280",
    fontWeight: "500",
  },
  cardValue: {
    fontSize: 15,
    color: "#111827",
    fontWeight: "600",
    marginTop: 2,
  },
  textArea: {
    width: "100%",
    backgroundColor: "#f9fafb",
    borderWidth: 1,
    borderColor: "#d1d5db",
    borderRadius: 8,
    padding: 12,
    fontSize: 14,
    color: "#111827",
    marginBottom: 16,
    minHeight: 120,
    textAlignVertical: "top",
  },
  errorText: {
    color: "#dc2626",
    fontSize: 14,
    marginBottom: 16,
    textAlign: "center",
  },
  scannerWrapper: {
    flex: 1,
    minHeight: 400,
    borderRadius: 12,
    overflow: "hidden",
  },
  cameraContainer: {
    flex: 1,
    minHeight: 400,
    position: "relative",
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "rgba(0, 0, 0, 0.4)",
    padding: 24,
  },
  scanTarget: {
    width: 220,
    height: 220,
    borderWidth: 2,
    borderColor: "#ffffff",
    borderRadius: 16,
    backgroundColor: "transparent",
    marginBottom: 24,
  },
  overlayText: {
    color: "#ffffff",
    fontSize: 14,
    textAlign: "center",
    marginBottom: 16,
  },
  scanInlineError: {
    color: "#fca5a5",
    fontSize: 14,
    textAlign: "center",
    marginBottom: 16,
    backgroundColor: "rgba(0, 0, 0, 0.6)",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
  },
  scanManualLink: {
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  scanManualLinkText: {
    color: "#60a5fa",
    fontSize: 15,
    fontWeight: "500",
  },
  codeContainer: {
    backgroundColor: "#f3f4f6",
    paddingVertical: 18,
    paddingHorizontal: 24,
    borderRadius: 10,
    marginBottom: 24,
    borderWidth: 1,
    borderColor: "#e5e7eb",
  },
  verificationCode: {
    fontSize: 22,
    fontWeight: "700",
    letterSpacing: 2,
    color: "#111827",
    fontFamily: "monospace",
  },
});
