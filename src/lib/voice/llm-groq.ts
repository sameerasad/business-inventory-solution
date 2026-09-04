/**
 * The OpenAI-compatible transport, for a free model.
 *
 * This exists because it was measured, not assumed. Against the real catalog,
 * openai/gpt-oss-120b on Groq's free tier resolved shop and product names
 * spoken in Urdu script onto the right ids, and - the part that actually
 * matters - abstained on every genuinely ambiguous sentence rather than picking
 * a plausible row. "general store" came back as null with a warning naming all
 * three shops it could have been; "aam ki bottle" came back as null because
 * that flavour has five packagings. Zero silently-wrong answers.
 *
 * That last property is the whole reason a free model is acceptable here. A
 * wrong id is the one mistake the validation layer cannot catch, because a real
 * id belonging to the wrong shop passes every check and then saves.
 *
 * Anthropic stays available and preferred when its key is present. Only the
 * transport differs between the two - the schema, the prompt, and every id
 * check are shared, so the guarantees do not depend on which one answered.
 */

/**
 * How much room the model gets to think and then answer.
 *
 * Charged against the free tier whether it is used or not, so it rations how
 * many commands fit in a day - but a model cut off mid-thought returns nothing
 * at all, which is worse than a smaller daily allowance.
 *
 * So the budget is adaptive rather than sized for the worst case: most
 * commands get this, and only one that actually runs out is retried with
 * double. Measured on the real catalog, gpt-oss-120b spends 480-590 completion
 * tokens on a command; a sentence in Urdu script through the smaller fallback
 * model needs more than 1600, and paying for that on every command would cut
 * the day's allowance by a third for the sake of the rare hard one.
 */
const MAX_ANSWER_TOKENS = 1600;

export type LlmConfig = {
  baseUrl: string;
  model: string;
  /** Tried when the first model has no quota left. Empty to disable. */
  fallbackModel: string;
  apiKey: string;
};

/**
 * Groq by default, because the app already holds a Groq key for Whisper and
 * the same key works here. Any OpenAI-compatible endpoint can be substituted
 * without touching code - including a model running on this machine.
 */
export function groqLlmConfig(): LlmConfig {
  const baseUrl = (process.env.LLM_BASE_URL ?? "https://api.groq.com/openai/v1").trim();
  const model = (process.env.LLM_MODEL ?? "openai/gpt-oss-120b").trim();
  // A second model, because the free tier's quotas are counted PER MODEL.
  // Measured: with gpt-oss-120b's daily allowance spent, a full-size request
  // to another model answered in under a second, so this is not a longer wait
  // dressed up - it is a second day's worth of commands.
  //
  // The same family, chosen by measurement rather than by size. qwen3.8-27b
  // was the first pick because it matched gpt-oss on an earlier, flatter
  // schema; against the real one it returns a booking with lines null while
  // explaining the product it identified in a warning, which loses the order
  // entirely. gpt-oss-20b fills the nested shape the way its larger sibling
  // does, which is the whole reason to prefer a relative.
  const fallbackModel = (process.env.LLM_MODEL_FALLBACK ?? "openai/gpt-oss-20b").trim();
  const apiKey = (
    process.env.LLM_API_KEY ??
    process.env.GROQ_API_KEY ??
    process.env.STT_API_KEY ??
    ""
  ).trim();
  return { baseUrl: baseUrl.replace(/\/+$/, ""), model, fallbackModel, apiKey };
}

export function groqLlmConfigured(): boolean {
  return groqLlmConfig().apiKey.length > 0;
}

export type TransportResult =
  { ok: true; input: unknown; model: string } | { ok: false; reason: string };

/** Strip a key out of anything we are about to log or show. */
function scrub(text: string): string {
  return text.replace(/\b(gsk|sk)_[A-Za-z0-9]{8,}/g, "$1_***");
}

/**
 * Ask an OpenAI-compatible endpoint for one tool call.
 *
 * The two system messages mirror the Anthropic call's two blocks: the
 * instructions, then the catalog. There is no prompt caching here - Groq does
 * not bill for it on the free tier - so they are simply concatenated.
 */
