import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";

function msToSrtTime(ms: number): string {
  const totalMs = Math.max(0, Math.floor(ms));
  const hours = Math.floor(totalMs / 3600000).toString().padStart(2, "0");
  const minutes = Math.floor((totalMs % 3600000) / 60000).toString().padStart(2, "0");
  const seconds = Math.floor((totalMs % 60000) / 1000).toString().padStart(2, "0");
  const millis = (totalMs % 1000).toString().padStart(3, "0");
  return `${hours}:${minutes}:${seconds},${millis}`;
}

type SonioxToken = {
  text: string;
  start_time_ms?: number;
  end_time_ms?: number;
  is_final?: boolean;
};

function tokensToSrt(tokens: SonioxToken[]): string {
  // 合并为大致句子：以 2 秒的空隙或明显停顿作为切分
  const lines: string[] = [];
  let idx = 1;
  let currentStart: number | undefined;
  let currentEnd: number | undefined;
  let currentText: string[] = [];

  const flush = () => {
    if (!currentText.length) return;
    const s = currentStart ?? (currentEnd != null ? Math.max(0, currentEnd - 2000) : 0);
    const e = currentEnd ?? (s + 2000);
    lines.push(String(idx++));
    lines.push(`${msToSrtTime(s)} --> ${msToSrtTime(e)}`);
    lines.push(currentText.join(""));
    lines.push("");
    currentText = [];
    currentStart = undefined;
    currentEnd = undefined;
  };

  for (const t of tokens) {
    const s = t.start_time_ms;
    const e = t.end_time_ms ?? (s != null ? s + 400 : undefined);
    if (currentEnd != null && s != null && s - currentEnd > 2000) {
      flush();
    }
    if (currentStart == null && s != null) currentStart = s;
    if (e != null) currentEnd = e;
    currentText.push(t.text || "");
  }
  flush();
  return lines.join("\n");
}

export async function GET(request: Request, context: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await context.params;
  if (!jobId) {
    return NextResponse.json({ error: "缺少 jobId" }, { status: 400 });
  }

  const { env } = getCloudflareContext();
  if (!env.SONIOX_API_KEY) {
    return NextResponse.json({ error: "缺少 Soniox 环境变量", detail: "需要 SONIOX_API_KEY" }, { status: 500 });
  }

  // 查询状态
  const statusResp = await fetch(`https://api.soniox.com/v1/transcriptions/${encodeURIComponent(jobId)}`, {
    headers: { Authorization: `Bearer ${env.SONIOX_API_KEY}` },
  });
  if (!statusResp.ok) {
    const text = await statusResp.text().catch(() => "");
    return NextResponse.json({ status: "error", message: text || String(statusResp.status) }, { status: 500 });
  }
  const statusData = (await statusResp.json()) as { status?: string; error_message?: string };
  if (statusData.status === "completed") {
    // 优先尝试直接获取 SRT（若 API 支持）——通过 Accept 头或查询参数
    try {
      const srtResp = await fetch(`https://api.soniox.com/v1/transcriptions/${encodeURIComponent(jobId)}/transcript?format=srt`, {
        headers: { Authorization: `Bearer ${env.SONIOX_API_KEY}`, Accept: "text/plain" },
      });
      if (srtResp.ok) {
        const srtText = await srtResp.text();
        if (srtText && /-->/.test(srtText)) {
          return NextResponse.json({ status: "completed", srt: srtText });
        }
      }
    } catch {}

    // 回退：获取 JSON transcript 并转换为 SRT
    const trResp = await fetch(`https://api.soniox.com/v1/transcriptions/${encodeURIComponent(jobId)}/transcript`, {
      headers: { Authorization: `Bearer ${env.SONIOX_API_KEY}` },
    });
    if (!trResp.ok) {
      const text = await trResp.text().catch(() => "");
      return NextResponse.json({ status: "error", message: text || String(trResp.status) }, { status: 500 });
    }
    const trData = (await trResp.json()) as { tokens?: SonioxToken[]; text?: string };
    let srt = "";
    if (trData.tokens && trData.tokens.length > 0) {
      srt = tokensToSrt(trData.tokens);
    } else {
      const text = trData.text || "";
      srt = `1\n${msToSrtTime(0)} --> ${msToSrtTime(2000)}\n${text}\n`;
    }
    return NextResponse.json({ status: "completed", srt });
  }
  if (statusData.status === "error") {
    return NextResponse.json({ status: "failed", message: statusData.error_message || "" }, { status: 500 });
  }

  return NextResponse.json({ status: "processing" });
}


