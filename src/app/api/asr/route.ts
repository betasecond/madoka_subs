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
  let audioUrl: string;
  if (typeof audioBucket.createSignedUrl === "function") {
    audioUrl = await audioBucket.createSignedUrl({
      key,
      expiration: 60 * 60,
    });
  } else {
    const origin = new URL(request.url).origin;
    audioUrl = new URL(`/api/audio/${encodeURIComponent(key)}`, origin).toString();
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
    return "wav";
  };
  const audioFormat = inferAudioFormat(key, contentType);

  // Build headers and request id
  const requestId = (globalThis as any).crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
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
  if (submitStatus !== 20000000) {
    return NextResponse.json(
      {
        error: "ASR 提交失败",
        detail: {
          statusCode: submitStatus,
          message:
            submitResponse.headers.get("X-Api-Message") || submitResponse.headers.get("x-api-message"),
          body: await submitResponse.text(),
        },
      },
      { status: 400 }
    );
  }

  const jobId = requestId;

  // Query loop per v3 API
  const queryUrl = `${env.ASR_BASE_URL.replace(/\/$/, "")}/${QUERY_ENDPOINT}`;
  const data = await pRetry(
    async () => {
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
        // processing / queued
        throw new Error(`ASR 未完成: ${status}`);
      }

      throw new AbortError(
        `ASR 任务失败: ${status} ${
          response.headers.get("X-Api-Message") || response.headers.get("x-api-message") || ""
        }`
      );
    },
    {
      retries: 10,
      factor: 1.5,
      minTimeout: 2000,
      maxTimeout: 10000,
    }
  );

  return NextResponse.json({ srt: data }, { status: 200 });
}

