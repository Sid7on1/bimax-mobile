import React, { useEffect, useRef, useState } from "react";
import { Alert, Linking, Text, TouchableOpacity, View } from "react-native";
import { WebView } from "react-native-webview";
import * as Clipboard from "expo-clipboard";
import {
  artifact,
  externalUrl,
  parseBridge,
  pluginScript,
  operationScript,
  wireState,
} from "../lib/renderer/bridge";
import { colors } from "../lib/theme";
import { usePhonePreferences } from "../lib/preferences-context";
import { RendererRecovery, type RendererFault } from "../lib/renderer/recovery";
import { TranscriptDelivery } from "../lib/renderer/delivery";
import type { TranscriptProps } from "./SharedTranscript.types";
/** One offline, isolated renderer per conversation; no Desktop preload or network authority. */
export function SharedTranscript(props: TranscriptProps) {
  const view = useRef<WebView<Record<never, never>>>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const recovery = useRef(new RendererRecovery()).current;
  const [epoch, setEpoch] = useState(0);
  const recover = (code: RendererFault) => {
    if (epoch !== recovery.generation) return;
    setReady(false);
    delivery.current?.reset();
    loaded.current.clear();
    if (recovery.fail(epoch, code)) setEpoch(recovery.generation);
    else setFailed(true);
  };
  useEffect(() => {
    if (ready || failed) return;
    const timer = setTimeout(() => recover("ready-timeout"), 12_000);
    return () => clearTimeout(timer);
    // One watchdog for this WebView lifetime; it never retries a model request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epoch, ready, failed]);
  const loaded = useRef(new Set<string>());
  const latest = useRef(
    props as TranscriptProps & { preferences?: import("../lib/renderer/bridge").RenderPreferences },
  );
  const { preferences, reduceMotion } = usePhonePreferences();
  latest.current = { ...props, preferences: { ...preferences, reduceMotion } };
  const source = useRef({ html: artifact.html }).current;
  const delivery = useRef<TranscriptDelivery | null>(null);
  useEffect(() => {
    const current = new TranscriptDelivery((operation) =>
      view.current?.injectJavaScript(operationScript(operation)),
    );
    delivery.current = current;
    return () => {
      current.dispose();
      delivery.current = null;
    };
  }, []);
  useEffect(() => {
    if (ready) delivery.current?.push(wireState(latest.current));
  }, [
    props.conversationKey,
    props.messages,
    props.empty,
    props.failedId,
    preferences,
    reduceMotion,
    ready,
  ]);
  const onMessage = async (raw: string) => {
    if (epoch !== recovery.generation) return;
    const message = parseBridge(raw);
    if (!message) return;
    if (message.type === "ready") {
      delivery.current?.reset();
      loaded.current.clear();
      setReady(true);
      delivery.current?.push(wireState(latest.current));
    } else if (
      message.type === "plugin" &&
      typeof message.name === "string" &&
      !loaded.current.has(message.name)
    ) {
      const script = pluginScript(message.name);
      if (script) {
        loaded.current.add(message.name);
        view.current?.injectJavaScript(script);
      }
    } else if (
      message.type === "copy" &&
      Number.isSafeInteger(message.id) &&
      typeof message.text === "string" &&
      message.text.length <= 192 * 1024
    ) {
      let ok = false;
      try {
        await Clipboard.setStringAsync(message.text);
        ok = true;
      } catch {
        /* truthful Copy feedback */
      }
      if (epoch !== recovery.generation) return;
      view.current?.injectJavaScript(
        `window.BimaxTranscript?.copyResult(${message.id},${ok});true;`,
      );
    } else if (message.type === "link") {
      const url = externalUrl(message.url);
      if (url)
        Alert.alert("Open link?", url, [
          { text: "Cancel", style: "cancel" },
          {
            text: "Open",
            onPress: () =>
              void Linking.openURL(url).catch(() => Alert.alert("Could not open link")),
          },
        ]);
    } else if (message.type === "retry") latest.current.onRetry?.();
  };
  if (failed)
    return (
      <View style={{ flex: 1, padding: 24, backgroundColor: colors.background }}>
        <Text style={{ color: colors.text }}>
          The conversation could not be displayed. Your Mac can keep working.
        </Text>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Reload conversation view"
          onPress={() => { delivery.current?.reset(); loaded.current.clear(); setReady(false); setFailed(false); setEpoch(recovery.retry()); }}
          style={{ minHeight: 44, justifyContent: "center" }}>
          <Text style={{ color: colors.text }}>Reload conversation</Text>
        </TouchableOpacity>
      </View>
    );
  return (
    <WebView<Record<never, never>>
      key={epoch}
      ref={view}
      source={source}
      style={{ flex: 1, backgroundColor: colors.background }}
      originWhitelist={["*"]}
      onShouldStartLoadWithRequest={(r) => r.url === "about:blank"}
      onMessage={(e) => void onMessage(e.nativeEvent.data)}
      onOpenWindow={() => {}}
      javaScriptCanOpenWindowsAutomatically={false}
      setSupportMultipleWindows={false}
      allowFileAccess={false}
      allowFileAccessFromFileURLs={false}
      allowUniversalAccessFromFileURLs={false}
      mixedContentMode="never"
      domStorageEnabled={false}
      allowsInlineMediaPlayback={false}
      onContentProcessDidTerminate={() => recover("content-process-ended")}
      onRenderProcessGone={() => {
        recover("render-process-ended");
        return true;
      }}
      onError={() => recover("load-failed")}
    />
  );
}
