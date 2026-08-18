export interface SecretValueClient {
  getSecretValue(input: { SecretId: string }): Promise<{ SecretString?: string; SecretBinary?: Uint8Array | string }>;
}

export interface RuntimeSecretLoader {
  load(secretId: string): Promise<string>;
}

async function createDefaultSecretValueClient(): Promise<SecretValueClient> {
  const importer = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<{
    SecretsManagerClient: new () => { send(command: unknown): Promise<{ SecretString?: string; SecretBinary?: Uint8Array | string }> };
    GetSecretValueCommand: new (input: { SecretId: string }) => unknown;
  }>;
  const { SecretsManagerClient, GetSecretValueCommand } = await importer("@aws-sdk/client-secrets-manager");
  const client = new SecretsManagerClient();
  return {
    async getSecretValue(input: { SecretId: string }) {
      return client.send(new GetSecretValueCommand(input));
    },
  };
}

function decodeSecretBinary(value: Uint8Array | string): string {
  if (typeof value === "string") return Buffer.from(value, "base64").toString("utf8");
  return Buffer.from(value).toString("utf8");
}

export function createRuntimeSecretLoader(clientFactory: () => Promise<SecretValueClient> = createDefaultSecretValueClient): RuntimeSecretLoader {
  let clientPromise: Promise<SecretValueClient> | null = null;

  return {
    async load(secretId: string): Promise<string> {
      clientPromise ??= clientFactory();
      const client = await clientPromise;
      const response = await client.getSecretValue({ SecretId: secretId });
      if (typeof response.SecretString === "string" && response.SecretString.length > 0) return response.SecretString;
      if (response.SecretBinary !== undefined) return decodeSecretBinary(response.SecretBinary);
      throw new Error(`Secret ${secretId} has no SecretString or SecretBinary payload.`);
    },
  };
}

export async function loadLambdaRuntimeSecrets(
  env: NodeJS.ProcessEnv = process.env,
  loader: RuntimeSecretLoader = createRuntimeSecretLoader(),
): Promise<void> {
  if (!env.DATABASE_URL) {
    const databaseUrlSecretArn = env.DATABASE_URL_SECRET_ARN?.trim();
    if (!databaseUrlSecretArn) throw new Error("DATABASE_URL or DATABASE_URL_SECRET_ARN must be set in the Lambda environment.");
    env.DATABASE_URL = await loader.load(databaseUrlSecretArn);
  }

  if (!env.OPENAI_API_KEY) {
    const openAiApiKeySecretArn = env.OPENAI_API_KEY_SECRET_ARN?.trim();
    if (!openAiApiKeySecretArn) throw new Error("OPENAI_API_KEY or OPENAI_API_KEY_SECRET_ARN must be set in the Lambda environment.");
    env.OPENAI_API_KEY = await loader.load(openAiApiKeySecretArn);
  }
}
