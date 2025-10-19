import { NextRequest, NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";

export async function GET(request: NextRequest) {
  const report: { [key: string]: any } = {
    contextFound: false,
    hasAudioBucketBinding: false,
    allBindings: null,
    errorMessage: null,
  };

  try {
    const context = getCloudflareContext();
    report.contextFound = true;
    
    if (context.env) {
      report.hasAudioBucketBinding = context.env.hasOwnProperty("AUDIO_BUCKET");
      report.allBindings = Object.keys(context.env);
    }
  } catch (e) {
    const error = e as Error;
    report.errorMessage = error.message;
  }

  return NextResponse.json(report);
}