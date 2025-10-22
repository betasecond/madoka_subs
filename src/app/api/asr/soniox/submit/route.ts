import { NextRequest, NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";

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

function toLanguageHints(lang?: string): string[] | undefined {
  if (!lang) return undefined;
  const base = lang.trim().toLowerCase().split(/[-_]/)[0];
  if (!base) return undefined;
  return [base];
}

export async function POST(request: NextRequest) {
  const { env } = getCloudflareContext();

  const body = (await request.json()) as { key?: string; language?: string };
  const { key, language } = body;
  if (!key) {
    return NextResponse.json({ error: "缺少音频标识" }, { status: 400 });
  }

  if (!env.SONIOX_API_KEY) {
    return NextResponse.json({ error: "缺少 Soniox 环境变量", detail: "需要 SONIOX_API_KEY" }, { status: 500 });
  }

  if (!(env as any).R2_S3_ACCOUNT_ID || !(env as any).R2_S3_BUCKET || !(env as any).R2_S3_ACCESS_KEY_ID || !(env as any).R2_S3_SECRET_ACCESS_KEY) {
    return NextResponse.json({ error: "缺少 R2 S3 凭证用于预签名" }, { status: 500 });
  }

  // 读取对象元信息
  const object = await env.AUDIO_BUCKET.get(key);
  if (!object || !object.body) {
    return NextResponse.json({ error: "音频对象不存在" }, { status: 404 });
  }

  // 生成 R2 S3 预签名 GET URL（供 Soniox 拉取）
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

  // 构造 Soniox Transcription 请求载荷
  const payload: any = {
    model: "stt-async-v3",
    audio_url: audioUrl,
    // 可选：仅作为 hint，不强制固定语言
    ...(toLanguageHints(language) ? { language_hints: toLanguageHints(language) } : {}),
    // 可选增强：根据需要可开启
    enable_language_identification: true,
    enable_speaker_diarization: true,
    // 透传我们推断的音频格式，便于后端更好处理（容错）
    // 不在 Soniox 文档中强制要求，留给服务器忽略
    _client_meta: { format: audioFormat },
  };

  // 提交到 Soniox
  const resp = await fetch("https://api.soniox.com/v1/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.SONIOX_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    return NextResponse.json({ error: "Soniox 提交失败", detail: text || String(resp.status) }, { status: 500 });
  }

  const data = (await resp.json()) as { id?: string };
  if (!data.id) {
    return NextResponse.json({ error: "Soniox 返回缺少 id" }, { status: 500 });
  }

  return NextResponse.json({ jobId: data.id }, { status: 200 });
}


