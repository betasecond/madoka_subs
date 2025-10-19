import { NextRequest, NextResponse } from "next/server";
// NOTE: 保留 import 但不再进行后端轮询
import pRetry, { AbortError } from "p-retry";

const SUBMIT_ENDPOINT = "submit";
const QUERY_ENDPOINT = "query";

import { getCloudflareContext } from "@opennextjs/cloudflare";

type V3QueryResponse = {
  audio_info?: { duration?: number };
  result?: {
    text?: string;
    utterances?: Array<{
      text: string;
      start_time?: number;
      end_time?: number;
      words?: Array<{
        text: string;
        start_time: number;
        end_time: number;
      }>;
    }>;
  };
};

const CONTENT_TYPE_JSON = { "content-type": "application/json" } as const;

type SignedUrlBucket = CloudflareEnv["AUDIO_BUCKET"] & {
  createSignedUrl: (options: { key: string; expiration?: number }) => Promise<string>;
};

function buildV3Headers(env: CloudflareEnv, requestId: string): Record<string, string> {
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

function maskSecret(secret: string): string {
  if (!secret) return "";
  if (secret.length <= 6) return "***";
  return `${secret.slice(0, 3)}***${secret.slice(-3)}`;
}

function msToSrtTime(ms: number): string {
  const totalMs = Math.max(0, Math.floor(ms));
  const hours = Math.floor(totalMs / 3600000)
    .toString()
    .padStart(2, "0");
  const minutes = Math.floor((totalMs % 3600000) / 60000)
    .toString()
    .padStart(2, "0");
  const seconds = Math.floor((totalMs % 60000) / 1000)
    .toString()
    .padStart(2, "0");
  const millis = (totalMs % 1000).toString().padStart(3, "0");
  return `${hours}:${minutes}:${seconds},${millis}`;
}

function utterancesToSrt(utterances: NonNullable<NonNullable<V3QueryResponse["result"]>["utterances"]>): string {
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
    // Fallback if still missing
    start = start ?? 0;
    end = end ?? start + 2000;

    lines.push(String(idx + 1));
    lines.push(`${msToSrtTime(start)} --> ${msToSrtTime(end)}`);
    lines.push(u.text || "");
    lines.push("");
  });
  return lines.join("\n");
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { key, language } = body as { key?: string; language?: string };

  if (!key) {
    return NextResponse.json({ error: "缺少音频标识" }, { status: 400 });
  }

  const { env } = getCloudflareContext();

  if (!env.ASR_APP_ID || !env.ASR_ACCESS_TOKEN || !env.ASR_RESOURCE_ID) {
    return NextResponse.json(
      { error: "ASR 环境变量缺失", detail: "需要 ASR_APP_ID / ASR_ACCESS_TOKEN / ASR_RESOURCE_ID" },
      { status: 500 }
    );
  }

  const audioObject = await env.AUDIO_BUCKET.get(key);
  if (!audioObject || !audioObject.body) {
    return NextResponse.json({ error: "音频对象不存在" }, { status: 404 });
  }

  // 仅保留：R2 S3 预签名直链（SigV4 GET）
  if (!(env as any).R2_S3_ACCOUNT_ID || !(env as any).R2_S3_BUCKET || !(env as any).R2_S3_ACCESS_KEY_ID || !(env as any).R2_S3_SECRET_ACCESS_KEY) {
    return NextResponse.json(
      { error: "缺少 R2 S3 凭证用于预签名", detail: "请设置 R2_S3_ACCOUNT_ID / R2_S3_BUCKET / R2_S3_ACCESS_KEY_ID / R2_S3_SECRET_ACCESS_KEY" },
      { status: 500 }
    );
  }
  let audioUrl: string;
  try {
    const { AwsClient } = await import('aws4fetch');
    const client = new AwsClient({
      accessKeyId: (env as any).R2_S3_ACCESS_KEY_ID as string,
      secretAccessKey: (env as any).R2_S3_SECRET_ACCESS_KEY as string,
      service: 's3',
      region: 'auto',
    });
    const endpoint = `https://${(env as any).R2_S3_BUCKET}.${(env as any).R2_S3_ACCOUNT_ID}.r2.cloudflarestorage.com/${encodeURIComponent(key)}`;
    const url = new URL(endpoint);
    url.searchParams.set('X-Amz-Expires', String(3600));
    const signed = await client.sign(new Request(url, { method: 'GET' }), { aws: { signQuery: true } });
    audioUrl = signed.url;
  } catch (e) {
    return NextResponse.json(
      { error: "生成 R2 预签名 URL 失败", detail: (e as Error).message },
      { status: 500 }
    );
  }

  // Infer audio format
  const contentType = (audioObject as any).httpMetadata?.contentType as string | undefined;
  const inferAudioFormat = (keyName: string, ct?: string): string => {
    const lowerCt = (ct || "").toLowerCase();
    if (lowerCt.includes("wav")) return "wav";
    if (lowerCt.includes("mp3")) return "mp3";
    if (lowerCt.includes("ogg")) return "ogg";
    const lowerKey = keyName.toLowerCase();
    if (lowerKey.endsWith(".wav")) return "wav";
    if (lowerKey.endsWith(".mp3")) return "mp3";
    if (lowerKey.endsWith(".ogg") || lowerKey.endsWith(".oga")) return "ogg";
    if (lowerKey.endsWith(".m4a") || lowerKey.endsWith(".mp4")) return "mp3";
    return "wav";
  };
  const audioFormat = inferAudioFormat(key, contentType);

  const debugInfo: any = {
    requestId: undefined as string | undefined,
    audioUrl,
    audioFormat,
    submit: undefined as any,
    polls: [] as any[],
  };

  // Build headers and request id
  const requestId = (globalThis as any).crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  debugInfo.requestId = requestId;
  const submitUrl = `${env.ASR_BASE_URL.replace(/\/$/, "")}/${SUBMIT_ENDPOINT}`;
  const submitHeaders = buildV3Headers(env as unknown as CloudflareEnv, requestId);
  const submitPayload = {
    user: {
      uid: "web_client",
    },
    audio: {
      url: audioUrl,
      format: audioFormat,
      ...(language ? { language } : {}),
    },
    request: {
      model_name: "bigmodel",
      ...(env.ASR_MODEL_VERSION ? { model_version: env.ASR_MODEL_VERSION } : {}),
      enable_itn: true,
      enable_punc: true,
      show_utterances: true,
    },
  };

  // Fill debug submit info (sanitized)
  debugInfo.submit = {
    url: submitUrl,
    headers: {
      "X-Api-App-Key": env.ASR_APP_ID,
      "X-Api-Access-Key": maskSecret(env.ASR_ACCESS_TOKEN),
      "X-Api-Resource-Id": env.ASR_RESOURCE_ID,
      "X-Api-Request-Id": requestId,
      "X-Api-Sequence": "-1",
    },
    payload: {
      user: submitPayload.user,
      audio: { url: submitPayload.audio.url, format: submitPayload.audio.format, language: (submitPayload as any).audio?.language },
      request: submitPayload.request,
    },
  };

  const submitResponse = await fetch(submitUrl, {
    method: "POST",
    headers: submitHeaders,
    body: JSON.stringify(submitPayload),
  });

  if (!submitResponse.ok) {
    const errorText = await submitResponse.text();
    return NextResponse.json(
      { error: "ASR 提交失败", detail: errorText },
      { status: submitResponse.status }
    );
  }

  const submitStatus = readStatusCode(submitResponse.headers);
  debugInfo.submit.response = {
    httpStatus: submitResponse.status,
    apiStatus: submitStatus,
    apiMessage: submitResponse.headers.get("X-Api-Message") || submitResponse.headers.get("x-api-message"),
  };
  if (submitStatus !== 20000000) {
    const submitErrText = await submitResponse.text().catch(() => "");
    return NextResponse.json(
      {
        error: "ASR 提交失败",
        detail: {
          statusCode: submitStatus,
          message:
            submitResponse.headers.get("X-Api-Message") || submitResponse.headers.get("x-api-message"),
          body: submitErrText,
        },
        debug: debugInfo,
      },
      { status: 400 }
    );
  }
  // 成功提交也要消费/取消响应体，避免 Cloudflare stalled 警告
  try { await submitResponse.body?.cancel?.(); } catch {}

  // 不再后端轮询，直接返回 jobId 供前端查询新端点 /api/asr/[jobId]
  const jobId = requestId;
  return NextResponse.json({ jobId, debug: debugInfo }, { status: 200 });
}

