export interface PhonePreferences {
  textSize: "comfortable" | "large";
  reduceMotion: boolean;
  showThinking: boolean;
  followReplies: boolean;
}
export const DEFAULT_PREFERENCES: Readonly<PhonePreferences> = Object.freeze({
  textSize: "comfortable",
  reduceMotion: false,
  showThinking: true,
  followReplies: true,
});
export function parsePreferences(raw: string | null): PhonePreferences {
  let value: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(raw ?? "null");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      value = parsed as Record<string, unknown>;
  } catch {
    /* A corrupt optional preference cannot prevent opening chats. */
  }
  return Object.fromEntries(
    Object.entries(DEFAULT_PREFERENCES).map(([key, fallback]) => [
      key,
      key === "textSize"
        ? value[key] === "large"
          ? "large"
          : "comfortable"
        : typeof value[key] === "boolean"
          ? value[key]
          : fallback,
    ]),
  ) as unknown as PhonePreferences;
}
export interface PreferenceSnapshot {
  preferences: PhonePreferences;
  ready: boolean;
  error: string | null;
}
/** One owner per store. Serial writes preserve the last toggle under slow native storage. */
export class PreferenceStore {
  snapshot: PreferenceSnapshot = {
    preferences: { ...DEFAULT_PREFERENCES },
    ready: false,
    error: null,
  };
  private active = true;
  private writes: Promise<void> = Promise.resolve();
  constructor(
    private storage: { read(): Promise<string | null>; write(raw: string): Promise<void> },
    private changed: (snapshot: PreferenceSnapshot) => void,
  ) {}
  private publish(next: PreferenceSnapshot) {
    if (this.active) {
      this.snapshot = next;
      this.changed(next);
    }
  }
  async load() {
    try {
      const raw = await this.storage.read();
      this.publish({ preferences: parsePreferences(raw), ready: true, error: null });
    } catch {
      this.publish({
        ...this.snapshot,
        ready: true,
        error: "Could not load saved settings. Changes apply for this session.",
      });
    }
  }
  set<K extends keyof PhonePreferences>(key: K, value: PhonePreferences[K]): Promise<void> {
    if (
      !this.active ||
      !this.snapshot.ready ||
      (key === "textSize"
        ? !["comfortable", "large"].includes(String(value))
        : typeof value !== "boolean") ||
      !Object.hasOwn(DEFAULT_PREFERENCES, key)
    )
      return Promise.resolve();
    const preferences = { ...this.snapshot.preferences, [key]: value };
    this.publish({ preferences, ready: true, error: this.snapshot.error });
    const write = this.writes.then(async () => {
      if (!this.active) return;
      try {
        await this.storage.write(JSON.stringify(preferences));
        this.publish({ ...this.snapshot, error: null });
      } catch {
        this.publish({
          ...this.snapshot,
          error:
            "Could not save settings. Your changes apply until the app closes. Try changing the setting again.",
        });
      }
    });
    this.writes = write;
    return write;
  }
  dispose() {
    this.active = false;
  }
}
