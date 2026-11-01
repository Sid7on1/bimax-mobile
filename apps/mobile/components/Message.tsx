import React from "react";
import { SharedTranscript } from "./SharedTranscript";
import type { TranscriptMessage } from "./SharedTranscript.types";
export interface MessageProps extends TranscriptMessage { isStreaming?: boolean; isFailed?: boolean; onRetry?: () => void; timestamp?: number }
/** Compatibility surface; chat screens render one SharedTranscript for the whole conversation. */
export const Message = React.memo(function Message(props: MessageProps) {
  return <SharedTranscript conversationKey={props.id} messages={[{...props, streaming:props.isStreaming}]} failedId={props.isFailed ? props.id : undefined} onRetry={props.onRetry} />;
});