export async function askOpenAiCompatible(args: {
  system: string;
  context: string;
  transcript: string;
  toolName: string;
  schema: object;
  signal?: AbortSignal;
  /** Internal: set on the single retry after a rate limit. */
  isRetry?: boolean;
  /** Internal: overrides the configured model, for the fallback attempt. */
  model?: string;
  /** Internal: set once the fallback model has been tried. */
  usedFallback?: boolean;
  /** Internal: raised on the retry after the model ran out of room. */
  maxTokens?: number;
}): Promise<TransportResult> {
  const { baseUrl, model: configured, fallbackModel, apiKey } = groqLlmConfig();
  const model = args.model ?? configured;
  const budget = args.maxTokens ?? MAX_ANSWER_TOKENS;
  if (!apiKey) return { ok: false, reason: "No LLM API key is configured." };

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      // A retry gets the same deadline as the first attempt by design: the
      // person is waiting on one sentence, not on two sequential budgets.
      signal: args.signal,
      // Do not sit on a socket between commands. The gaps here are long
      // enough that a pooled connection is more likely to be dead than warm.
      keepalive: false,
      body: JSON.stringify({
        model,
        // Measured, not guessed, and it is a real trade-off in both
        // directions.
        //
        // Too small and the model gets cut off mid-thought: an early version
        // capped this at 300, the reply never arrived, and it looked exactly
        // like a refusal to answer - which led to the wrong conclusion about
        // whether the model could do the job at all.
        //
        // Too large and it rations how many commands a minute the free tier
        // will accept, because max_tokens is charged against the
        // tokens-per-minute limit whether or not the model uses it. A 429 came
        // back reporting "Requested 2937" for a request whose real usage was
        // 274 tokens - the budget was almost the entire cost.
        //
        // A typical extraction here measured 114 completion tokens, so this
        // leaves several times the headroom a hard sentence needs while
        // roughly tripling how many commands fit in a minute.
        max_tokens: budget,
        // Deliberately NOT reasoning_effort:"low". It halves the thinking
        // tokens and breaks Urdu numbers: on the same sentence, "bees aam"
        // came back as quantity 2 instead of 20. Cheaper and quietly wrong is
        // the worst outcome available here.
        // Zero, because the same sentence should not become a different order
        // on a second attempt.
        temperature: 0,
        messages: [
          { role: "system", content: `${args.system}\n\n${args.context}` },
          {
            role: "user",
            content: `Transcript: ${args.transcript}\n\nCall ${args.toolName} once.`,
          },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: args.toolName,
              description: "Record what the speaker asked for.",
              parameters: args.schema,
            },
          },
        ],
        tool_choice: "auto",
      }),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "unknown";

    // AbortSignal.timeout aborts with a TimeoutError, not an AbortError -
    // which is why an earlier version reported every network fault as "could
    // not reach" and hid what had actually gone wrong.
    if (name === "TimeoutError") return { ok: false, reason: "The language model took too long." };
    if (name === "AbortError") return { ok: false, reason: "The request was cancelled." };

    // Log it. The one thing worse than a network error is a network error that
    // tells you nothing: four calls in a row failed with "could not reach" and
    // the message alone made it impossible to say whether the fault was DNS,
    // a dropped socket, or the endpoint being wrong.
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    const cause = error instanceof Error && error.cause ? ` (${String(error.cause)})` : "";
    console.error("llm (openai-compatible) could not reach the endpoint -", scrub(detail + cause));

    // One retry, on a fresh connection. HTTP keep-alive is the likely culprit
    // when a call fails after a quiet gap: the far side closes an idle socket,
    // and the next request over it dies before it is even sent. That is the
    // normal rhythm of this feature - a command, half a minute of silence,
    // another command - so the first attempt failing must not lose the
    // sentence someone just spoke.
    if (!args.isRetry) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      return askOpenAiCompatible({ ...args, model, isRetry: true });
    }
    return { ok: false, reason: "Could not reach the language model." };
  }

  const body = await response.text();
  if (!response.ok) {
    // Reading the body matters: an earlier version discarded it and every
    // failure reported only its status code, which said nothing about whether
    // the key, the model name, or the schema was at fault.
    let detail = "";
    try {
      const parsed = JSON.parse(body) as { error?: { message?: string } };
      detail = parsed.error?.message ?? "";
    } catch {
      detail = body.slice(0, 200);
    }
    console.error("llm (openai-compatible) failed", response.status, scrub(detail));
    if (response.status === 401) return { ok: false, reason: "The LLM API key was rejected." };
    if (response.status === 429) {
      // The free tier's limit is per minute and the wait it asks for is
      // usually about a second, so waiting is far better than abandoning the
      // sentence to the rule parser. Once only: a second 429 means the minute
      // is genuinely full, and someone is standing there holding a microphone.
      const askedFor = Number(response.headers.get("retry-after")) * 1000;
      const wait = Number.isFinite(askedFor) && askedFor > 0 ? Math.min(askedFor, 3000) : 1500;
      if (!args.isRetry) {
        await new Promise((resolve) => setTimeout(resolve, wait));
        return askOpenAiCompatible({ ...args, model, isRetry: true });
      }
      // Still refused, so this model has nothing left for now. The quotas are
      // per model, so another one is a fresh allowance rather than a longer
      // wait - and waiting is not on offer when someone is holding a
      // microphone.
      if (fallbackModel && fallbackModel !== model && !args.usedFallback) {
        return askOpenAiCompatible({
          ...args,
          model: fallbackModel,
          isRetry: false,
          usedFallback: true,
        });
      }
      return { ok: false, reason: "Rate limited - the free tier is busy, try again shortly." };
    }
    return { ok: false, reason: `The language model returned an error (${response.status}).` };
  }

  let parsed: {
    choices?: {
      finish_reason?: string;
      message?: { tool_calls?: { function?: { arguments?: string } }[] };
    }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, reason: "The language model returned an unreadable response." };
  }

  const raw = parsed.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
  if (typeof raw !== "string") {
    // Say WHY. A reasoning model that runs out of budget mid-thought returns
    // no tool call at all, which is indistinguishable from declining to answer
    // unless the finish reason is reported - and the two have opposite fixes:
    // raise the budget, or change the sentence.
    const finish = parsed.choices?.[0]?.finish_reason ?? "unknown";
    const used = parsed.usage?.completion_tokens ?? "?";
    console.error(
      "llm (" +
        model +
        ") returned no tool call - finish_reason=" +
        finish +
        ", completion=" +
        used +
        " of " +
        budget,
    );
    if (finish === "length") {
      // Once, with room to finish. A longer sentence or a smaller model needs
      // more thinking than the common case, and it is cheaper to pay for that
      // only when it happens than on every command.
      if (budget < MAX_ANSWER_TOKENS * 2) {
        return askOpenAiCompatible({ ...args, model, maxTokens: MAX_ANSWER_TOKENS * 2 });
      }
      return { ok: false, reason: "The model ran out of room before answering." };
    }
    return { ok: false, reason: "The model did not return a command." };
  }

  try {
    return { ok: true, input: JSON.parse(raw), model };
  } catch {
    return { ok: false, reason: "The model returned arguments that were not valid JSON." };
  }
}
