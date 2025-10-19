import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const env = (request as any).env;
  const globalEnv = (globalThis as any).__env__;

  const report: { [key: string]: any } = {
    requestEnv: "Not found",
    globalThisEnv: "Not found",
    hasAudioBucketBinding: false,
    allBindings: null,
  };

  let finalEnv: any = null;

  if (env) {
    report.requestEnv = "Found";
    finalEnv = env;
  }

  if (globalEnv) {
    report.globalThisEnv = "Found";
    if (!finalEnv) {
      finalEnv = globalEnv;
    }
  }

  if (finalEnv) {
    report.hasAudioBucketBinding = finalEnv.hasOwnProperty("AUDIO_BUCKET");
    report.allBindings = Object.keys(finalEnv);
  }

  return NextResponse.json(report);
}
