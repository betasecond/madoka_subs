import { NextRequest, NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";

type SrtEntry = { index: number; start: string; end: string; text: string };
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

  const jobId = (globalThis as any).crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  const jobKey = `translate-jobs/${jobId}.json`;
  const job: TranslateJob = {
    createdAt: Date.now(),
    targetLanguage,
    note: body.note,
    entries: entries.map((e) => ({ index: e.index, start: e.start, end: e.end, src: e.text })),
    cursor: 0,
    completed: false,
    total: entries.length,
  };

  await env.AUDIO_BUCKET.put(jobKey, JSON.stringify(job), {
    httpMetadata: { contentType: "application/json" },
  });

  return NextResponse.json({ jobId }, { status: 200 });
}


