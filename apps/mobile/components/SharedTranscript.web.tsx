import React, { useCallback, useEffect, useMemo, useRef } from "react";
import { Alert, Linking } from "react-native";
import * as Clipboard from "expo-clipboard";
import { artifact, externalUrl, parseBridge, wireState } from "../lib/renderer/bridge";
import { usePhonePreferences } from "../lib/preferences-context";
import { TranscriptDelivery } from "../lib/renderer/delivery";
import type { TranscriptProps } from "./SharedTranscript.types";
/** Browser preview uses the identical offline artifact in an opaque sandbox. */
export function SharedTranscript(props: TranscriptProps) {
  const frame = useRef<HTMLIFrameElement>(null),
    latest = useRef(
      props as TranscriptProps & {
        preferences?: import("../lib/renderer/bridge").RenderPreferences;
      },
    );
  const { preferences, reduceMotion } = usePhonePreferences();
  latest.current = { ...props, preferences: { ...preferences, reduceMotion } };
  const ready = useRef(false),
    loaded = useRef(new Set<string>());
  const send = useCallback(
    (data: unknown) => frame.current?.contentWindow?.postMessage(data, "*"),
    [],
  );
  const delivery = useRef<TranscriptDelivery | null>(null);
  useEffect(() => {
    const current = new TranscriptDelivery(send);
    delivery.current = current;
    return () => {
      current.dispose();
      delivery.current = null;
    };
  }, [send]);
  const update = useCallback(() => delivery.current?.push(wireState(latest.current)), []);

  const html = useMemo(
    () =>
      artifact.html.replace(
        "<script nonce=",
        `<script nonce="${artifact.nonce}">window.ReactNativeWebView={postMessage:function(raw){parent.postMessage(raw,'*')}};addEventListener('message',function(e){if(e.source!==parent)return;var m=e.data;if(m.type==='update')window.BimaxTranscript.update(m.state);if(m.type==='patch')window.BimaxTranscript.patch(m.patch);if(m.type==='copyResult')window.BimaxTranscript.copyResult(m.id,m.ok);if(m.type==='plugin'){var s=document.createElement('style');s.textContent=m.css;document.head.appendChild(s);var j=document.createElement('script');j.nonce='${artifact.nonce}';j.textContent=m.js;document.body.appendChild(j);}});</script><script nonce=`,
      ),
    [],
  );
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow || typeof e.data !== "string") return;
      const m = parseBridge(e.data);
      if (!m) return;
      if (m.type === "ready") {
        delivery.current?.reset();
        loaded.current.clear();
        ready.current = true;
        update();
      }
      if (
        m.type === "plugin" &&
        typeof m.name === "string" &&
        Object.prototype.hasOwnProperty.call(artifact.plugins, m.name) &&
        !loaded.current.has(m.name)
      ) {
        loaded.current.add(m.name);
        send({ type: "plugin", ...artifact.plugins[m.name as keyof typeof artifact.plugins] });
      }
      if (
        m.type === "copy" &&
        Number.isSafeInteger(m.id) &&
        typeof m.text === "string" &&
        m.text.length <= 192 * 1024
      ) {
        void Clipboard.setStringAsync(m.text).then(
          () => send({ type: "copyResult", id: m.id, ok: true }),
          () => send({ type: "copyResult", id: m.id, ok: false }),
        );
      }
      if (m.type === "retry") latest.current.onRetry?.();
      if (m.type === "link") {
        const url = externalUrl(m.url);
        if (url)
          Alert.alert("Open link?", url, [
            { text: "Cancel" },
            { text: "Open", onPress: () => void Linking.openURL(url) },
          ]);
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [send, update]);
  useEffect(() => {
    if (ready.current) update();
  }, [
    props.conversationKey,
    props.messages,
    props.empty,
    props.failedId,
    preferences,
    reduceMotion,
    update,
  ]);
  return (
    <iframe
      ref={frame}
      title="Conversation"
      onLoad={() => {
        // A short offline document can post ready before passive listeners attach.
        ready.current = true;
        delivery.current?.reset();
        loaded.current.clear();
        update();
      }}
      srcDoc={html}
      sandbox="allow-scripts"
      style={{
        flex: 1,
        width: "100%",
        height: "100%",
        border: 0,
        background: artifact.tokens["--color-bg"],
      }}
    />
  );
}
