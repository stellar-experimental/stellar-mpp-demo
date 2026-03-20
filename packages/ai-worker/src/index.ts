import { Hono } from "hono";

const SYSTEM_PROMPT =
  "You are a helpful, knowledgeable assistant. Answer questions clearly and thoroughly. Provide useful detail and examples where appropriate.";
const MAX_TOKENS = 512;

const app = new Hono<{ Bindings: Env }>();

app.post("/generate", async (c) => {
  const { messages, max_tokens } = await c.req.json<{
    messages: Array<{ role: string; content: string }>;
    max_tokens?: number;
  }>();

  const clampedTokens = Math.min(max_tokens ?? MAX_TOKENS, MAX_TOKENS);

  const stream = await c.env.AI.run("@cf/meta/llama-3.2-3b-instruct", {
    messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
    stream: true,
    max_tokens: clampedTokens,
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    },
  });
});

export default app;
