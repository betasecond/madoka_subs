import { NextRequest, NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";

function buildV3Headers(env: any, requestId: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "X-Api-App-Key": env.ASR_APP_ID,
    "X-Api-Access-Key": env.ASR_ACCESS_TOKEN,
    "X-Api-Resource-Id": env.ASR_RESOURCE_ID,
    "X-Api-Request-Id": requestId,
    "X-Api-Sequence": "-1",
  };
}

function readStatusCode(headers: Headers): number {
  const raw = headers.get("X-Api-Status-Code") ?? headers.get("x-api-status-code") ?? "";
  const code = Number(raw);
  return Number.isFinite(code) ? code : 0;
}

function msToSrtTime(ms: number): string {
  const totalMs = Math.max(0, Math.floor(ms));
  const hours = Math.floor(totalMs / 3600000).toString().padStart(2, "0");
  const minutes = Math.floor((totalMs % 3600000) / 60000).toString().padStart(2, "0");
  const seconds = Math.floor((totalMs % 60000) / 1000).toString().padStart(2, "0");
  const millis = (totalMs % 1000).toString().padStart(3, "0");
  return `${hours}:${minutes}:${seconds},${millis}`;
}

type V3Utterance = {
  text: string;
  start_time?: number;
  end_time?: number;
  words?: Array<{ text: string; start_time: number; end_time: number }>;
};

function utterancesToSrt(utterances: V3Utterance[]): string {
  const lines: string[] = [];
  utterances.forEach((u, idx) => {
    let start = u.start_time;
    let end = u.end_time;
    if ((start == null || end == null) && u.words && u.words.length > 0) {
      const first = u.words[0];
      const last = u.words[u.words.length - 1];
      start = start ?? first.start_time;
      end = end ?? last.end_time;
    }
    start = start ?? 0;
    end = end ?? start + 2000;
    lines.push(String(idx + 1));
    lines.push(`${msToSrtTime(start)} --> ${msToSrtTime(end)}`);
    lines.push(u.text || "");
    lines.push("");
  });
  return lines.join("\n");
}

const QUERY_ENDPOINT = "query";

type V3QueryResponse = {
  result?: { text?: string; utterances?: V3Utterance[] };
};

export async function GET(_request: NextRequest, { params }: { params: { jobId: string } }) {
  const jobId = params.jobId;
  if (!jobId) {
    return NextResponse.json({ error: "缺少 jobId" }, { status: 400 });
  }

  const { env } = getCloudflareContext();
  if (!env.ASR_APP_ID || !env.ASR_ACCESS_TOKEN || !env.ASR_RESOURCE_ID) {
    return NextResponse.json({ error: "ASR 环境变量缺失" }, { status: 500 });
  }

  const queryUrl = `${env.ASR_BASE_URL.replace(/\/$/, "")}/${QUERY_ENDPOINT}`;
  const resp = await fetch(queryUrl, {
    method: "POST",
    headers: buildV3Headers(env as any, jobId),
    body: JSON.stringify({}),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    return NextResponse.json({ status: "error", message: text || String(resp.status) }, { status: 500 });
  }

  const status = readStatusCode(resp.headers);
  if (status === 20000000) {
    const data = (await resp.json()) as V3QueryResponse;
    const utt = data.result?.utterances ?? [];
    let srt = "";
    if (utt.length > 0) {
      srt = utterancesToSrt(utt);
    } else {
      const text = data.result?.text || "";
      srt = `1\n${msToSrtTime(0)} --> ${msToSrtTime(2000)}\n${text}\n`;
    }
    return NextResponse.json({ status: "completed", srt });
  }

  if (status === 20000001 || status === 20000002) {
    // 处理中/排队
    try { await resp.body?.cancel?.(); } catch {}
    return NextResponse.json({ status: "processing" });
  }

  const msg = resp.headers.get("X-Api-Message") || resp.headers.get("x-api-message") || "";
  try { await resp.body?.cancel?.(); } catch {}
  return NextResponse.json({ status: "failed", message: `${status} ${msg}` }, { status: 500 });
}


