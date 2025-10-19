import { NextRequest, NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";

type ChatRequest = {
  model: string;
  messages: Array<{ role: "user"; content: Array<{ type: "text"; text: string }> }>;
  max_completion_tokens?: number;
};

type ChatResponse = { choices: Array<{ message: { content: string | Array<{ type: "text"; text: string }> } }> };

type TranslateJobEntry = { index: number; start: string; end: string; src: string; dst?: string };
type TranslateJob = {
  createdAt: number;
  targetLanguage: string;
  note?: string;
  entries: TranslateJobEntry[];
  cursor: number;
  completed: boolean;
  total: number;
};

function resolveCompletionsEndpoint(raw: string | undefined): string {
  const trimmed = (raw || "").replace(/\/$/, "");
  if (!trimmed) return "https://ark.cn-beijing.volces.com/api/v3/chat/completions";
  if (trimmed.includes("/api/")) return trimmed;
  if (/ark\.cn-beijing\.volces\.com$/i.test(trimmed)) return `${trimmed}/api/v3/chat/completions`;
  return trimmed;
}

function rebuildSrt(entries: TranslateJobEntry[]): string {
  return entries.map((e) => `${e.index}\n${e.start} --> ${e.end}\n${e.dst ?? e.src}`).join("\n\n");
}

async function translateOne(endpoint: string, apiKey: string, model: string, text: string, targetLanguage: string, note?: string): Promise<string> {
  const payload: ChatRequest = {
    model,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: `注意：只输出翻译后的句子，不需要任何解释。${note ? `\n补充背景：${note}` : ""}\n把下面文本翻译成 ${targetLanguage}：\n${text}` },
        ],
      },
    ],
    max_completion_tokens: 2000,
  };
  const resp = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer ${apiKey}` }, body: JSON.stringify(payload) });
  const raw = await resp.text().catch(() => "");
  if (!resp.ok) throw new Error(`LLM 调用失败: ${resp.status} ${raw}`);
  let data: ChatResponse | null = null;
  try { data = JSON.parse(raw) as ChatResponse; } catch { data = null; }
  const content = data?.choices?.[0]?.message?.content as any;
  if (typeof content === "string") return content.trim();
  const list = Array.isArray(content) ? content : [];
  return list.map((c: any) => (c && c.type === "text" ? String(c.text ?? "") : "")).join("\n").trim();
}

export async function GET(request: NextRequest, context: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await context.params;
  const { env } = getCloudflareContext();
  const jobKey = `translate-jobs/${jobId}.json`;
  const obj = await env.AUDIO_BUCKET.get(jobKey);
  if (!obj || !obj.body) return NextResponse.json({ status: "not_found" }, { status: 404 });
  const job = JSON.parse(await obj.text()) as TranslateJob;

  if (job.completed) {
    return NextResponse.json({ status: "completed", srt: rebuildSrt(job.entries) });
  }

  const endpoint = resolveCompletionsEndpoint(env.LLM_ENDPOINT);
  const model = env.LLM_MODEL;
  const apiKey = env.LLM_API_KEY;
  if (!apiKey) return NextResponse.json({ status: "error", message: "缺少 LLM_API_KEY" }, { status: 500 });

  const concurrency = 30;
  let progressed = 0;
  const tasks: Promise<void>[] = [];
  for (let i = 0; i < concurrency && job.cursor < job.entries.length; i++) {
    const idx = job.cursor++;
    const entry = job.entries[idx];
    tasks.push(
      translateOne(endpoint, apiKey, model, entry.src, job.targetLanguage, job.note)
        .then((t) => { entry.dst = t || entry.src; progressed++; })
        .catch(() => { entry.dst = entry.src; })
    );
  }
  if (tasks.length === 0) {
    job.completed = true;
    await env.AUDIO_BUCKET.put(jobKey, JSON.stringify(job), { httpMetadata: { contentType: "application/json" } });
    return NextResponse.json({ status: "completed", srt: rebuildSrt(job.entries) });
  }
  await Promise.all(tasks);
  if (job.cursor >= job.entries.length) job.completed = true;
  await env.AUDIO_BUCKET.put(jobKey, JSON.stringify(job), { httpMetadata: { contentType: "application/json" } });

  const processed = job.entries.filter((e) => typeof e.dst === 'string' && e.dst.length >= 0).length;
  return NextResponse.json({ status: job.completed ? "completed" : "processing", progressed, completed: job.completed, cursor: job.cursor, processed, total: job.total, ...(job.completed ? { srt: rebuildSrt(job.entries) } : {}) });
}


