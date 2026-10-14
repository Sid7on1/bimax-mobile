// components/Composer.tsx
import React, { useState } from "react";
import {
  View,
  TextInput,
  TouchableOpacity,
  Text,
  StyleSheet,
  ActivityIndicator,
  ScrollView,
} from "react-native";
import { pickDocument, pickImage, type AttachedFile } from "../lib/attachments";

export const AVAILABLE_MODELS = [
  { id: "deepseek-chat", name: "DeepSeek Chat" },
  { id: "qwen-plus", name: "Qwen Plus" },
  { id: "qwen-turbo", name: "Qwen Turbo" },
  { id: "openai/gpt-oss-20b", name: "GPT-OSS 20B (Staging)" },
];

export interface ComposerProps {
  onSend: (text: string, model: string, attachments: AttachedFile[]) => void;
  onStop?: () => void;
  isStreaming?: boolean;
  selectedModel: string;
  onModelChange: (model: string) => void;
}

export function Composer({
  onSend,
  onStop,
  isStreaming,
  selectedModel,
  onModelChange,
}: ComposerProps) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<AttachedFile[]>([]);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [isPicking, setIsPicking] = useState(false);

  const handleSend = () => {
    if (isStreaming) {
      onStop?.();
      return;
    }

    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0) return;

    onSend(trimmed, selectedModel, attachments);
    setText("");
    setAttachments([]);
  };

  const handlePickDoc = async () => {
    setIsPicking(true);
    try {
      const file = await pickDocument();
      if (file) {
        setAttachments((prev) => [...prev, file]);
      }
    } finally {
      setIsPicking(false);
    }
  };

  const handlePickImg = async () => {
    setIsPicking(true);
    try {
      const img = await pickImage();
      if (img) {
        setAttachments((prev) => [...prev, img]);
      }
    } finally {
      setIsPicking(false);
    }
  };

  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  const canSend = text.trim().length > 0 || attachments.length > 0 || isStreaming;
  const currentModelLabel =
    AVAILABLE_MODELS.find((m) => m.id === selectedModel)?.name || selectedModel;

  return (
    <View style={styles.container}>
      {/* Model Picker Banner */}
      <View style={styles.modelBar}>
        <TouchableOpacity
          style={styles.modelSelector}
          onPress={() => setShowModelPicker(!showModelPicker)}
          activeOpacity={0.7}
        >
          <Text style={styles.modelSelectorText}>Model: {currentModelLabel}</Text>
          <Text style={styles.chevron}>{showModelPicker ? "▲" : "▼"}</Text>
        </TouchableOpacity>
      </View>

      {/* Model Selector Dropdown */}
      {showModelPicker && (
        <View style={styles.dropdown}>
          {AVAILABLE_MODELS.map((m) => (
            <TouchableOpacity
              key={m.id}
              style={[
                styles.dropdownItem,
                selectedModel === m.id && styles.dropdownItemActive,
              ]}
              onPress={() => {
                onModelChange(m.id);
                setShowModelPicker(false);
              }}
            >
              <Text
                style={[
                  styles.dropdownText,
                  selectedModel === m.id && styles.dropdownTextActive,
                ]}
              >
                {m.name}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      {/* Attachment Chips */}
      {attachments.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.attachmentScroll}
        >
          {attachments.map((att) => (
            <View key={att.id} style={styles.chip}>
              <Text numberOfLines={1} style={styles.chipText}>
                {att.isImage ? "📷 " : "📄 "}
                {att.name}
              </Text>
              <TouchableOpacity
                onPress={() => removeAttachment(att.id)}
                style={styles.chipRemove}
              >
                <Text style={styles.chipRemoveText}>✕</Text>
              </TouchableOpacity>
            </View>
          ))}
        </ScrollView>
      )}

      {/* Input Row */}
      <View style={styles.inputRow}>
        {/* Attach Document Button */}
        <TouchableOpacity
          onPress={handlePickDoc}
          style={styles.iconButton}
          disabled={isPicking || isStreaming}
        >
          {isPicking ? (
            <ActivityIndicator size="small" color="#007aff" />
          ) : (
            <Text style={styles.iconText}>📎</Text>
          )}
        </TouchableOpacity>

        {/* Attach Image Button */}
        <TouchableOpacity
          onPress={handlePickImg}
          style={styles.iconButton}
          disabled={isPicking || isStreaming}
        >
          <Text style={styles.iconText}>📷</Text>
        </TouchableOpacity>

        {/* Text Input */}
        <TextInput
          style={styles.input}
          placeholder="Message Bimax..."
          placeholderTextColor="#8e8e93"
          value={text}
          onChangeText={setText}
          multiline
          maxLength={10000}
        />

        {/* Send / Stop Button */}
        <TouchableOpacity
          onPress={handleSend}
          disabled={!canSend}
          style={[
            styles.sendButton,
            canSend ? styles.sendButtonActive : styles.sendButtonDisabled,
            isStreaming && styles.stopButton,
          ]}
          activeOpacity={0.8}
        >
          <Text style={styles.sendIcon}>
            {isStreaming ? "⏹" : "↑"}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: "#ffffff",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#c6c6c8",
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 16,
  },
  modelBar: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 6,
  },
  modelSelector: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#f2f2f7",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 14,
  },
  modelSelectorText: {
    fontSize: 12,
    fontWeight: "600",
    color: "#3a3a3c",
    marginRight: 4,
  },
  chevron: {
    fontSize: 10,
    color: "#8e8e93",
  },
  dropdown: {
    backgroundColor: "#f9f9fb",
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#d1d1d6",
    marginBottom: 8,
    overflow: "hidden",
  },
  dropdownItem: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#e5e5ea",
  },
  dropdownItemActive: {
    backgroundColor: "#e5f1ff",
  },
  dropdownText: {
    fontSize: 14,
    color: "#1c1c1e",
  },
  dropdownTextActive: {
    fontWeight: "600",
    color: "#007aff",
  },
  attachmentScroll: {
    flexDirection: "row",
    marginBottom: 8,
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#e5e5ea",
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 12,
    marginRight: 6,
    maxWidth: 160,
  },
  chipText: {
    fontSize: 12,
    color: "#1c1c1e",
    flexShrink: 1,
  },
  chipRemove: {
    marginLeft: 6,
    padding: 2,
  },
  chipRemoveText: {
    fontSize: 11,
    color: "#8e8e93",
    fontWeight: "bold",
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "flex-end",
  },
  iconButton: {
    padding: 8,
    marginRight: 2,
    justifyContent: "center",
    alignItems: "center",
  },
  iconText: {
    fontSize: 18,
  },
  input: {
    flex: 1,
    backgroundColor: "#f2f2f7",
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingTop: 8,
    paddingBottom: 8,
    fontSize: 16,
    maxHeight: 120, // Grows to ~5 lines then scrolls
    color: "#000000",
  },
  sendButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    justifyContent: "center",
    alignItems: "center",
    marginLeft: 8,
  },
  sendButtonActive: {
    backgroundColor: "#007aff",
  },
  sendButtonDisabled: {
    backgroundColor: "#e5e5ea",
  },
  stopButton: {
    backgroundColor: "#ff3b30",
  },
  sendIcon: {
    fontSize: 16,
    color: "#ffffff",
    fontWeight: "700",
  },
});
