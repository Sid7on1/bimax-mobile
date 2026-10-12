import { Slot } from "expo-router";
import { RelayProvider } from "../lib/session/provider";

export default function RootLayout() {
  return (
    <RelayProvider>
      <Slot />
    </RelayProvider>
  );
}
