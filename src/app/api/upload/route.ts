import { NextRequest, NextResponse } from "next/server";

const getEnv = ({ request }: { request: NextRequest }) => {
  const logs: string[] = [];
  
  // Check for bindings on the request object (standard for Cloudflare Pages)
  const cfEnv = (request as unknown as { env?: CloudflareEnv }).env;
  if (cfEnv) {
    logs.push("Found `env` on request object.");
    console.log("getEnv logs:", logs.join(" "));
    return cfEnv;
  }
  logs.push("`env` not found on request object.");

  // Check for bindings on the global scope (fallback, used by `wrangler dev`)
  const fallback = (globalThis as unknown as { __env__?: CloudflareEnv }).__env__;
  if (fallback) {
    logs.push("Found `__env__` on globalThis.");
    console.log("getEnv logs:", logs.join(" "));
    return fallback;
  }
  logs.push("`__env__` not found on globalThis.");
  
  const errorMessage = `Cloudflare 环境变量未注入. Log: ${logs.join(" ")}`;
  console.error(errorMessage);
  throw new Error(errorMessage);
};

const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024; // 2GB

export async function POST(request: NextRequest) {
  try {
    const env = getEnv({ request });

    // Check if the specific binding exists
    if (!env.AUDIO_BUCKET) {
      throw new Error("R2 binding 'AUDIO_BUCKET' not found in environment.");
    }

    const body = await request.formData();
    const file = body.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "缺少文件" }, { status: 400 });
    }

    if (file.size === 0) {
      return NextResponse.json({ error: "文件为空" }, { status: 400 });
    }

    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json({ error: "文件超出大小限制" }, { status: 413 });
    }

    const extension = file.name.split(".").pop() ?? "bin";
    const objectKey = `${crypto.randomUUID()}.${extension}`;

    const bodyStream = file.stream();

    await env.AUDIO_BUCKET.put(objectKey, bodyStream, {
      httpMetadata: { contentType: file.type ?? "application/octet-stream" },
    });

    return NextResponse.json({ key: objectKey }, { status: 200 });
  } catch (e) {
    const error = e as Error;
    console.error("Error in /api/upload:", error);
    return NextResponse.json(
      {
        error: "An unexpected error occurred.",
        errorMessage: error.message,
        errorStack: error.stack,
      },
      { status: 500 }
    );
  }
}