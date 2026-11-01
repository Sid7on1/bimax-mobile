export interface TranscriptMessage {
  id: string;
  role: string;
  content: string;
  reasoning?: string | null;
  streaming?: boolean;
  status?: string;
}
export interface TranscriptProps {
  conversationKey: string;
  messages: TranscriptMessage[];
  empty?: string;
  failedId?: string;
  onRetry?: () => void;
}
