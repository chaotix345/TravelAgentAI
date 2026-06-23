import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { CLARIFY_SYSTEM_PROMPT } from "@/lib/prompt";

export const runtime = "nodejs";
export const maxDuration = 30;

// A cheap, fast model is right for this: deciding "do I need to ask one or two questions"
// is a small classification job, not the planning itself. Keeping it off Opus keeps the
// common single-city case snappy and cheap. The planner still runs on Opus.
const CLARIFY_MODEL = "claude-haiku-4-5";
const MAX_BRIEF_CHARS = 4000;

type ClarifyQuestion = { id: "depth" | "constraints"; prompt: string };

const CLARIFY_TOOL: Anthropic.Tool = {
  name: "clarify",
  description:
    "Decide whether to ask the traveler up to two quick questions before planning, and which ones.",
  input_schema: {
    type: "object",
    properties: {
      needsClarification: {
        type: "boolean",
        description:
          "true only if asking would materially change the plan AND the brief hasn't already answered it.",
      },
      questions: {
        type: "array",
        maxItems: 2,
        description: "The questions to ask (omit any that don't apply).",
        items: {
          type: "object",
          properties: {
            id: { type: "string", enum: ["depth", "constraints"] },
            prompt: { type: "string", description: "One short question, tailored to this brief." },
          },
          required: ["id", "prompt"],
        },
      },
    },
    required: ["needsClarification", "questions"],
  } as Anthropic.Tool.InputSchema,
};

// Clarify is best-effort: any failure (bad body, missing key, model error) returns an
// empty question set so the UI proceeds straight to planning. It must never block a plan.
function noQuestions() {
  return NextResponse.json({ questions: [] as ClarifyQuestion[] });
}

export async function POST(req: Request) {
  let brief = "";
  try {
    const body = await req.json();
    brief = typeof body?.brief === "string" ? body.brief.trim() : "";
  } catch {
    return noQuestions();
  }

  if (!brief || brief.length > MAX_BRIEF_CHARS || !process.env.ANTHROPIC_API_KEY) {
    return noQuestions();
  }

  const client = new Anthropic();
  try {
    const message = await client.messages.create({
      model: CLARIFY_MODEL,
      max_tokens: 1024,
      system: CLARIFY_SYSTEM_PROMPT,
      tools: [CLARIFY_TOOL],
      tool_choice: { type: "tool", name: "clarify" },
      messages: [{ role: "user", content: brief }],
    });

    const toolUse = message.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    const input = (toolUse?.input ?? {}) as { needsClarification?: unknown; questions?: unknown };

    // Decisive default: if the model didn't flag a genuine need, ask nothing.
    if (input.needsClarification !== true) return noQuestions();

    const raw = Array.isArray(input.questions) ? input.questions : [];
    const seen = new Set<string>();
    const questions: ClarifyQuestion[] = [];
    for (const q of raw) {
      if (!q || typeof q !== "object") continue;
      const id = (q as { id?: unknown }).id;
      const prompt = (q as { prompt?: unknown }).prompt;
      if (
        (id === "depth" || id === "constraints") &&
        typeof prompt === "string" &&
        prompt.trim() &&
        !seen.has(id)
      ) {
        seen.add(id);
        questions.push({ id, prompt: prompt.trim() });
      }
    }

    return NextResponse.json({ questions });
  } catch (err) {
    console.error("Clarify error:", err);
    return noQuestions();
  }
}
