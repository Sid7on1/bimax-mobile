import React, { useState } from "react";
import {
  View,
  TextInput,
  TouchableOpacity,
  Text,
  StyleSheet,
  ActivityIndicator,
  Alert,
  ScrollView,
} from "react-native";
import { pickDocument, type AttachedFile } from "../lib/attachments";
import { colors } from "../lib/theme";
import { Icon } from "./Icon";
export const AVAILABLE_MODELS = [{ id: "openai/gpt-oss-20b", name: "GPT OSS 20B" }];
export interface ComposerProps {
  allowAttachments?: boolean;
  allowModelChange?: boolean;
  disabled?: boolean;
  onSend: (text: string, model: string, attachments: AttachedFile[]) => void;
  onStop?: () => void;
  isStreaming?: boolean;
  selectedModel: string;
  onModelChange: (model: string) => void;
}
export function Composer({
  onSend,
  allowAttachments = true,
  allowModelChange = true,
  disabled = false,
  onStop,
  isStreaming,
  selectedModel,
  onModelChange,
}: ComposerProps) {
  const [text, setText] = useState("");
  const [inputHeight, setInputHeight] = useState(56);
  const [attachments, setAttachments] = useState<AttachedFile[]>([]);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [isPicking, setIsPicking] = useState(false);
  const label = AVAILABLE_MODELS.find((m) => m.id === selectedModel)?.name ?? selectedModel;
  const canSend = text.trim().length > 0 || attachments.length > 0;
  const send = () => {
    if (isStreaming) {
      onStop?.();
      return;
    }
    if (!canSend || isPicking || disabled) return;
    onSend(text.trim(), selectedModel, attachments);
    setText("");
    setAttachments([]);
  };
  const attach = async () => {
    if (attachments.length >= 4) {
      Alert.alert("Attachment limit", "You can attach up to four text files.");
      return;
    }
    setIsPicking(true);
    try {
      const file = await pickDocument();
      if (file) setAttachments((prev) => (prev.length < 4 ? [...prev, file] : prev));
    } catch (err) {
      Alert.alert("Could not attach file", err instanceof Error ? err.message : "Please retry.");
    } finally {
      setIsPicking(false);
    }
  };
  return (
    <View style={styles.container}>
      {showModelPicker && (
        <View style={styles.models}>
          <Text style={styles.label}>Choose a model</Text>
          {AVAILABLE_MODELS.map((m) => (
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityState={{ selected: m.id === selectedModel }}
              disabled={isStreaming}
              key={m.id}
              style={[styles.modelRow, m.id === selectedModel && styles.active]}
              onPress={() => {
                onModelChange(m.id);
                setShowModelPicker(false);
              }}
            >
              <Text style={styles.modelText}>{m.name}</Text>
              <Text style={styles.secondary}>{m.id === selectedModel ? "Selected" : ""}</Text>
            </TouchableOpacity>
          ))}
          <Text style={styles.note}>Availability depends on your gateway and account.</Text>
        </View>
      )}
      <View style={styles.field}>
        {attachments.length > 0 && (
          <ScrollView horizontal style={styles.attachments}>
            {attachments.map((att) => (
              <View key={att.id} style={styles.chip}>
                <Text numberOfLines={1} style={styles.chipText}>
                  {att.name}
                </Text>
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel={`Remove ${att.name}`}
                  style={styles.remove}
                  disabled={isStreaming}
                  onPress={() => setAttachments((prev) => prev.filter((a) => a.id !== att.id))}
                >
                  <Icon name="close" size={16} />
                </TouchableOpacity>
              </View>
            ))}
          </ScrollView>
        )}
        <TextInput
          accessibilityLabel="Message"
          style={[styles.input, { height: inputHeight }]}
          onContentSizeChange={(event) =>
            setInputHeight(Math.max(56, Math.min(160, event.nativeEvent.contentSize.height)))
          }
          placeholder="Ask anything"
          placeholderTextColor={colors.muted}
          keyboardAppearance="dark"
          multiline
          maxLength={10000}
          value={text}
          onChangeText={setText}
          editable={!isStreaming && !disabled}
        />
        <View style={styles.tools}>
          {allowAttachments && <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="Attach text file"
            style={styles.iconButton}
            onPress={attach}
            disabled={isPicking || isStreaming}
          >
            {isPicking ? <ActivityIndicator color={colors.text} /> : <Icon name="plus" />}
          </TouchableOpacity>}
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={`Model: ${label}`}
            accessibilityState={{ expanded: showModelPicker }}
            style={styles.modelButton}
            disabled={isStreaming || !allowModelChange}
            onPress={() => setShowModelPicker((v) => !v)}
          >
            <Text style={styles.secondary}>{label}</Text>
            {allowModelChange && <Icon name="down" size={16} color={colors.secondary} />}
          </TouchableOpacity>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={isStreaming ? "Stop response" : "Send message"}
            style={[styles.send, !isStreaming && (!canSend || isPicking) && styles.disabled]}
            disabled={!isStreaming && (!canSend || isPicking || disabled)}
            onPress={send}
          >
            <Icon name={isStreaming ? "stop" : "send"} color={colors.buttonText} size={22} />
          </TouchableOpacity>
        </View>
      </View>
      <Text style={styles.note}>Bimax can make mistakes. Check important details.</Text>
    </View>
  );
}
const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.background,
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 6,
  },
  field: { backgroundColor: colors.raised, borderRadius: 26, padding: 8 },
  input: {
    color: colors.text,
    fontSize: 17,
    lineHeight: 24,
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 12,
    minHeight: 56,
    maxHeight: 160,
  },
  tools: { flexDirection: "row", alignItems: "center", gap: 6 },
  iconButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  modelButton: { flexDirection: "row", alignItems: "center", gap: 5, minHeight: 44, flex: 1 },
  send: {
    width: 44,
    height: 44,
    margin: 0,
    borderRadius: 22,
    backgroundColor: colors.button,
    alignItems: "center",
    justifyContent: "center",
  },
  disabled: { opacity: 0.35 },
  secondary: { color: colors.secondary, fontSize: 13 },
  models: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 20,
    padding: 12,
    marginBottom: 8,
  },
  label: { color: colors.secondary, fontSize: 12, padding: 10 },
  modelRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 14,
    borderRadius: 10,
    minHeight: 48,
  },
  active: { backgroundColor: colors.raised },
  modelText: { color: colors.text, fontSize: 15 },
  note: { color: colors.muted, fontSize: 11, textAlign: "center", paddingTop: 9, paddingBottom: 4 },
  attachments: { margin: 6 },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.surface,
    borderRadius: 12,
    paddingLeft: 12,
    marginRight: 6,
  },
  chipText: { color: colors.text, fontSize: 13, maxWidth: 160 },
  remove: { minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" },
});
