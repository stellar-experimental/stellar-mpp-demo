import { Challenge, Credential, Receipt, Expires } from "mppx";

export interface ChallengeConfig {
  secretKey: string;
  realm: string;
  serverAddress: string;
  channelFactoryId: string;
  tokenContractId: string;
  deposit: string;
  refundWaitingPeriod: number;
}

/** Create a 402 challenge for the MPP channel payment method. */
export function createChallenge(config: ChallengeConfig) {
  const challenge = Challenge.from({
    secretKey: config.secretKey,
    realm: config.realm,
    method: "stellar",
    intent: "channel",
    request: {
      token: config.tokenContractId,
      recipient: config.serverAddress,
      deposit: config.deposit,
      channelFactory: config.channelFactoryId,
      refundWaitingPeriod: config.refundWaitingPeriod,
    },
    expires: Expires.minutes(5),
  });

  return challenge;
}

/** Build a 402 response with the challenge in WWW-Authenticate header. */
export function paymentRequired(challenge: Challenge.Challenge, detail: string): Response {
  return new Response(JSON.stringify({ type: "payment-required", detail }), {
    status: 402,
    headers: {
      "WWW-Authenticate": Challenge.serialize(challenge),
      "Cache-Control": "no-store",
      "Content-Type": "application/problem+json",
    },
  });
}

/** Parse the credential from an incoming request's Authorization header. */
export function parseCredential(request: Request) {
  return Credential.fromRequest(request);
}

/** Verify the challenge HMAC matches (confirms we issued this challenge). */
export function verifyChallenge(challenge: Challenge.Challenge, secretKey: string): boolean {
  return Challenge.verify(challenge, { secretKey });
}

export interface CredentialPayload {
  action: "open" | "voucher" | "topup" | "close";
  channelId: string;
  commitmentKey?: string;
  txHash?: string;
  voucher?: {
    amount: string;
    signature: string;
  };
}

/** Create a payment receipt and attach it to a response. */
export function withReceipt(response: Response, reference: string): Response {
  const receipt = Receipt.from({
    method: "stellar",
    reference,
    status: "success",
    timestamp: new Date().toISOString(),
  });

  const headers = new Headers(response.headers);
  headers.set("Payment-Receipt", Receipt.serialize(receipt));

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
