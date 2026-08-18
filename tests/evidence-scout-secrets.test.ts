import assert from "node:assert/strict";
import test from "node:test";

import { createRuntimeSecretLoader, loadLambdaRuntimeSecrets } from "../lib/server/aws-secrets";

test("runtime secret loader supports SecretString and SecretBinary payloads", async () => {
  const loader = createRuntimeSecretLoader(async () => ({
    async getSecretValue({ SecretId }) {
      if (SecretId === "string-secret") return { SecretString: "plain-text-secret" };
      return { SecretBinary: Buffer.from("binary-secret", "utf8").toString("base64") };
    },
  }));

  assert.equal(await loader.load("string-secret"), "plain-text-secret");
  assert.equal(await loader.load("binary-secret"), "binary-secret");
});

test("loadLambdaRuntimeSecrets populates DATABASE_URL and OPENAI_API_KEY from the configured ARNs without overwriting existing values", async () => {
  const requested: string[] = [];
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    DATABASE_URL_SECRET_ARN: "arn:aws:secretsmanager:db",
    OPENAI_API_KEY_SECRET_ARN: "arn:aws:secretsmanager:key",
  };

  await loadLambdaRuntimeSecrets(env, {
    load: async (secretId) => {
      requested.push(secretId);
      return secretId.endsWith(":db")
        ? "postgresql://user:pass@cluster.cockroachlabs.cloud:26257/defaultdb?sslmode=verify-full"
        : "sk-test-secret";
    },
  });

  assert.deepEqual(requested, ["arn:aws:secretsmanager:db", "arn:aws:secretsmanager:key"]);
  assert.match(env.DATABASE_URL ?? "", /^postgresql:\/\//);
  assert.equal(env.OPENAI_API_KEY, "sk-test-secret");

  env.DATABASE_URL = "already-present";
  env.OPENAI_API_KEY = "already-present";
  requested.length = 0;

  await loadLambdaRuntimeSecrets(env, {
    load: async (secretId) => {
      requested.push(secretId);
      return secretId;
    },
  });

  assert.deepEqual(requested, []);
  assert.equal(env.DATABASE_URL, "already-present");
  assert.equal(env.OPENAI_API_KEY, "already-present");
});
