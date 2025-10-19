import { NextRequest, NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";

type ChatRequest = {
  model: string;
  messages: Array<{
    role: "user";
    content: Array<{ type: "text"; text: string }>;
  }>;
  max_completion_tokens?: number;
};

type ChatResponse = {
  choices: Array<{
    message: { content: string | Array<{ type: "text"; text: string }> };
  }>;
};

type SrtEntry = {
  index: number;
  start: string;
  end: string;
  text: string;
};

function resolveCompletionsEndpoint(raw: string | undefined): string {
  const trimmed = (raw || "").replace(/\/$/, "");
  if (!trimmed) return "https://ark.cn-beijing.volces.com/api/v3/chat/completions";
  if (trimmed.includes("/api/")) return trimmed;
  if (/ark\.cn-beijing\.volces\.com$/i.test(trimmed)) {
    return `${trimmed}/api/v3/chat/completions`;
  }
  return trimmed;
}

function parseSrt(input: string): SrtEntry[] {
  const blocks = input.replace(/\r\n/g, "\n").split(/\n\s*\n/);
  const entries: SrtEntry[] = [];
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length < 2) continue;
    const maybeIndex = Number(lines[0].trim());
    const timeLine = lines[1];
    const m = timeLine.match(/^(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})/);
    if (!Number.isFinite(maybeIndex) || !m) continue;
    const start = m[1];
    const end = m[2];
    const text = lines.slice(2).join("\n");
    entries.push({ index: maybeIndex, start, end, text });
  }
  return entries;
}

function rebuildSrt(entries: SrtEntry[]): string {
  return entries
    .map((e) => `${e.index}\n${e.start} --> ${e.end}\n${e.text}`)
    .join("\n\n");
}

async function translateChunk({
  endpoint,
  apiKey,
  model,
  text,
  targetLanguage,
  note,
}: {
  endpoint: string;
  apiKey: string;
  model: string;
  text: string;
  targetLanguage: string;
  note?: string;
}): Promise<string> {
  const payload: ChatRequest = {
    model,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `注意：只输出翻译后的句子，不需要任何解释。${note ? `\n补充背景：${note}` : ""}\n把下面文本翻译成 ${targetLanguage}：\n${text}`,
          },
        ],
      },
    ],
    max_completion_tokens: 4000,
  };

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`LLM 调用失败: ${response.status} ${errorText}`);
  }

  const data = (await response.json()) as ChatResponse;
  const content = data.choices?.[0]?.message?.content as unknown;
  if (typeof content === "string") {
    return content.trim();
  }
  const list = Array.isArray(content) ? content : [];
  return list
    .map((c: any) => (c && c.type === "text" ? String(c.text ?? "") : ""))
    .join("\n")
    .trim();
}

export async function POST(request: NextRequest) {
  const { env } = getCloudflareContext();
  const body = (await request.json()) as { srt?: string; targetLanguage?: string; note?: string };
  if (!body.srt) {
    return NextResponse.json({ error: "缺少 SRT 内容" }, { status: 400 });
  }

  const targetLanguage = body.targetLanguage ?? "zh-CN";
  const entries = parseSrt(body.srt);
  if (entries.length === 0) {
    return NextResponse.json({ error: "SRT 解析失败或为空" }, { status: 400 });
  }
  console.log(`[translate] Parsed ${entries.length} SRT entries.`);

  const endpoint = resolveCompletionsEndpoint(env.LLM_ENDPOINT);
  const model = env.LLM_MODEL;
  const apiKey = env.LLM_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "缺少 LLM_API_KEY" }, { status: 500 });
  }

  const concurrency = 100;
  const translatedEntries: SrtEntry[] = new Array(entries.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const myIndex = cursor++;
      if (myIndex >= entries.length) break;
      const entry = entries[myIndex];
      console.log(`[translate] Processing entry: ${myIndex}`);
      const translatedText = await translateChunk({
        endpoint,
        apiKey,
        model,
        text: entry.text,
        targetLanguage,
        note: body.note,
      }).catch((e: unknown) => {
        console.error(`[translate] Error translating entry ${myIndex}: `, e);
        // 出错时回退原文，避免整体失败
        return entry.text;
      });
      translatedEntries[myIndex] = { ...entry, text: translatedText || entry.text };
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, () => worker()));

  const mergedSrt = rebuildSrt(translatedEntries);
  return NextResponse.json({ srt: mergedSrt }, { status: 200 });
}

