import { Challenge, Credential } from "mppx";
import { CONFIG } from "./config.js";

export interface ChannelSession {
  channelId: string;
  commitmentKeyHex: string;
  cumulativeAmount: bigint;
  deposit: bigint;
  challenge: Challenge.Challenge | null;
  openedAt: number;
  expiresAt: number;
}

/** Send a chat message to the MPP server. Returns a ReadableStream for SSE. */
export async function sendChat(
  message: string,
  session: ChannelSession,
  payload: Record<string, unknown>,
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (session.challenge && payload) {
    const credential = Credential.from({
      challenge: session.challenge,
      payload,
    });
    headers["Authorization"] = Credential.serialize(credential);
  }

  return fetch(`${CONFIG.mppServerUrl}/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify({ message }),
  });
}

/** Parse the 402 challenge from a response. */
export function parseChallenge(response: Response): Challenge.Challenge {
  return Challenge.fromResponse(response);
}

/** Build a voucher credential payload. */
export function buildVoucherPayload(channelId: string, amount: string, signatureHex: string) {
  return {
    action: "voucher" as const,
    channelId,
    voucher: { amount, signature: signatureHex },
  };
}

/** Build an open credential payload. */
export function buildOpenPayload(channelId: string, commitmentKeyHex: string) {
  return {
    action: "open" as const,
    channelId,
    commitmentKey: commitmentKeyHex,
  };
}

/** Build a topup credential payload. */
export function buildTopupPayload(channelId: string, txHash: string) {
  return {
    action: "topup" as const,
    channelId,
    txHash,
  };
}

/** Build a close credential payload. */
export function buildClosePayload(
  channelId: string,
  voucher?: { amount: string; signature: string },
) {
  return {
    action: "close" as const,
    channelId,
    voucher,
  };
}

export type StreamEvent =
  | { type: "token"; text: string }
  | {
      type: "usage";
      usage: { completion_tokens: number; cost: string; cumulative_amount: string };
    };

/** Parse SSE stream and yield typed events (tokens + usage). */
export async function* streamTokens(response: Response): AsyncGenerator<StreamEvent> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop()!;

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const data = line.slice(6).trim();
        if (data === "[DONE]") continue;
        try {
          const parsed = JSON.parse(data);
          if (parsed.usage) {
            yield { type: "usage", usage: parsed.usage };
          } else if (parsed.response) {
            yield { type: "token", text: parsed.response };
          }
        } catch {
          // skip malformed lines
        }
      }
    }
  }
}
