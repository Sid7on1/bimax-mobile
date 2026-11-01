import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import { AccessibilityInfo } from "react-native";
import * as SecureStore from "expo-secure-store";
import { accountStorageKey, requireActiveAccount } from "./account-scope";
import {
  DEFAULT_PREFERENCES,
  PreferenceStore,
  type PhonePreferences,
  type PreferenceSnapshot,
} from "./preferences";
const Context = createContext({
  preferences: DEFAULT_PREFERENCES as PhonePreferences,
  ready: false,
  error: null as string | null,
  reduceMotion: true,
  setPreference: (
    _key: keyof PhonePreferences,
    _value: PhonePreferences[keyof PhonePreferences],
  ): void => {},
});
export const usePhonePreferences = () => useContext(Context);
export function PhonePreferencesProvider({ children }: { children: React.ReactNode }) {
  const key = useRef(accountStorageKey("phone-preferences", requireActiveAccount())).current;
  const [snapshot, setSnapshot] = useState<PreferenceSnapshot>({
    preferences: { ...DEFAULT_PREFERENCES },
    ready: false,
    error: null,
  });
  const [systemMotion, setSystemMotion] = useState(true);
  const store = useRef<PreferenceStore | null>(null);
  useEffect(() => {
    const current = new PreferenceStore(
      {
        read: () => SecureStore.getItemAsync(key),
        write: (raw) =>
          SecureStore.setItemAsync(key, raw, {
            keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
          }),
      },
      setSnapshot,
    );
    store.current = current;
    void current.load();
    return () => {
      current.dispose();
      store.current = null;
    };
  }, [key]);
  useEffect(() => {
    let active = true,
      receivedEvent = false;
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", (enabled) => {
      receivedEvent = true;
      if (active) setSystemMotion(enabled);
    });
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((enabled) => {
        if (active && !receivedEvent) setSystemMotion(enabled);
      })
      .catch(() => {});
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);
  return (
    <Context.Provider
      value={{
        ...snapshot,
        reduceMotion: systemMotion || snapshot.preferences.reduceMotion,
        setPreference: (name, value) => {
          void store.current?.set(name, value);
        },
      }}
    >
      {children}
    </Context.Provider>
  );
}
