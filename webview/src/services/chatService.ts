import { onPush, request } from './host';

type ChatResponse = {
  command: 'chat.response';
  requestId: string;
  sessionId: string;
  text: string;
};

type ChatToken = {
  command: 'chat.token';
  sessionId: string;
  text: string;
};

export async function sendChatPrompt(sessionId: string, text: string): Promise<string> {
  const res = await request<ChatResponse>({ command: 'chat.send', sessionId, text });
  return res.text;
}

export function subscribeToChatTokens(
  sessionId: string,
  onToken: (text: string) => void
): () => void {
  return onPush<ChatToken>('chat.token', (msg) => {
    if (msg.sessionId === sessionId) {
      onToken(msg.text);
    }
  });
}
