import { NextRequest, NextResponse } from "next/server";
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

  const audioBucket = env.AUDIO_BUCKET as SignedUrlBucket;
  let audioUrl: string | undefined;
  // 1) R2 内建签名（优先）
  if (typeof audioBucket.createSignedUrl === "function") {
    audioUrl = await audioBucket.createSignedUrl({ key, expiration: 60 * 60 });
  }
  // 2) R2 S3 预签名
  if (!audioUrl && (env as any).R2_S3_ACCOUNT_ID && (env as any).R2_S3_BUCKET && (env as any).R2_S3_ACCESS_KEY_ID && (env as any).R2_S3_SECRET_ACCESS_KEY) {
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
    } catch {
      // ignore and continue to next fallback
    }
  }
  // 3) 公共基址直链
  if (!audioUrl && (env as any).AUDIO_PUBLIC_BASE && /^https?:\/\//i.test((env as any).AUDIO_PUBLIC_BASE as string)) {
    const base = ((env as any).AUDIO_PUBLIC_BASE as string).replace(/\/$/, "");
    audioUrl = `${base}/${encodeURIComponent(key)}`;
  }
  // 4) 本服务代理
  if (!audioUrl) {
    const originOverride = (env as any).PUBLIC_ORIGIN as string | undefined;
    const origin = originOverride && /^https?:\/\//i.test(originOverride)
      ? originOverride.replace(/\/$/, "")
      : new URL(request.url).origin;
    audioUrl = `${origin}/api/audio/${encodeURIComponent(key)}`;
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

  const jobId = requestId;

  // Query loop per v3 API
  const queryUrl = `${env.ASR_BASE_URL.replace(/\/$/, "")}/${QUERY_ENDPOINT}`;
  let attempt = 0;
  const data = await pRetry(
    async () => {
      attempt += 1;
      const response = await fetch(queryUrl, {
        method: "POST",
        headers: buildV3Headers(env as unknown as CloudflareEnv, jobId),
        body: JSON.stringify({}),
      });

      if (!response.ok) {
        throw new AbortError(
          `ASR 查询失败: ${response.status} ${await response.text()}`
        );
      }

      const status = readStatusCode(response.headers);
      debugInfo.polls.push({
        attempt,
        httpStatus: response.status,
        apiStatus: status,
        apiMessage: response.headers.get("X-Api-Message") || response.headers.get("x-api-message"),
      });
      if (status === 20000000) {
        const result = (await response.json()) as V3QueryResponse;
        const utt = result.result?.utterances ?? [];
        if (utt.length > 0) {
          return utterancesToSrt(utt);
        }
        const text = result.result?.text || "";
        return [`1`, `${msToSrtTime(0)} --> ${msToSrtTime(2000)}`, text, ""].join("\n");
      }

      if (status === 20000001 || status === 20000002) {
        // processing / queued：取消响应体避免堆积
        try { await response.body?.cancel?.(); } catch {}
        throw new Error(`ASR 未完成: ${status}`);
      }

      const msg = response.headers.get("X-Api-Message") || response.headers.get("x-api-message") || "";
      const errBody = await response.text().catch(() => "");
      // 失败：也消费响应体
      try { await response.body?.cancel?.(); } catch {}
      throw new AbortError(`ASR 任务失败: ${status} ${msg} ${errBody ? `| ${errBody}` : ""}`);
    },
    {
      retries: 10,
      factor: 1.5,
      minTimeout: 2000,
      maxTimeout: 10000,
    }
  );

  return NextResponse.json({ srt: data, debug: debugInfo }, { status: 200 });
}

