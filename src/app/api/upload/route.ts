import { NextRequest, NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";

const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024; // 2GB

export async function POST(request: NextRequest) {
  try {
    const { env } = getCloudflareContext();

    if (!env.AUDIO_BUCKET) {
      // This check is almost redundant now but good for safety.
      throw new Error("R2 binding 'AUDIO_BUCKET' not found in Cloudflare context.");
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
        error: "An unexpected error occurred during upload.",
        errorMessage: error.message,
      },
      { status: 500 }
    );
  }
}
