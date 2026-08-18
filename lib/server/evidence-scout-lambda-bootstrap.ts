import { loadLambdaRuntimeSecrets } from "./aws-secrets";

interface SqsRecord {
  messageId: string;
  body: string;
}

interface SqsEvent {
  Records: SqsRecord[];
}

interface SqsBatchResponse {
  batchItemFailures: Array<{ itemIdentifier: string }>;
}

export async function handler(event: SqsEvent): Promise<SqsBatchResponse> {
  await loadLambdaRuntimeSecrets();
  const lambdaHandler = await import("./evidence-scout-lambda-handler");
  return lambdaHandler.handler(event);
}
