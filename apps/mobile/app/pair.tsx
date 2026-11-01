import { pairingProgress } from "../lib/session/pairing-progress";
import { colors } from "../lib/theme";
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
import { formatVerificationCode, type EstablishedSession } from "../lib/session";
import { useRelayContext } from "../lib/session/provider";

type PairingStep =
  "idle" | "scanning" | "manual" | "confirming" | "pairing" | "verifying" | "done" | "error";

export default function PairScreen() {
  const router = useRouter();
  const { pairWithDesktop, refreshTrustedDesktop, dropSession, status } = useRelayContext();
  const progress = pairingProgress(status);
  const [step, setStep] = useState<PairingStep>("idle");
  const [advert, setAdvert] = useState<PairingAdvertisement | null>(null);
  const [manualText, setManualText] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [scanInlineError, setScanInlineError] = useState("");
  const [session, setSession] = useState<EstablishedSession | null>(null);

  const [permission, requestPermission] = useCameraPermissions();
  const isScanningActiveRef = useRef(false);
  const pairingPeerRef = useRef<string | null>(null);
  const completedRef = useRef(false);
  const dropRef = useRef(dropSession);
  dropRef.current = dropSession;
  useEffect(
    () => () => {
      if (!completedRef.current && pairingPeerRef.current) dropRef.current(pairingPeerRef.current);
    },
    [],
  );

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
      setScanInlineError(err instanceof Error ? err.message : "Invalid QR code advertisement");
    }
  };

  const handleManualSubmit = () => {
    try {
      const parsed = parseAdvertisement(manualText);
      setAdvert(parsed);
      setErrorMessage("");
      setStep("confirming");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Invalid pairing advertisement JSON");
    }
  };

  const startPairingFlow = async () => {
    if (!advert) return;
    pairingPeerRef.current = advert.desktopDeviceId;
    completedRef.current = false;
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
          onPress={() => {
            if (advert) dropSession(advert.desktopDeviceId);
            pairingPeerRef.current = null;
            router.back();
          }}
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
            <Text style={styles.title}>Connect your Mac</Text>
            <Text style={styles.description}>
              On your Mac, open Bimax Settings → Phone connection and enable pairing.
            </Text>

            <Text style={styles.description}>
              Keep both devices on the same Wi-Fi. Scan the QR code, then confirm the matching code
              on both screens.
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
              <Text style={styles.secondaryButtonText}>Paste pairing details</Text>
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
                <TouchableOpacity style={styles.primaryButton} onPress={requestPermission}>
                  <Text style={styles.primaryButtonText}>Grant Permission</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.secondaryButton} onPress={() => setStep("manual")}>
                  <Text style={styles.secondaryButtonText}>Enter code manually instead</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <View style={styles.cameraContainer}>
                <CameraView
                  style={StyleSheet.absoluteFill}
                  barcodeScannerSettings={{
                    barcodeTypes: ["qr"],
                  }}
                  onBarcodeScanned={({ data }) => handleQrScanned(data)}
                />
                <View style={styles.overlay}>
                  <View style={styles.scanTarget} />
                  {scanInlineError ? (
                    <Text style={styles.scanInlineError}>{scanInlineError}</Text>
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
                    <Text style={styles.scanManualLinkText}>Paste pairing details</Text>
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
              keyboardAppearance="dark"
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
            {errorMessage ? <Text style={styles.errorText}>{errorMessage}</Text> : null}
            <TouchableOpacity style={styles.primaryButton} onPress={handleManualSubmit}>
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

              <Text style={[styles.cardLabel, { marginTop: 12 }]}>Relay URL:</Text>
              <Text style={styles.cardValue}>{advert.relayUrl}</Text>
            </View>

            <TouchableOpacity style={styles.primaryButton} onPress={startPairingFlow}>
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
            <ActivityIndicator size="large" color={colors.text} />
            <Text style={[styles.title, { marginTop: 24 }]}>{progress.title}</Text>
            <Text style={styles.description}>{progress.description}</Text>
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
                      cryptoVersion: advert.cryptoVersion,
                      nextPqPrekey: session.nextPqPrekey,
                    });
                  } catch (err) {
                    // Never report success without a saved record.
                    setErrorMessage(
                      err instanceof Error ? err.message : "Could not save trusted desktop",
                    );
                    setStep("error");
                    return;
                  }
                  try {
                    await refreshTrustedDesktop(session);
                  } catch (error) {
                    setErrorMessage(
                      error instanceof Error
                        ? error.message
                        : "Trust was saved but the secure connection could not be activated. Reopen the app.",
                    );
                    setStep("error");
                    return;
                  }
                }
                completedRef.current = true;
                setStep("done");
                router.back();
              }}
            >
              <Text style={styles.primaryButtonText}>Codes match — Done</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.dangerButton}
              onPress={() => {
                // Tear down the session: this peer was never verified.
                if (advert) {
                  dropSession(advert.desktopDeviceId);
                }
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
            <Text style={styles.description}>Your device is paired and end-to-end encrypted.</Text>
            <TouchableOpacity style={styles.primaryButton} onPress={() => router.back()}>
              <Text style={styles.primaryButtonText}>Done</Text>
            </TouchableOpacity>
          </View>
        )}

        {step === "error" && (
          <View style={styles.stepContainer}>
            <Text style={[styles.title, { color: colors.danger }]}>Pairing Error</Text>
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
    backgroundColor: colors.background,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  backButton: {
    paddingVertical: 6,
    paddingHorizontal: 8,
  },
  backButtonText: {
    fontSize: 16,
    color: colors.text,
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: "600",
    color: colors.text,
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
    color: colors.text,
    textAlign: "center",
    marginBottom: 8,
  },
  description: {
    fontSize: 15,
    color: colors.secondary,
    textAlign: "center",
    marginBottom: 24,
    lineHeight: 22,
  },
  primaryButton: {
    backgroundColor: colors.button,
    width: "100%",
    paddingVertical: 14,
    borderRadius: 18,
    alignItems: "center",
    marginBottom: 12,
  },
  primaryButtonText: {
    color: colors.buttonText,
    fontSize: 16,
    fontWeight: "600",
  },
  secondaryButton: {
    backgroundColor: colors.surface,
    width: "100%",
    paddingVertical: 14,
    borderRadius: 18,
    alignItems: "center",
    marginBottom: 12,
  },
  secondaryButtonText: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "600",
  },
  dangerButton: {
    backgroundColor: colors.dangerSurface,
    width: "100%",
    paddingVertical: 14,
    borderRadius: 18,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#fca5a5",
  },
  dangerButtonText: {
    color: colors.danger,
    fontSize: 16,
    fontWeight: "600",
  },
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 18,
    padding: 16,
    width: "100%",
    marginBottom: 24,
  },
  cardLabel: {
    fontSize: 13,
    color: colors.secondary,
    fontWeight: "500",
  },
  cardValue: {
    fontSize: 15,
    color: colors.text,
    fontWeight: "600",
    marginTop: 2,
  },
  textArea: {
    width: "100%",
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 18,
    padding: 12,
    fontSize: 14,
    color: colors.text,
    marginBottom: 16,
    minHeight: 120,
    textAlignVertical: "top",
  },
  errorText: {
    color: colors.danger,
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
    ...StyleSheet.absoluteFill,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "rgba(0, 0, 0, 0.4)",
    padding: 24,
  },
  scanTarget: {
    width: 220,
    height: 220,
    borderWidth: 2,
    borderColor: colors.text,
    borderRadius: 16,
    backgroundColor: "transparent",
    marginBottom: 24,
  },
  overlayText: {
    color: colors.text,
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
    color: colors.secondary,
    fontSize: 15,
    fontWeight: "500",
  },
  codeContainer: {
    backgroundColor: colors.surface,
    paddingVertical: 18,
    paddingHorizontal: 24,
    borderRadius: 10,
    marginBottom: 24,
    borderWidth: 1,
    borderColor: colors.border,
  },
  verificationCode: {
    fontSize: 22,
    fontWeight: "700",
    letterSpacing: 2,
    color: colors.text,
    fontFamily: "monospace",
  },
});
