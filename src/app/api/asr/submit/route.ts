import { NextRequest, NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";

type SignedUrlBucket = CloudflareEnv["AUDIO_BUCKET"] & {
  createSignedUrl: (options: { key: string; expiration?: number }) => Promise<string>;
};

function resolveAudioFormat(keyName: string, contentType?: string): string {
  const ct = (contentType || "").toLowerCase();
  if (ct.includes("wav")) return "wav";
  if (ct.includes("mp3")) return "mp3";
  if (ct.includes("ogg")) return "ogg";
  const lowerKey = keyName.toLowerCase();
  if (lowerKey.endsWith(".wav")) return "wav";
  if (lowerKey.endsWith(".mp3")) return "mp3";
  if (lowerKey.endsWith(".ogg") || lowerKey.endsWith(".oga")) return "ogg";
  if (lowerKey.endsWith(".m4a") || lowerKey.endsWith(".mp4")) return "mp3";
  return "wav";
}

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

export async function POST(request: NextRequest) {
  const { env } = getCloudflareContext();

  const body = (await request.json()) as { key?: string; language?: string };
  const { key, language } = body;
  if (!key) {
    return NextResponse.json({ error: "缺少音频标识" }, { status: 400 });
  }

  if (!env.ASR_APP_ID || !env.ASR_ACCESS_TOKEN || !env.ASR_RESOURCE_ID) {
    return NextResponse.json({ error: "缺少 ASR 环境变量" }, { status: 500 });
  }
  if (!(env as any).R2_S3_ACCOUNT_ID || !(env as any).R2_S3_BUCKET || !(env as any).R2_S3_ACCESS_KEY_ID || !(env as any).R2_S3_SECRET_ACCESS_KEY) {
    return NextResponse.json({ error: "缺少 R2 S3 凭证用于预签名" }, { status: 500 });
  }

  // 读取对象元信息
  const object = await env.AUDIO_BUCKET.get(key);
  if (!object || !object.body) {
    return NextResponse.json({ error: "音频对象不存在" }, { status: 404 });
  }

  // 生成 R2 S3 预签名 GET URL
  let audioUrl: string;
  try {
    const { AwsClient } = await import("aws4fetch");
    const client = new AwsClient({
      accessKeyId: (env as any).R2_S3_ACCESS_KEY_ID as string,
      secretAccessKey: (env as any).R2_S3_SECRET_ACCESS_KEY as string,
      service: "s3",
      region: "auto",
    });
    const endpoint = `https://${(env as any).R2_S3_BUCKET}.${(env as any).R2_S3_ACCOUNT_ID}.r2.cloudflarestorage.com/${encodeURIComponent(key)}`;
    const url = new URL(endpoint);
    url.searchParams.set("X-Amz-Expires", String(3600));
    const signed = await client.sign(new Request(url, { method: "GET" }), { aws: { signQuery: true } });
    audioUrl = signed.url;
  } catch (e) {
    return NextResponse.json({ error: "生成 R2 预签名 URL 失败", detail: (e as Error).message }, { status: 500 });
  }

  const audioFormat = resolveAudioFormat(key, (object as any).httpMetadata?.contentType as string | undefined);

  // 提交 ASR 任务
  const requestId = (globalThis as any).crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  const submitUrl = `${env.ASR_BASE_URL.replace(/\/$/, "")}/submit`;
  const submitHeaders = buildV3Headers(env as unknown as CloudflareEnv, requestId);
  const submitPayload = {
    user: { uid: "web_client" },
    audio: { url: audioUrl, format: audioFormat, ...(language ? { language } : {}) },
    request: {
      model_name: "bigmodel",
      ...(env.ASR_MODEL_VERSION ? { model_version: env.ASR_MODEL_VERSION } : {}),
      enable_itn: true,
      enable_punc: true,
      show_utterances: true,
    },
  };

  const submitResp = await fetch(submitUrl, {
    method: "POST",
    headers: submitHeaders,
    body: JSON.stringify(submitPayload),
  });

  if (!submitResp.ok) {
    const text = await submitResp.text().catch(() => "");
    return NextResponse.json({ error: "ASR 提交失败", detail: text }, { status: submitResp.status });
  }

  const apiStatus = readStatusCode(submitResp.headers);
  // 读取并取消 body 避免 stalled
  try { await submitResp.body?.cancel?.(); } catch {}
  if (apiStatus !== 20000000) {
    return NextResponse.json(
      {
        error: "ASR 提交失败",
        detail: submitResp.headers.get("X-Api-Message") || submitResp.headers.get("x-api-message") || "",
        apiStatus,
      },
      { status: 400 }
    );
  }

  return NextResponse.json({ jobId: requestId }, { status: 200 });
}


