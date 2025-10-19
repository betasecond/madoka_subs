import { NextRequest, NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";

export async function GET(request: NextRequest) {
  const report: { [key: string]: any } = {
    message: "This shows all environment keys (bindings, variables, and secrets) visible to the application.",
    contextFound: false,
    environmentKeys: [],
    errorMessage: null,
  };

  try {
    const context = getCloudflareContext();
    report.contextFound = true;
    
    if (context.env) {
      // Get all keys from the env object. This includes bindings, vars, and secrets.
      report.environmentKeys = Object.keys(context.env);
    }
  } catch (e) {
    const error = e as Error;
    report.errorMessage = error.message;
    report.message = "An error occurred while trying to get the Cloudflare context.";
  }

  return NextResponse.json(report);
}
